-- 로컬 Postgres에서 전체 흐름을 검증하는 스크립트 (psql -v ON_ERROR_STOP=1 -f)
-- anon 역할로 전환해 브라우저와 같은 권한에서 함수를 부른다.
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
select init_app('1234') as code \gset
set role anon;

-- 테이블 직접 접근은 막혀 있어야 한다
do $$ begin
  begin perform * from students; raise exception 'FAIL: students 직접 읽기가 열려 있음';
  exception when insufficient_privilege then null; end;
  begin perform init_app('x'); raise exception 'FAIL: init_app이 anon에게 열려 있음';
  exception when insufficient_privilege then null; end;
end $$;

select (login('부총대', '1234')::json ->> 'token') as t \gset
select (login('학습부장', '1234')::json ->> 'token') as ot \gset
select login('정리부장', 'wrong')::json ->> 'error' as err \gset
select pg_temp.ok(:'err' = '비밀번호가 맞지 않아요', '틀린 비밀번호');

-- 명단 3명 + 현재 자봉
select roster_apply(:'t', '[{"op":"add","name":"가나다","no":1},{"op":"add","name":"라마바","no":2},{"op":"add","name":"사아자","no":3}]',
  '[{"name":"가나다","to":3},{"name":"사아자","to":-1}]', '2026-09-01');
set role postgres;
select id as s1 from students where name='가나다' \gset
select id as s2 from students where name='라마바' \gset
select id as s3 from students where name='사아자' \gset
set role anon;

-- 번호 맞바꾸기 (1↔2)
select roster_apply(:'t', format('[{"op":"renum","id":"%s","no":2},{"op":"renum","id":"%s","no":1}]', :'s1', :'s2')::jsonb, '[]', '2026-09-01');

-- 출석: 아침 지각 → 다시 저장하며 결석으로 정정
select ensure_period(:'t', '2026-09-25', '아침 출석', true) as p \gset
select save_attendance(:'t', :'p', format('{"%s":"late"}', :'s2')::jsonb) as n1 \gset
select save_attendance(:'t', :'p', format('{"%s":"absent","%s":"late"}', :'s2', :'s3')::jsonb) as n2 \gset
select pg_temp.ok(:n1 = 1 and :n2 = 2, '출석 저장 시 새 기록 수');

-- 공결 신청(로그인 없이) → 승인
set role postgres;
select id as le from ledger where student_id = :'s2' and item = '결석' and voided_at is null \gset
set role anon;
select create_excuse(:'s2', :'le', '', null) as x \gset
select review_excuse(:'t', :'x', true, null);

-- 총대단 요청 → 승인
select create_request(:'ot', '2026-09-25', array[:'s1', :'s3']::uuid[], '매점', '', -1, '', null) as r \gset
select review_request(:'t', :'r', true, null) as approved \gset

-- 직접 기록, 수정, 무효 처리
select add_entries(:'t', '2026-09-25', array[:'s1']::uuid[], '실습실 뒷정리 미흡', '전원 안끔', 2);
set role postgres;
select id as m from ledger where item = '실습실 뒷정리 미흡' \gset
set role anon;
select edit_entry(:'t', :'m', '2026-09-25', '실습실 뒷정리 미흡', '전원 안끔', 1, '점수 오기');

-- 총대단은 관리자 함수를 못 쓴다
select pg_temp.expect(format('select void_entry(%L, gen_random_uuid(), %L)', :'ot', 'x'), '42501', '총대단이 무효 처리함');

-- 공개 상태에는 이름과 기록자가 없어야 한다
select public_state()::text as pub \gset
select private_state(:'t')::text as priv \gset
select position('가나다' in :'pub') = 0
   and not exists (select 1 from json_array_elements(:'pub'::json -> 'ledger') e where e ->> 'by' is not null or e -> 'voided' ->> 'by' is not null)
   and json_array_length(:'pub'::json -> 'requests') = 0 as public_clean,
   position('가나다' in :'priv') > 0 and position('"by" : "학습부장"' in :'priv') > 0 as private_full \gset
select pg_temp.ok(:'public_clean'::boolean, '공개 상태에 이름·기록자가 없어야 함');
select pg_temp.ok(:'private_full'::boolean, '로그인 상태에는 이름·기록자가 있어야 함');

set role postgres;
select string_agg(format('%s번 %s', s.no, coalesce((select sum(points) from ledger l where l.student_id=s.id and voided_at is null),0)), ', ' order by s.no) as before from students s \gset
set role anon;
select purge(:'t', '2026-09-25')::text as pr \gset
set role postgres;
select string_agg(format('%s번 %s', s.no, coalesce((select sum(points) from ledger l where l.student_id=s.id and voided_at is null),0)), ', ' order by s.no) as after from students s \gset
select pg_temp.ok(:'before' = :'after', '정리 후에도 점수가 같아야 함');

