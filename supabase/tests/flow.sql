-- 로컬 Postgres에서 전체 흐름을 검증하는 스크립트 (psql -v ON_ERROR_STOP=1 -f)
-- anon 역할로 전환해 브라우저와 같은 권한에서 함수를 부른다.
\set QUIET on
\set ON_ERROR_STOP on
create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FAIL: %', msg; end if; end $$;
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
select login('총대', 'wrong')::json ->> 'error' as err \gset
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
do $$ begin
  begin perform void_entry((select token from sessions where role='학습부장' limit 1), gen_random_uuid(), 'x');
    raise exception 'FAIL: 총대단이 무효 처리함';
  exception when insufficient_privilege then null; end;
end $$;

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
select recover(:'code', '총대', 'abcd')::json ->> 'code' as newcode \gset
select (login('총대', 'abcd')::json ->> 'token') is not null as recovered \gset
select recover(:'code', '총대', 'zzzz')::json ->> 'error' as oldcode \gset
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
do $$ begin
  begin
    perform create_excuse((select student_id from excuses limit 1), gen_random_uuid(), '', 'data:image/png;base64,AAA" onerror="alert(1)');
    raise exception 'FAIL: 이상한 사진 데이터가 통과함';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  perform _photo('data:image/jpeg;base64,/9j/4AAQSkZJRg==');
  raise exception 'FAIL: _photo가 anon에게 열려 있음';
exception when insufficient_privilege then null;
end $$;
\echo 사진 검증 통과

-- 직접 입력은 0.5점 단위까지 된다
set role anon;
select (login('부총대', '1234')::json ->> 'token') as t2 \gset
select add_entries(:'t2', '2026-09-26', array[:'s1']::uuid[], '실습', '', 0.5);
do $$ begin
  perform add_entries((select token from sessions s join accounts a using (role) where a.is_admin limit 1), '2026-09-26', array[(select id from students limit 1)], '실습', '', 0.3);
  raise exception 'FAIL: 0.3점이 통과함';
exception when insufficient_privilege then null;
  when others then if sqlerrm like 'FAIL%' then raise; end if;
end $$;
select roster_apply(:'t2', '[]', format('[{"name":"사아자","to":2.5}]')::jsonb, '2026-09-26');
set role postgres;
select pg_temp.ok((select sum(points) from ledger where student_id = :'s3' and voided_at is null) = 2.5, '명단 붙여넣기 자봉 2.5');
select pg_temp.ok((select json_agg(e) from json_array_elements(public_state() -> 'ledger') e where (e ->> 'points')::numeric = 0.5) is not null, '0.5점 공개 상태');
\echo 0.5점 테스트 통과
