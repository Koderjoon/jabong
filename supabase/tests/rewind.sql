-- 되돌리기(작업 하나 / 이 작업 직전으로) 검증. 새 DB에 schema.sql을 실행한 뒤 돌린다.
\set QUIET on
\set ON_ERROR_STOP on
create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FAIL: %', msg; end if; end $$;
create or replace function pg_temp.expect(q text, state text, msg text) returns void language plpgsql as $$
declare st text;
begin
  begin execute q; exception when others then st := sqlstate; end;
  if st is distinct from state then raise exception 'FAIL: % (오류 코드 %, 기대 %)', msg, coalesce(st, '없음'), state; end if;
end $$;
-- 학생별 상태 요약 (비교용)
create or replace function pg_temp.sig() returns text language sql as $$
  select md5(_snap()::text || (select count(*) from ledger)::text || (select count(*) from attendance)::text || (select count(*) from excuses)::text)
$$;
create or replace function pg_temp.bal(n int) returns numeric language sql as $$
  select coalesce(sum(points), 0) from ledger l join students s on s.id = l.student_id where s.no = n and s.active and l.voided_at is null
$$;
select init_app('1234') \gset
set role anon;
select (login('부총대', '1234')::json ->> 'token') as t \gset
select roster_apply(:'t', '[{"op":"add","name":"가","no":1},{"op":"add","name":"나","no":2},{"op":"add","name":"다","no":3}]', '[{"name":"가","to":3}]', '2026-09-01');
set role postgres;
select id as s1 from students where name = '가' \gset
select id as s2 from students where name = '나' \gset
select id as s3 from students where name = '다' \gset
select pg_temp.sig() as sig0 \gset

set role anon;
-- A: 매점 -1 (가, 나)
select add_entries(:'t', '2026-09-02', array[:'s1', :'s2']::uuid[], '매점', '', -1);
set role postgres; select max(id) as opa from ops \gset
select pg_temp.sig() as sig_a \gset
set role anon;
-- B: 가·나 번호 맞바꾸기
select roster_apply(:'t', format('[{"op":"renum","id":"%s","no":2},{"op":"renum","id":"%s","no":1}]', :'s1', :'s2')::jsonb, '[]', '2026-09-02');
set role postgres; select max(id) as opb from ops \gset
select pg_temp.sig() as sig_b \gset
set role anon;
-- C: 아침 출석 (다 지각)
select ensure_period(:'t', '2026-09-03', '아침 출석', true) as p \gset
select save_attendance(:'t', :'p', format('{"%s":"late"}', :'s3')::jsonb);
set role postgres; select max(id) as opc from ops \gset
select pg_temp.bal(3) as bal3_c \gset
select pg_temp.ok(:bal3_c = 1, '출석 저장 → 다 +1');
set role anon;
-- D: 가의 매점 무효 처리
set role postgres; select id as le from ledger where student_id = :'s1' and item = '매점' \gset
set role anon;
select void_entry(:'t', :'le', '착오');
set role postgres; select max(id) as opd from ops \gset

-- 작업 목록과 요약
set role anon;
select ops_list(:'t', 10)::text as lst \gset
select pg_temp.ok(position('기록: 매점 -1 · 1 2번' in :'lst') > 0 and position('명단: 번호 변경 2' in :'lst') > 0
  and position('출석 저장: 9/3 아침 출석 (지각 1 · 결석 0 · 공결 0)' in :'lst') > 0 and position('무효 처리: 2번 매점 -1 (착오)' in :'lst') > 0, '작업 요약');

-- 1) 출석(C)만 되돌리기: 미리보기는 아무것도 바꾸지 않는다
select undo_ops(:'t', :opc, 'one', true)::text as pv \gset
set role postgres;
select pg_temp.ok(pg_temp.bal(3) = 1 and (select undone_by is null from ops where id = :opc), '미리보기는 바꾸지 않음');
select pg_temp.ok(position('"before" : 1' in :'pv') > 0 and position('"after" : 0' in :'pv') > 0, '미리보기에 점수 변화');
set role anon;
select undo_ops(:'t', :opc, 'one', false);
set role postgres;
select pg_temp.ok(pg_temp.bal(3) = 0 and not exists (select 1 from attendance) and (select undone_by is not null from ops where id = :opc), '출석만 되돌림');

-- 2) A만 되돌리기 → 뒤의 D가 같은 기록을 바꿨으니 충돌
set role anon;
select pg_temp.expect(format('select undo_ops(%L, %s, %L, false)', :'t', :opa, 'one'), 'P0002', 'A만 되돌리기는 충돌이어야 함');