-- 복구 코드로 비밀번호 재설정 → 새 코드 발급
set role anon;
select recover(:'code', '총대', 'abcd')::json ->> 'error' as notadmin \gset
select pg_temp.ok(:'notadmin' = '복구 코드로는 부총대 비밀번호만 새로 정할 수 있어요', '총대는 복구 대상 아님');
select recover(:'code', '부총대', '1234')::json ->> 'code' as newcode \gset
select (login('부총대', '1234')::json ->> 'token') is not null as recovered \gset
select recover(:'code', '부총대', 'zzzz')::json ->> 'error' as oldcode \gset
select pg_temp.ok(:'recovered'::boolean, '복구 코드로 비밀번호 재설정');
select pg_temp.ok(:'oldcode' = '복구 코드가 맞지 않아요', '쓴 복구 코드는 다시 못 씀');

-- 비밀번호를 5번 틀리면 잠긴다
select login('치아부장', 'x'), login('치아부장', 'x'), login('치아부장', 'x'), login('치아부장', 'x'), login('치아부장', 'x');
select login('치아부장', '1234')::json ->> 'error' as locked \gset
select pg_temp.ok(:'locked' like '%잠겼어요%', '5번 틀리면 잠김');

-- Realtime 알림용 테이블만 읽을 수 있다
select pg_temp.ok((select version > 0 from app_version), 'app_version 읽기');
\echo 모든 DB 흐름 테스트 통과

-- 사진 칸에 HTML을 넣으면 거절한다
set role anon;
set role postgres;
select pg_temp.expect($q$select _photo('data:image/png;base64,AAA" onerror="alert(1)')$q$, 'P0001', '이상한 사진 데이터가 통과함');
set role anon;
select pg_temp.expect($q$select _photo('data:image/jpeg;base64,/9j/4AAQSkZJRg==')$q$, '42501', '_photo가 anon에게 열려 있음');
\echo 사진 검증 통과

-- 직접 입력은 0.5점 단위까지 된다
set role anon;
select (login('부총대', '1234')::json ->> 'token') as t2 \gset
select add_entries(:'t2', '2026-09-26', array[:'s1']::uuid[], '실습', '', 0.5);
select pg_temp.expect(format('select add_entries(%L, %L, array[%L]::uuid[], %L, %L, 0.3)', :'t2', '2026-09-26', :'s1', '실습', ''), 'P0001', '0.3점이 통과함');
select roster_apply(:'t2', '[]', format('[{"name":"사아자","to":2.5}]')::jsonb, '2026-09-26');
set role postgres;
select pg_temp.ok((select sum(points) from ledger where student_id = :'s3' and voided_at is null) = 2.5, '명단 붙여넣기 자봉 2.5');
select pg_temp.ok((select json_agg(e) from json_array_elements(public_state() -> 'ledger') e where (e ->> 'points')::numeric = 0.5) is not null, '0.5점 공개 상태');
\echo 0.5점 테스트 통과

