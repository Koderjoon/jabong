-- 뒤로가기·앞으로 가기·특정 시점으로 이동 검증. 새 DB에 schema.sql을 실행한 뒤 돌린다.
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
-- 데이터 전체 요약 (같은 상태인지 비교용). 행 id와 내용까지 본다.
create or replace function pg_temp.sig() returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from students x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from ledger x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.ledger_id) from ledger_private x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from periods x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.period_id, x.student_id) from attendance x)))
$$;
create or replace function pg_temp.bal(n int) returns numeric language sql as $$
  select coalesce(sum(points), 0) from ledger l join students s on s.id = l.student_id where s.no = n and s.active and l.voided_at is null
$$;
select init_app('1234') \gset
set role anon;
select (login('부총대', '1234')::json ->> 'token') as t \gset
select (login('학습부장', '1234')::json ->> 'token') as ot \gset
set role postgres; select pg_temp.sig() as sig0 \gset
set role anon;
select roster_apply(:'t', '[{"op":"add","name":"가","no":1},{"op":"add","name":"나","no":2},{"op":"add","name":"다","no":3}]', '[{"name":"가","to":3}]', '2026-09-01');
set role postgres;
select id as s1 from students where name = '가' \gset
select id as s2 from students where name = '나' \gset
select id as s3 from students where name = '다' \gset
select max(id) as op1, pg_temp.sig() as sig1 from ops \gset
set role anon;
select add_entries(:'t', '2026-09-02', array[:'s1', :'s2']::uuid[], '매점', '', -1);
set role postgres; select max(id) as op2, pg_temp.sig() as sig2 from ops \gset
set role anon;
select roster_apply(:'t', format('[{"op":"renum","id":"%s","no":2},{"op":"renum","id":"%s","no":1}]', :'s1', :'s2')::jsonb, '[]', '2026-09-02');
set role postgres; select max(id) as op3, pg_temp.sig() as sig3 from ops \gset
set role anon;
select ensure_period(:'t', '2026-09-03', '아침 출석', true) as p \gset
select save_attendance(:'t', :'p', format('{"%s":"late"}', :'s3')::jsonb);
set role postgres; select max(id) as op5, pg_temp.sig() as sig5 from ops \gset
select id as le from ledger where student_id = :'s1' and item = '매점' \gset
set role anon;
select void_entry(:'t', :'le', '착오');
set role postgres; select max(id) as op6, pg_temp.sig() as sig6, count(*) as nops from ops \gset
select pg_temp.ok(:nops = 6, '작업 6개');

set role anon;
select ops_list(:'t', 10)::text as lst \gset
select pg_temp.ok(position('기록: 매점 -1 · 1 2번' in :'lst') > 0 and position('명단: 번호 변경 2' in :'lst') > 0
  and position('출석 저장: 9/3 아침 출석 (지각 1 · 결석 0 · 공결 0)' in :'lst') > 0 and position('무효 처리: 2번 매점 -1 (착오)' in :'lst') > 0, '작업 요약');

-- 1) 뒤로가기 미리보기는 아무것도 바꾸지 않는다
select history_move(:'t', :op5, true)::text as pv \gset
set role postgres;
select pg_temp.ok(pg_temp.sig() = :'sig6' and not exists (select 1 from ops where undone), '미리보기는 바꾸지 않음');
select pg_temp.ok(position('무효 처리' in :'pv') > 0, '미리보기에 되돌릴 작업');
-- 2) 뒤로가기 두 번
set role anon;
select history_move(:'t', :op5, false);
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig5', '뒤로 1 = 무효 처리 직전');
set role anon;
select history_move(:'t', :op3, false);
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig3', '뒤로 2 = 출석 직전');
select pg_temp.ok((select count(*) from ops) = 6, '이동해도 작업 목록은 그대로 (기록 안 남음)');
-- 3) 앞으로 가기
set role anon;
select history_move(:'t', :op5, false);
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig5', '앞으로 1');
-- 4) 특정 시점으로: 매점 기록 직후 → 맨 끝 → 맨 처음 → 맨 끝
set role anon;
select history_move(:'t', :op2, false);
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig2' and (select no from students where id = :'s1') = 1, '매점 기록 직후로');
set role anon;
select history_move(:'t', :op6, false);
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig6', '맨 끝으로');
set role anon;
select history_move(:'t', 0, false);
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig0' and not exists (select 1 from students), '맨 처음으로');
set role anon;
select history_move(:'t', :op6, false);
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig6', '다시 맨 끝으로');
select pg_temp.ok((select count(*) from ops) = 6 and not exists (select 1 from op_changes c join ops o on o.id = c.op_id where o.kind = 'scratch'), '이동 흔적 없음');
set role anon;
select pg_temp.expect(format('select history_move(%L, %s, false)', :'t', :op6), 'P0001', '같은 시점으로는 이동 안 됨');

-- 5) 뒤로 간 상태에서 새 작업을 하면 앞으로 갈 작업은 사라진다
select history_move(:'t', :op3, false);
select add_entries(:'t', '2026-09-04', array[:'s3']::uuid[], '실습', '', 1);
set role postgres;
select pg_temp.ok((select count(*) from ops) = 4 and not exists (select 1 from ops where undone), '앞으로 갈 작업 버림');
select max(id) as op7 from ops \gset