-- 3) D(무효 처리) 되돌리고 나서 A 되돌리기 → 매점 기록이 모두 사라진다
select undo_ops(:'t', :opd, 'one', false);
select undo_ops(:'t', :opa, 'one', false);
set role postgres;
select pg_temp.ok(not exists (select 1 from ledger where item = '매점'), '매점 기록 되돌림');
select max(id) as opa_undo from ops \gset
-- 4) A 되돌리기를 다시 되돌리면 (다시 적용) 매점 기록이 돌아온다
set role anon;
select undo_ops(:'t', :opa_undo, 'one', false);
set role postgres;
select pg_temp.ok((select count(*) from ledger where item = '매점' and voided_at is null) = 2 and (select undone_by is null from ops where id = :opa), '되돌리기를 되돌리면 다시 적용');

-- 5) B 직전으로 되돌리기 → 번호 원래대로, 매점 2건만 남은 상태 (= A 직후)
set role anon;
set role postgres;
select string_agg(id || ':' || coalesce(undone_by::text, '-'), ',' order by id) as marks_before from ops \gset
set role anon;
select undo_ops(:'t', :opb, 'since', true)::text as pv2 \gset
select undo_ops(:'t', :opb, 'since', false)::text as rw \gset
set role postgres;
select pg_temp.ok((select no from students where id = :'s1') = 1 and (select no from students where id = :'s2') = 2, '번호 원래대로');
select pg_temp.ok(pg_temp.sig() = :'sig_a', 'B 직전(= A 직후) 상태와 같음');
select max(id) as oprw from ops \gset
-- 6) 시점 되돌리기를 되돌리면 모두 다시 적용된다. "되돌림" 표시도 되돌리기 전과 똑같아야 한다.
set role anon;
select undo_ops(:'t', :oprw, 'one', false);
set role postgres;
select string_agg(id || ':' || coalesce(undone_by::text, '-'), ',' order by id) as marks_after from ops where id < :oprw \gset
select pg_temp.ok(:'marks_before' = :'marks_after', '되돌림 표시 복원: ' || :'marks_before' || ' / ' || :'marks_after');
select sig_now from (select pg_temp.sig() as sig_now) z \gset
select pg_temp.ok((select no from students where id = :'s1') = 2 and (select count(*) from ledger where item = '매점' and voided_at is null) = 2, '시점 되돌리기를 되돌림');

-- 7) 맨 처음 작업 직전으로 되돌리면 빈 상태
set role anon;
set role postgres;
select min(id) as op0 from ops \gset
set role anon;
select undo_ops(:'t', :op0, 'since', false);
set role postgres;
select pg_temp.ok(not exists (select 1 from students) and not exists (select 1 from ledger) and not exists (select 1 from periods), '처음으로 되돌림');

-- 8) 되돌리다 다른 작업의 기록까지 지워지면 충돌: 결석 기록 → 공결 신청 → 결석 기록만 되돌리기
set role anon;
select roster_apply(:'t', '[{"op":"add","name":"라","no":4}]', '[]', '2026-09-05');
set role postgres; select id as s4 from students where name = '라' \gset
set role anon;
select add_entries(:'t', '2026-09-05', array[:'s4']::uuid[], '결석', '', 2);
set role postgres; select max(id) as ope from ops \gset
select id as le4 from ledger where student_id = :'s4' \gset
set role anon;
select create_excuse(:'s4', :'le4', '병원', null);
select pg_temp.expect(format('select undo_ops(%L, %s, %L, false)', :'t', :ope, 'one'), 'P0002', '공결 신청이 딸린 기록을 혼자 되돌림');
set role postgres;
select pg_temp.ok(exists (select 1 from excuses) and exists (select 1 from ledger where id = :'le4'), '충돌이면 아무것도 안 바뀜');

-- 9) 되돌릴 수 없는 작업: 정리 뒤에는 그 전으로 못 간다
set role anon;
select purge(:'t', '2026-09-30');
set role postgres;
select min(id) as opfirst from ops \gset
set role anon;
select pg_temp.expect(format('select undo_ops(%L, %s, %L, false)', :'t', :opfirst, 'since'), 'P0001', '정리를 되돌림');
-- 10) 총대단은 되돌리기를 못 한다
select (login('학습부장', '1234')::json ->> 'token') as ot \gset
select pg_temp.expect(format('select ops_list(%L, 10)', :'ot'), '42501', '총대단이 작업 내역을 봄');
\echo 되돌리기 테스트 통과