-- 공결 증빙 사진은 부총대·총대만 볼 수 있다
set role postgres;
insert into periods (date, label, saved_at) values ('2026-09-27', '아침 출석', now()) returning id as pp \gset
select _entry('2026-09-27', :'s1', '지각', '아침 출석', 1, 'att', :'pp', null, '부총대') as pe \gset
set role anon;
select create_excuse(:'s1', :'pe', '', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==') as px \gset
set role postgres;
select photo_id as ph from excuses where id = :'px' \gset
set role anon;
select (login('학습부장', '1234')::json ->> 'token') as ot2 \gset
select pg_temp.ok(get_photo(:'t2', :'ph') like 'data:image/jpeg%', '관리자는 공결 사진을 본다');
select pg_temp.expect(format('select get_photo(%L, %L)', :'ot2', :'ph'), '42501', '총대단이 공결 사진을 봄');
\echo 공결 사진 권한 테스트 통과

-- 부총대의 자주 쓰는 항목 저장 (지우고 다시 넣는다)
set role postgres;
select pg_temp.ok(not exists (select 1 from presets where owner is null), '공용 항목 없음');
set role anon;
select my_presets_save(:'t2', '[{"name":"매점","points":-1},{"name":"청소 불참","points":2}]');
set role postgres;
select pg_temp.ok((select string_agg(name, ',' order by name) from presets where owner = '부총대') = '매점,청소 불참', '항목 저장');
\echo 항목 저장 테스트 통과

-- 직접 기록한 결석도 공결 신청·승인할 수 있다
set role anon;
select add_entries(:'t2', '2026-09-27', array[:'s3']::uuid[], '결석', '', 2);
set role postgres;
select id as me from ledger where student_id = :'s3' and item = '결석' and src = 'manual' \gset
set role anon;
select create_excuse(:'s3', :'me', '병원', null) as mx \gset
select review_excuse(:'t2', :'mx', true, null);
set role postgres;
select pg_temp.ok((select voided_at is not null from ledger where id = :'me'), '직접 기록한 결석 공결 승인');
select pg_temp.ok(not exists (select 1 from ledger where item = '실습' and src = 'manual' and id in (select ledger_id from excuses)), '실습 기록은 공결 대상 아님');
\echo 직접 기록 공결 테스트 통과

-- 실습부장·총대는 출석을 요청하고, 부총대가 승인하면 반영된다. 직접 저장은 부총대만.
set role anon;
select (login('실습부장 1', '1234')::json ->> 'token') as pt \gset
select (login('총대', '1234')::json ->> 'token') as ct \gset
select ensure_period(:'pt', '2026-09-28', '아침 출석', true) as pp2 \gset
select request_attendance(:'pt', :'pp2', format('{"%s":"late"}', :'s1')::jsonb) as ar \gset
-- 같은 교시를 다시 보내면 대기 중인 요청이 바뀐다
select request_attendance(:'pt', :'pp2', format('{"%s":"late","%s":"absent"}', :'s1', :'s2')::jsonb) as ar2 \gset
select pg_temp.ok(:'ar' = :'ar2', '대기 중 요청은 덮어쓴다');
select request_attendance(:'ct', :'pp2', '{}') as cr \gset
select pg_temp.expect(format('select save_attendance(%L, %L, %L)', :'pt', :'pp2', '{}'), '42501', '실습부장이 출석을 바로 저장함');
select pg_temp.expect(format('select request_attendance(%L, %L, %L)', :'ot', :'pp2', '{}'), '42501', '학습부장이 출석 요청함');
select pg_temp.expect(format('select add_entries(%L, %L, array[%L]::uuid[], %L, %L, 1)', :'ct', '2026-09-28', :'s1', 'x', ''), '42501', '총대가 직접 기록함');
select review_attendance(:'t2', :'ar', true, null) as an \gset
select pg_temp.ok(:an = 2, '출석 요청 승인 → 기록 2건');
select review_attendance(:'t2', :'cr', false, '중복') is null as rj \gset
set role postgres;
select pg_temp.ok((select lp.requested_by = '실습부장 1' and lp.approved_by = '부총대' from ledger l join ledger_private lp on lp.ledger_id = l.id where l.period_id = :'pp2' and l.item = '결석'), '출석 기록에 요청자·승인자');
select pg_temp.ok((select string_agg(role, ',' order by sort) from accounts where can_attend) = '총대,실습부장 1,실습부장 2', '출석 요청 직책');
select pg_temp.ok((select string_agg(role, ',') from accounts where is_admin) = '부총대', '관리자는 부총대뿐');
\echo 출석 권한 테스트 통과

-- 총대단 "내 항목": 각자 따로, 공용 항목 저장이 지우지 않는다
set role anon;
select my_presets_save(:'ct', '[{"name":"실습 준비 미흡","points":1},{"name":"실습 도우미","points":-1}]');
select my_presets_save(:'pt', '[{"name":"기구 미반납","points":2}]');
select my_presets_save(:'t2', '[{"name":"매점","points":-1}]');
set role postgres;
select pg_temp.ok((select string_agg(name, ',' order by name) from presets where owner = '총대') = '실습 도우미,실습 준비 미흡', '총대 내 항목');
select pg_temp.ok((select count(*) from presets where owner = '실습부장 1') = 1, '실습부장 내 항목');
select pg_temp.ok((select string_agg(name, ',' order by name) from presets where owner = '부총대') = '매점', '부총대 항목은 따로');
set role anon;
select my_presets_save(:'ct', '[]');
set role postgres;
select pg_temp.ok(not exists (select 1 from presets where owner = '총대'), '내 항목 비우기');
\echo 내 항목 테스트 통과

-- 백업 → 데이터 망가뜨리기 → 되살리기 하면 원래대로 돌아온다
set role anon;
select backup_dump()::text as dump \gset
select pg_temp.ok((:'dump'::jsonb) ->> 'format' = 'jabong-backup', '로그인 없이 백업 받기');
set role postgres;
select md5(string_agg(s.no || ':' || s.name || ':' || coalesce((select sum(points) from ledger l where l.student_id = s.id and voided_at is null), 0), ',' order by s.no)) as before_sig,
  (select count(*) from ledger) as before_n, (select count(*) from ledger_revisions) as before_r from students s \gset
set role anon;
select roster_apply(:'t2', '[{"op":"add","name":"망가짐","no":99}]', '[{"name":"가나다","to":50}]', '2026-09-30');
select restore_backup(:'t2', :'dump'::jsonb)::text as rs \gset
set role postgres;
select md5(string_agg(s.no || ':' || s.name || ':' || coalesce((select sum(points) from ledger l where l.student_id = s.id and voided_at is null), 0), ',' order by s.no)) as after_sig,
  (select count(*) from ledger) as after_n, (select count(*) from ledger_revisions) as after_r from students s \gset
select pg_temp.ok(:'before_sig' = :'after_sig' and :before_n = :after_n and :before_r = :after_r, '되살리기 후 명단·점수·기록 수가 백업과 같음');
select pg_temp.ok(not exists (select 1 from students where name = '망가짐'), '백업 뒤에 생긴 학생은 사라짐');
select pg_temp.ok((login('부총대', '1234')::json ->> 'token') is not null, '되살려도 비밀번호는 그대로');
select pg_temp.ok(exists (select 1 from excuses where photo_id is not null), '서버에 남은 공결 사진은 다시 연결됨');
\echo 백업·되살리기 테스트 통과