-- 6) 작업 밖에서 바뀐 기록이 있으면 멈추고 아무것도 바꾸지 않는다
update ledger set points = 5 where item = '실습';
select pg_temp.sig() as sig_out \gset
set role anon;
select pg_temp.expect(format('select history_move(%L, %s, false)', :'t', :op3), 'P0002', '작업 밖 변경이면 멈춤');
set role postgres;
select pg_temp.ok(pg_temp.sig() = :'sig_out', '멈추면 그대로');
update ledger set points = 1 where item = '실습';

-- 7) 이 작업만 되돌리기 → 다시 살리기. 새 작업 기록은 생기지 않고 다른 작업의 위치도 그대로다.
-- 지금: op1 · op2 · op3 적용, op7(실습) 적용
select pg_temp.sig() as sig_a \gset
select count(*) as nops_a from ops \gset
set role anon;
select history_drop(:'t', :op2, true)::text as dpv \gset
set role postgres;
select pg_temp.ok(pg_temp.sig() = :'sig_a' and not exists (select 1 from ops where dropped), '이 작업만 되돌리기 미리보기는 바꾸지 않음');
select pg_temp.ok(position('매점' in :'dpv') > 0, '미리보기에 되돌릴 작업');
set role anon;
select history_drop(:'t', :op2, false);
set role postgres;
select pg_temp.ok(not exists (select 1 from ledger where item = '매점') and (select no from students where id = :'s1') = 2
  and exists (select 1 from ledger where item = '실습'), '매점 기록만 사라지고 나머지는 그대로');
select pg_temp.ok((select count(*) from ops) = :nops_a and (select dropped and not undone from ops where id = :op2), '작업은 빼 둠으로 남고 새 기록 없음');
select pg_temp.sig() as sig_d \gset
set role anon;
select pg_temp.expect(format('select history_drop(%L, %s, false)', :'t', :op2), 'P0001', '이미 빼 둔 작업');
-- 뒤로·앞으로 오가도 빼 둔 작업은 적용되지 않는다
select history_move(:'t', :op1, false);
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig1', '빼 둔 작업을 건너 뒤로 (명단만)');
set role anon;
select history_move(:'t', :op7, false);
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig_d', '빼 둔 채로 다시 맨 끝');
-- 다시 살리기
set role anon;
select history_restore(:'t', :op2, true)::text as rpv \gset
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig_d' and position('매점' in :'rpv') > 0, '다시 살리기 미리보기');
set role anon;
select history_restore(:'t', :op2, false);
set role postgres;
select pg_temp.ok(pg_temp.sig() = :'sig_a' and not exists (select 1 from ops where dropped) and (select count(*) from ops) = :nops_a, '다시 살리면 원래대로, 기록 없음');
set role anon;
select pg_temp.expect(format('select history_restore(%L, %s, false)', :'t', :op2), 'P0001', '빼 두지 않은 작업은 살리기 안 됨');
-- 뒤로 가 있는 동안 빼 둔 작업을 살리면 표시만 풀리고, 앞으로 갈 때 적용된다
select history_drop(:'t', :op2, false);
select history_move(:'t', :op1, false);
select history_restore(:'t', :op2, false);
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig1' and (select undone and not dropped from ops where id = :op2), '뒤에서 살리면 데이터는 그대로');
set role anon;
select history_move(:'t', :op7, false);
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig_a', '앞으로 가면 함께 적용');
-- 뒤의 작업(번호 변경)이 같은 학생을 바꿨으면 멈춘다
set role anon;
select pg_temp.expect(format('select history_drop(%L, %s, false)', :'t', :op1), 'P0002', '뒤 작업과 겹치면 멈춤');
set role postgres; select pg_temp.ok(pg_temp.sig() = :'sig_a', '멈추면 그대로 (이 작업만)');
-- 빼 둔 작업 뒤에 같은 기록을 바꾸는 새 작업을 하면 살리기가 멈춘다
set role anon;
select history_drop(:'t', :op7, false);
select add_entries(:'t', '2026-09-05', array[:'s3']::uuid[], '청소', '', 1);
set role postgres; select pg_temp.ok((select dropped from ops where id = :op7), '빼 둔 작업은 새 작업 뒤에도 남음');
set role anon;
select history_restore(:'t', :op7, false);
set role postgres; select pg_temp.ok(exists (select 1 from ledger where item = '실습') and exists (select 1 from ledger where item = '청소'), '겹치지 않으면 새 작업 뒤에도 살아남');

-- 8) 총대단은 이동·목록 불가
set role anon;
select pg_temp.expect(format('select ops_list(%L, 10)', :'ot'), '42501', '총대단이 작업 내역을 봄');
select pg_temp.expect(format('select history_move(%L, 0, false)', :'ot'), '42501', '총대단이 이동함');
select pg_temp.expect(format('select history_drop(%L, %s, false)', :'ot', :op3), '42501', '총대단이 이 작업만 되돌림');
select pg_temp.expect(format('select history_restore(%L, %s, false)', :'ot', :op3), '42501', '총대단이 다시 살림');

-- 9) 보관 후 정리 너머로는 못 간다
select purge(:'t', '2026-09-30');
set role postgres; select min(id) as opp from ops \gset
set role anon;
select pg_temp.expect(format('select history_move(%L, 0, false)', :'t'), 'P0001', '정리 너머로 이동');
select pg_temp.expect(format('select history_drop(%L, %s, false)', :'t', :opp), 'P0001', '정리는 되돌리기 안 됨');
\echo 뒤로가기·앞으로 가기 테스트 통과
