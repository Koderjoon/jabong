-- 모든 서버 함수 검증: 노출·권한, 입력 검증, 동작, 경계. 새 DB에 schema.sql을 실행한 뒤 돌린다.
-- 브라우저와 같은 조건이 되도록 함수는 anon 역할로 부르고, 결과 확인만 postgres로 한다.
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
-- 오류 메시지까지 확인한다 (화면은 서버 메시지를 그대로 보여 주므로 한국어여야 한다)
create or replace function pg_temp.expect_msg(q text, pattern text, msg text) returns void language plpgsql as $$
declare m text;
begin
  begin execute q; exception when others then m := sqlerrm; end;
  if m is null or m not like pattern then raise exception 'FAIL: % (메시지 %, 기대 %)', msg, coalesce(m, '오류 없음'), pattern; end if;
end $$;
create or replace function pg_temp.nops() returns bigint language sql as $$ select count(*) from ops $$;
create or replace function pg_temp.bal(p_sid uuid) returns numeric language sql as $$
  select coalesce(sum(points), 0)::numeric(7,1) from ledger where student_id = p_sid and voided_at is null
$$;

-- ───────── 0. 처음 설정 ─────────
select init_app('1234') as code \gset
select pg_temp.ok(:'code' ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$', '복구 코드 형식 (헷갈리는 글자 I O 0 1 없음)');
select pg_temp.expect_msg($q$select init_app('abcd')$q$, '이미 설정했어요%', 'init_app은 한 번만');
select pg_temp.ok((select count(*) from accounts where pw_hash is not null) = 9, '9개 직책 모두 비밀번호');
select pg_temp.ok((select count(*) from presets where owner = '부총대') = 6 and not exists (select 1 from presets where owner is null), '기본 항목은 부총대 것');

-- ───────── 1. 노출과 권한 ─────────
select pg_temp.ok(
  (select array_agg(p.proname::text order by p.proname::text) from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute'))
  = (select array_agg(x order by x) from unnest(array['public_state', 'create_excuse', 'login', 'recover', 'private_state', 'logout', 'get_photo',
      'create_request', 'change_pw', 'reset_pw', 'new_recovery', 'ensure_period', 'save_attendance', 'request_attendance', 'review_attendance',
      'add_entries', 'edit_entry', 'void_entry', 'review_request', 'review_excuse', 'roster_apply', 'my_presets_save', 'purge', 'backup_dump',
      'restore_backup', 'history_move', 'history_drop', 'history_restore', 'ops_list']) x),
  '브라우저(anon)에 열린 함수가 정확히 화면이 쓰는 29개');
select pg_temp.ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
  and has_function_privilege('anon', p.oid, 'execute') <> has_function_privilege('authenticated', p.oid, 'execute')), 'anon과 authenticated 권한이 같음');
select pg_temp.ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname !~ '^_'
  and p.proname <> 'init_app' and not has_function_privilege('anon', p.oid, 'execute')), '_로 시작하지 않는 함수는 모두 grant 목록에 있음');
select pg_temp.ok(not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
  and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')), 'security definer 함수는 search_path 고정');
select pg_temp.ok(not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity), '모든 표에 RLS');
select pg_temp.ok(not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v') and c.relname <> 'app_version'
  and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))),
  '표 직접 읽기·쓰기 금지');
select pg_temp.ok(has_table_privilege('anon', 'app_version', 'select') and not has_table_privilege('anon', 'app_version', 'update')
  and not has_table_privilege('anon', 'app_version', 'insert'), 'app_version은 읽기만');

set role anon;
select (login('부총대', '1234')::json ->> 'token') as t \gset
select (login('총대', '1234')::json ->> 'token') as ct \gset
select (login('실습부장 2', '1234')::json ->> 'token') as pt \gset
select (login('학습부장', '1234')::json ->> 'token') as ot \gset
select pg_temp.ok((login('부총대', '1234')::json ->> 'admin')::boolean and not (login('총대', '1234')::json ->> 'admin')::boolean, '로그인 결과의 admin');
set role postgres;
insert into sessions (role, expires_at) values ('부총대', now() - interval '1 minute') returning token as xt \gset
select set_config('tt.plain', :'ot', false), set_config('tt.attend1', :'ct', false), set_config('tt.attend2', :'pt', false), set_config('tt.expired', :'xt', false);

set role anon;
do $$
declare
  admin_only text[] := array[
    'select reset_pw(%s, ''총무'', ''abcd'')', 'select new_recovery(%s, ''1234'')',
    'select save_attendance(%s, gen_random_uuid(), ''{}'')', 'select review_attendance(%s, gen_random_uuid(), true, null)',
    'select add_entries(%s, current_date, array[gen_random_uuid()], ''x'', '''', 1)', 'select edit_entry(%s, gen_random_uuid(), current_date, ''x'', '''', 1, ''r'')',
    'select void_entry(%s, gen_random_uuid(), ''r'')', 'select review_request(%s, gen_random_uuid(), true, null)',
    'select review_excuse(%s, gen_random_uuid(), true, null)', 'select roster_apply(%s, ''[]'', ''[]'', current_date)',
    'select purge(%s, current_date)', 'select restore_backup(%s, ''{}'')', 'select history_move(%s, 0, true)',
    'select history_drop(%s, 1, true)', 'select history_restore(%s, 1, true)', 'select ops_list(%s, 10)'];
  any_login text[] := array[
    'select private_state(%s)', 'select get_photo(%s, gen_random_uuid())',
    'select create_request(%s, current_date, array[gen_random_uuid()], ''x'', '''', 1, '''', null)',
    'select change_pw(%s, ''x'', ''abcd'')', 'select my_presets_save(%s, ''[]'')'];
  attend text[] := array['select ensure_period(%s, current_date, ''x'', false)', 'select request_attendance(%s, gen_random_uuid(), ''{}'')'];
  q text; tok text; want text; st text; n int := 0;
begin
  foreach q in array admin_only || any_login || attend loop
    foreach tok in array array[gen_random_uuid()::text, current_setting('tt.expired'), current_setting('tt.plain'), current_setting('tt.attend1'), current_setting('tt.attend2')] loop
      want := case
        when tok not in (current_setting('tt.plain'), current_setting('tt.attend1'), current_setting('tt.attend2')) then '28000'
        when q = any (admin_only) then '42501'
        when q = any (attend) and tok = current_setting('tt.plain') then '42501'
        else 'skip' end;
      continue when want = 'skip';
      st := null;
      begin execute format(q, quote_literal(tok)); exception when others then st := sqlstate; end;
      if st is distinct from want then raise exception 'FAIL: 권한 % (토큰 종류 %): 오류 코드 %, 기대 %', q, want, coalesce(st, '없음'), want; end if;
      n := n + 1;
    end loop;
  end loop;
  if n <> 16 * 5 + 5 * 2 + 2 * 3 then raise exception 'FAIL: 권한 검사 수 %', n; end if;
end $$;
-- 로그인 없이 부를 수 있는 함수
select pg_temp.ok(public_state() is not null and backup_dump() is not null, '공개 함수');
select pg_temp.expect('select create_excuse(gen_random_uuid(), gen_random_uuid(), '''', null)', 'P0001', '공결 신청은 로그인 없이 부를 수 있음 (검증 오류만)');
select pg_temp.expect(format('select logout(%L)', gen_random_uuid()), null, '없는 토큰 로그아웃은 조용히 끝남');
\echo 1. 노출·권한 통과

-- ───────── 2. 로그인·세션 ─────────
select pg_temp.ok(login('없는직책', '1234')::json ->> 'error' = '직책을 확인하세요', '없는 직책');
select pg_temp.ok(login('정리부장', null)::json ->> 'error' = '비밀번호가 맞지 않아요', '빈 비밀번호');
select login('정리부장', 'x'), login('정리부장', 'x'), login('정리부장', 'x');
select pg_temp.ok(login('정리부장', '1234')::json ->> 'token' is not null, '4번 틀린 뒤 맞으면 들어감');
select login('정리부장', 'x'), login('정리부장', 'x'), login('정리부장', 'x'), login('정리부장', 'x');
select pg_temp.ok(login('정리부장', '1234')::json ->> 'token' is not null, '성공하면 틀린 횟수가 초기화됨');
select login('정리부장', 'x'), login('정리부장', 'x'), login('정리부장', 'x'), login('정리부장', 'x'), login('정리부장', 'x');
select pg_temp.ok(login('정리부장', '1234')::json ->> 'error' like '%잠겼어요. 10분 뒤%', '5번 틀리면 맞는 비밀번호도 10분 잠김');
select pg_temp.ok(login('치아부장', '1234')::json ->> 'token' is not null, '잠김은 그 직책만');
set role postgres; update accounts set locked_until = now() - interval '1 second' where role = '정리부장';
set role anon;
select pg_temp.ok(login('정리부장', '1234')::json ->> 'token' is not null, '잠김이 풀리면 들어감');
select pg_temp.expect(format('select private_state(%L)', :'xt'), '28000', '만료된 로그인');
set role postgres; select pg_temp.ok(not exists (select 1 from sessions where token = :'xt'), '로그인할 때 만료된 로그인을 지움');
set role anon;
select (login('운영부장', '1234')::json ->> 'token') as lt \gset
select pg_temp.ok(private_state(:'lt') is not null, '로그인 상태 읽기');
select logout(:'lt');
select pg_temp.expect(format('select private_state(%L)', :'lt'), '28000', '로그아웃하면 토큰이 끊김');
set role postgres; select pg_temp.ok((select expires_at > now() + interval '29 days' from sessions where token = :'t'), '로그인은 30일 유지');
\echo 2. 로그인·세션 통과

-- ───────── 3. 비밀번호·복구 코드 ─────────
set role anon;
select pg_temp.expect_msg(format('select change_pw(%L, %L, %L)', :'ot', 'wrong', 'abcd'), '현재 비밀번호가 맞지 않아요', '현재 비밀번호 틀림');
select pg_temp.expect_msg(format('select change_pw(%L, %L, %L)', :'ot', '1234', 'ab'), '새 비밀번호는 4자 이상%', '새 비밀번호 짧음');
select change_pw(:'ot', '1234', '5678');
select pg_temp.ok(login('학습부장', '1234')::json ->> 'error' is not null and login('학습부장', '5678')::json ->> 'token' is not null, '총대단이 자기 비밀번호를 바꿈');
select pg_temp.ok(private_state(:'ot') is not null, '비밀번호를 바꿔도 지금 로그인은 유지');
select pg_temp.expect_msg(format('select reset_pw(%L, %L, %L)', :'t', '학습부장', 'ab'), '새 비밀번호는 4자 이상%', '재설정 비밀번호 짧음');
select pg_temp.expect_msg(format('select reset_pw(%L, %L, %L)', :'t', '없는직책', 'abcd'), '없는 직책이에요', '없는 직책 재설정');
select reset_pw(:'t', '학습부장', '1234');
select pg_temp.expect(format('select private_state(%L)', :'ot'), '28000', '재설정하면 그 직책은 로그아웃');
select pg_temp.ok(login('학습부장', '5678')::json ->> 'error' is not null, '재설정 전 비밀번호는 안 됨');
select (login('학습부장', '1234')::json ->> 'token') as ot \gset
select set_config('tt.plain', :'ot', false);
select login('치아부장', 'x'), login('치아부장', 'x'), login('치아부장', 'x'), login('치아부장', 'x'), login('치아부장', 'x');
select reset_pw(:'t', '치아부장', 'abcd');
select pg_temp.ok(login('치아부장', 'abcd')::json ->> 'token' is not null, '재설정하면 잠김도 풀림');
select pg_temp.expect_msg(format('select new_recovery(%L, %L)', :'t', 'wrong'), '내 비밀번호가 맞지 않아요', '새 복구 코드는 비밀번호 확인');
select new_recovery(:'t', '1234') as code2 \gset
select pg_temp.ok(:'code2' <> :'code' and recover(:'code', '부총대', 'abcd')::json ->> 'error' = '복구 코드가 맞지 않아요', '새 코드를 만들면 이전 코드는 안 됨');
select recover(lower(replace(:'code2', '-', '')), '부총대', '1234')::json as rc \gset
select pg_temp.ok((:'rc'::json ->> 'token') is not null and (:'rc'::json ->> 'admin')::boolean, '복구 코드는 소문자·붙여 써도 됨');
select (:'rc'::json ->> 'code') as code3 \gset
select pg_temp.ok(recover(:'code2', '부총대', 'abcd')::json ->> 'error' = '복구 코드가 맞지 않아요', '쓴 복구 코드는 다시 못 씀');
select pg_temp.ok(recover(:'code3', '총대', 'abcd')::json ->> 'error' like '%부총대 비밀번호만%', '총대단은 복구 대상 아님');
select pg_temp.ok(recover(:'code3', '부총대', 'ab')::json ->> 'error' like '%4자 이상%', '복구할 때도 4자 이상');
select recover('AAAA-AAAA-AAAA', '부총대', 'abcd'), recover('AAAA-AAAA-AAAA', '부총대', 'abcd'), recover('AAAA-AAAA-AAAA', '부총대', 'abcd'),
  recover('AAAA-AAAA-AAAA', '부총대', 'abcd'), recover('AAAA-AAAA-AAAA', '부총대', 'abcd');
select pg_temp.ok(recover(:'code3', '부총대', '1234')::json ->> 'error' like '%여러 번 틀렸어요%', '복구 코드 5번 틀리면 잠김');
set role postgres; update settings set recovery_locked_until = now() - interval '1 second' where id = 1;
set role anon;
select pg_temp.ok(recover(:'code3', '부총대', '1234')::json ->> 'token' is not null, '잠김이 풀리면 복구됨');
select pg_temp.ok(private_state(:'t') is not null, '복구해도 다른 기기의 부총대 로그인은 유지');
\echo 3. 비밀번호·복구 코드 통과

-- ───────── 4. 명단 ─────────
select roster_apply(:'t', '[{"op":"add","name":"가","no":1},{"op":"add","name":"나","no":2},{"op":"add","name":"다","no":3},{"op":"add","name":"라","no":4},{"op":"add","name":"마","no":5}]',
  '[{"name":"가","to":3},{"name":"나","to":-1.5}]', '2026-03-02') as n \gset
select pg_temp.ok(:n = 7, '명단 붙여넣기 반환값 = 작업 수');
set role postgres;
select id as s1 from students where name = '가' \gset
select id as s2 from students where name = '나' \gset
select id as s3 from students where name = '다' \gset
select id as s4 from students where name = '라' \gset
select id as s5 from students where name = '마' \gset
select pg_temp.ok((select summary from ops order by id desc limit 1) = '명단: 추가 5 · 자봉 조정 2', '명단 작업 요약');
select pg_temp.ok((select item = '기존 누적' and points = 3 and src = 'import' and detail = '' and date = '2026-03-02' from ledger where student_id = :'s1'), '처음 자봉은 기존 누적');
select pg_temp.ok(pg_temp.bal(:'s2') = -1.5, '기존 누적 -1.5');
set role anon;
select roster_apply(:'t', '[]', '[{"name":"가","to":5}]', '2026-03-02');
select roster_apply(:'t', '[]', '[{"name":"가","to":5}]', '2026-03-02');
set role postgres;
select pg_temp.ok((select count(*) from ledger where student_id = :'s1') = 2 and pg_temp.bal(:'s1') = 5
  and exists (select 1 from ledger where student_id = :'s1' and item = '자봉 조정' and points = 2 and detail = '명단 붙여넣기'), '자봉 조정은 차이만, 같으면 기록 없음');
set role anon;
select pg_temp.expect_msg(format('select roster_apply(%L, %L, %L, %L)', :'t', '[]', '[{"name":"없음","to":1}]', '2026-03-02'), '학생을 찾을 수 없어요: 없음', '없는 이름 조정');
select pg_temp.expect_msg(format('select roster_apply(%L, %L, %L, %L)', :'t', '[]', '[{"name":"가","to":1.3}]', '2026-03-02'), '자봉 점수는 0.5점 단위%', '0.5점 단위가 아닌 조정');
select pg_temp.expect_msg(format('select roster_apply(%L, %L, %L, %L)', :'t', '[{"op":"add","name":"겹침","no":1}]', '[]', '2026-03-02'), '번호가 겹치는 학생이 있어요%', '번호 겹침');
select pg_temp.expect_msg(format('select roster_apply(%L, %L, %L, %L)', :'t', '[{"op":"zap"}]', '[]', '2026-03-02'), '알 수 없는 명단 작업이에요', '모르는 명단 작업');
select roster_apply(:'t', format('[{"op":"renum","id":"%s","no":2},{"op":"renum","id":"%s","no":1},{"op":"rename","id":"%s","name":"다다"}]', :'s1', :'s2', :'s3')::jsonb, '[]', '2026-03-02');
set role postgres;
select pg_temp.ok((select no from students where id = :'s1') = 2 and (select no from students where id = :'s2') = 1 and (select name from students where id = :'s3') = '다다', '번호 맞바꾸기·이름 바꾸기');
select pg_temp.ok((select summary from ops order by id desc limit 1) = '명단: 번호 변경 2 · 이름 1', '번호·이름 작업 요약');
set role anon;
select roster_apply(:'t', format('[{"op":"remove","id":"%s"}]', :'s4')::jsonb, '[]', '2026-03-02');
select roster_apply(:'t', '[{"op":"add","name":"바","no":4}]', '[]', '2026-03-02');
select pg_temp.expect_msg(format('select roster_apply(%L, %L, %L, %L)', :'t', format('[{"op":"restore","id":"%s","no":4}]', :'s4'), '[]', '2026-03-02'), '번호가 겹치는%', '다른 학생이 쓰는 번호로 복귀');
select roster_apply(:'t', format('[{"op":"restore","id":"%s","no":6}]', :'s4')::jsonb, '[]', '2026-03-02');
select roster_apply(:'t', format('[{"op":"remove","id":"%s"}]', :'s5')::jsonb, '[]', '2026-03-02');
select pg_temp.expect_msg(format('select roster_apply(%L, %L, %L, %L)', :'t', '[]', '[{"name":"마","to":1}]', '2026-03-02'), '학생을 찾을 수 없어요: 마', '제외된 학생은 조정 안 됨');
select roster_apply(:'t', format('[{"op":"restore","id":"%s","no":5}]', :'s5')::jsonb, '[{"name":"마","to":1}]', '2026-03-02');
select roster_apply(:'t', '[{"op":"add","name":"아","no":8}]', '[]', '2026-03-02');
set role postgres;
select id as s6 from students where name = '바' \gset
select id as s8 from students where name = '아' \gset
select pg_temp.ok((select active and no = 6 from students where id = :'s4') and (select active and no = 5 from students where id = :'s5') and pg_temp.bal(:'s5') = 1, '제외·복귀·복귀하며 조정');
set role anon;
select roster_apply(:'t', format('[{"op":"remove","id":"%s"}]', :'s8')::jsonb, '[]', '2026-03-02');
select pg_temp.ok((select count(*) from json_array_elements(public_state() -> 'students') s where (s ->> 'active')::boolean) = 6, '재학 6명 (제외 1명)');
-- 자봉 면제: +점수는 출석·직접 기록·요청 승인 모두 기록 안 함, 상점(−)은 받음, 명단 점수 맞추기는 예외
select roster_apply(:'t', format('[{"op":"exempt","id":"%s","on":true}]', :'s4')::jsonb, '[]', '2026-03-02');
set role postgres;
select pg_temp.ok((select exempt from students where id = :'s4') and (select summary from ops order by id desc limit 1) = '명단: 자봉 면제 1', '자봉 면제 지정');
select pg_temp.bal(:'s4') as b4 \gset
set role anon;
select pg_temp.ok((select (s ->> 'exempt')::boolean from json_array_elements(public_state() -> 'students') s where s ->> 'id' = :'s4'), '면제는 공개 상태에도 보인다');
select pg_temp.ok(add_entries(:'t', '2026-03-02', array[:'s4', :'s1']::uuid[], '면제 확인', '', 2) = 1, '두 명 중 면제 학생은 빼고 기록');
select pg_temp.expect_msg(format('select add_entries(%L, %L, array[%L]::uuid[], %L, %L, 1)', :'t', '2026-03-02', :'s4', 'x', ''), '고른 학생이 모두 자봉 면제라%', '면제 학생만 고르면 안내');
select pg_temp.ok(add_entries(:'t', '2026-03-02', array[:'s4']::uuid[], '면제 상점', '', -1) = 1, '면제 학생도 상점은 받음');
select ensure_period(:'t', '2026-03-02', '면제 교시', false) as pe \gset
select pg_temp.ok(save_attendance(:'t', :'pe', format('{"%s":"absent","%s":"late"}', :'s4', :'s2')::jsonb) = 1, '출석: 면제 학생 결석은 기록 안 함');
select create_request(:'ot', '2026-03-02', array[:'s4', :'s2']::uuid[], '면제 요청', '', 1, '', null) as rqx \gset
select pg_temp.ok(review_request(:'t', :'rqx', true, null) = 1, '요청 승인: 면제 학생은 빼고');
select roster_apply(:'t', '[]', '[{"name":"라","to":10}]', '2026-03-02');
set role postgres;
select pg_temp.ok(pg_temp.bal(:'s4') = 10 and (select status from attendance where period_id = :'pe' and student_id = :'s4') = 'absent'
  and not exists (select 1 from ledger where student_id = :'s4' and points > 0 and src in ('att', 'manual', 'request')), '면제: +기록 없음, 출결 표시는 남음, 명단 점수 맞추기는 들어감');
set role anon;
select roster_apply(:'t', format('[{"op":"exempt","id":"%s","on":false}]', :'s4')::jsonb, '[{"name":"라","to":0}]', '2026-03-02');
select pg_temp.ok(add_entries(:'t', '2026-03-02', array[:'s4']::uuid[], '면제 해제 뒤', '', 1) = 1, '면제를 풀면 다시 기록');
select roster_apply(:'t', '[]', '[{"name":"라","to":0}]', '2026-03-02');
set role postgres;
select pg_temp.ok(not (select exempt from students where id = :'s4') and (select summary from ops where summary like '명단:%면제 해제%') like '명단: 면제 해제 1%', '면제 해제');
\echo 4. 명단 통과

-- ───────── 5. 자주 쓰는 항목 ─────────
select my_presets_save(:'ot', '[{"name":" 청소 ","points":2},{"name":"","points":0},{"name":"도움","points":-1}]');
set role postgres;
select pg_temp.ok((select string_agg(name || points, ',' order by sort) from presets where owner = '학습부장') = '청소2,도움-1', '이름 다듬기, 빈 줄 건너뛰기, 순서 유지');
select pg_temp.ok((select count(*) from presets where owner = '부총대') = 6, '다른 직책 항목은 그대로');
select pg_temp.ok((select actor = '학습부장' and summary = '자주 쓰는 항목 저장 (3개)' from ops order by id desc limit 1), '항목 저장 작업 요약');
set role anon;
select pg_temp.expect_msg(format('select my_presets_save(%L, %L)', :'ot', '[{"name":"x","points":0}]'), '점수는 0이 아닌 정수%', '0점 항목');
select pg_temp.expect_msg(format('select my_presets_save(%L, %L)', :'ot', '[{"name":"x","points":1.5}]'), '점수는 0이 아닌 정수%', '1.5점 항목');
select pg_temp.expect_msg(format('select my_presets_save(%L, %L)', :'ot', '[{"name":"x"}]'), '점수는 0이 아닌 정수%', '점수 없는 항목');
select pg_temp.expect_msg(format('select my_presets_save(%L, %L)', :'ot', (select json_agg(json_build_object('name', 'x' || i, 'points', 1)) from generate_series(1, 31) i)), '내 항목은 30개까지%', '31개');
set role postgres;
select pg_temp.ok((select count(*) from presets where owner = '학습부장') = 2, '실패하면 항목은 그대로');
\echo 5. 자주 쓰는 항목 통과

-- ───────── 6. 교시·출석 ─────────
set role anon;
select pg_temp.expect_msg(format('select ensure_period(%L, %L, %L, false)', :'t', '2026-03-03', '  '), '교시 이름을 입력하세요', '빈 교시 이름');
select ensure_period(:'t', '2026-03-03', ' 아침 출석 ', true) as p1 \gset
set role postgres; select pg_temp.nops() as n0 \gset
set role anon;
select pg_temp.ok(ensure_period(:'t', '2026-03-03', '아침 출석', true) = :'p1', '같은 교시는 같은 id');
set role postgres;
select pg_temp.ok(pg_temp.nops() = :n0 and (select label = '아침 출석' and morning from periods where id = :'p1'), '이미 있으면 작업 없음, 이름 다듬기');
set role anon;
select ensure_period(:'ct', '2026-03-03', '1교시', false) as p2 \gset
select save_attendance(:'t', :'p1', format('{"%s":"late","%s":"absent","%s":"excused","%s":"late"}', :'s1', :'s2', :'s3', :'s8')::jsonb) as n \gset
select pg_temp.ok(:n = 2, '출석 저장: 지각·결석만 새 기록');
set role postgres;
select pg_temp.ok((select points = 1 and detail = '아침 출석' and date = '2026-03-03' and src = 'att' from ledger where period_id = :'p1' and student_id = :'s1'), '지각 +1, 세부는 교시 이름');
select pg_temp.ok((select points = 2 and item = '결석' from ledger where period_id = :'p1' and student_id = :'s2'), '결석 +2');
select pg_temp.ok((select count(*) from attendance where period_id = :'p1') = 3 and not exists (select 1 from ledger where student_id = :'s8' and period_id = :'p1'), '제외된 학생은 출석에서 무시');
select pg_temp.ok((select created_by = '부총대' and requested_by is null from ledger_private lp join ledger l on l.id = lp.ledger_id where l.period_id = :'p1' and l.student_id = :'s1'), '저장한 사람 기록');
select pg_temp.ok((select summary from ops order by id desc limit 1) = '출석 저장: 3/3 아침 출석 (지각 2 · 결석 1 · 공결 1)', '출석 작업 요약');
select pg_temp.ok((public_state() -> 'att' -> :'p1') is not null and (public_state() -> 'att' -> :'p2') is null, '저장한 교시만 출결 공개');
set role anon;
select save_attendance(:'t', :'p1', format('{"%s":"late","%s":"absent"}', :'s2', :'s3')::jsonb) as n \gset
set role postgres;
select pg_temp.ok(:n = 2
  and (select void_reason from ledger where period_id = :'p1' and student_id = :'s1') = '출석 정정'
  and (select count(*) from ledger where period_id = :'p1' and student_id = :'s2' and voided_at is null and item = '지각') = 1
  and (select void_reason from ledger where period_id = :'p1' and student_id = :'s2' and item = '결석') = '출석 정정'
  and exists (select 1 from ledger where period_id = :'p1' and student_id = :'s3' and item = '결석' and voided_at is null), '다시 저장: 정정은 무효 처리 후 새 기록');
set role anon;
select save_attendance(:'t', :'p1', format('{"%s":"late","%s":"excused"}', :'s2', :'s3')::jsonb) as n \gset
set role postgres;
select pg_temp.ok(:n = 0 and (select void_reason from ledger where period_id = :'p1' and student_id = :'s3' and item = '결석') = '공결 처리', '공결로 바꾸면 무효 처리만');
select count(*) as nl from ledger \gset
set role anon;
select pg_temp.ok(save_attendance(:'t', :'p1', format('{"%s":"late","%s":"excused"}', :'s2', :'s3')::jsonb) = 0, '같은 내용 다시 저장');
set role postgres; select pg_temp.ok((select count(*) from ledger) = :nl and (select count(*) from ledger where period_id = :'p1' and voided_at is null) = 1, '같은 내용이면 바뀌는 것 없음');
set role anon;
select pg_temp.expect_msg(format('select save_attendance(%L, gen_random_uuid(), %L)', :'t', '{}'), '교시를 찾을 수 없어요', '없는 교시 저장');
select pg_temp.expect_msg(format('select request_attendance(%L, gen_random_uuid(), %L)', :'ct', '{}'), '교시를 찾을 수 없어요', '없는 교시 요청');
select request_attendance(:'ct', :'p2', format('{"%s":"late"}', :'s1')::jsonb) as r1 \gset
select pg_temp.ok(request_attendance(:'ct', :'p2', format('{"%s":"absent"}', :'s1')::jsonb) = :'r1', '같은 사람·교시의 대기 요청은 덮어씀');
select request_attendance(:'pt', :'p2', format('{"%s":"late"}', :'s4')::jsonb) as r2 \gset
set role postgres;
select pg_temp.ok(:'r1' <> :'r2' and (select statuses ->> :'s1' from attendance_requests where id = :'r1') = 'absent', '다른 사람 요청은 따로');
select pg_temp.ok(not exists (select 1 from ledger where period_id = :'p2'), '요청만으로는 기록 없음');
set role anon;
select pg_temp.expect_msg(format('select review_attendance(%L, %L, false, %L)', :'t', :'r1', ' '), '반려 사유를 입력하세요', '출석 요청 반려 사유');
select pg_temp.ok(review_attendance(:'t', :'r1', false, ' 중복 ') = 0, '출석 요청 반려');
set role postgres;
select pg_temp.ok((select status = 'rejected' and review_note = '중복' and reviewed_by = '부총대' and reviewed_at is not null from attendance_requests where id = :'r1'), '반려 기록');
set role anon;
select request_attendance(:'ct', :'p2', format('{"%s":"late"}', :'s1')::jsonb) as r3 \gset
select pg_temp.ok(:'r3' <> :'r1', '반려 뒤 다시 보내면 새 요청');
select pg_temp.ok(review_attendance(:'t', :'r2', true, null) = 1, '출석 요청 승인');
select pg_temp.expect_msg(format('select review_attendance(%L, %L, true, null)', :'t', :'r2'), '이미 처리된 요청이에요', '두 번 승인');
set role postgres;
select pg_temp.ok((select lp.created_by = '부총대' and lp.requested_by = '실습부장 2' and lp.approved_by = '부총대' from ledger l join ledger_private lp on lp.ledger_id = l.id where l.period_id = :'p2' and l.student_id = :'s4'), '승인된 출석의 요청자·승인자');
set role anon;
select pg_temp.ok(review_attendance(:'t', :'r3', true, null) = 1, '저장된 교시에 다른 요청 승인');
set role postgres;
select pg_temp.ok((select void_reason from ledger where period_id = :'p2' and student_id = :'s4') = '출석 정정'
  and exists (select 1 from ledger where period_id = :'p2' and student_id = :'s1' and voided_at is null), '나중 요청 내용으로 바뀜');
\echo 6. 교시·출석 통과

-- ───────── 7. 직접 기록·수정·무효 ─────────
set role anon;
select pg_temp.expect_msg(format('select add_entries(%L, %L, array[%L]::uuid[], %L, %L, 1)', :'t', '2026-03-04', :'s1', '  ', ''), '항목명을 입력하세요', '빈 항목명');
select pg_temp.expect_msg(format('select add_entries(%L, %L, array[%L]::uuid[], %L, %L, 0)', :'t', '2026-03-04', :'s1', 'x', ''), '점수는 0이 아닌 0.5점 단위%', '0점');
select pg_temp.expect_msg(format('select add_entries(%L, %L, array[%L]::uuid[], %L, %L, 0.3)', :'t', '2026-03-04', :'s1', 'x', ''), '점수는 0이 아닌 0.5점 단위%', '0.3점');
select pg_temp.expect_msg(format('select add_entries(%L, %L, array[%L]::uuid[], %L, %L, null)', :'t', '2026-03-04', :'s1', 'x', ''), '점수는 0이 아닌 0.5점 단위%', '점수 없음');
select pg_temp.expect_msg(format('select add_entries(%L, %L, %L::uuid[], %L, %L, 1)', :'t', '2026-03-04', '{}', 'x', ''), '학생을 골라 주세요', '학생 없음');
set role postgres; select pg_temp.nops() as n0 \gset
set role anon;
select pg_temp.ok(add_entries(:'t', '2026-03-04', array[:'s1', :'s2']::uuid[], ' 실습실 뒷정리 ', ' 전원 ', 1.5) = 2, '두 명에게 기록');
set role postgres;
select pg_temp.ok(pg_temp.nops() = :n0 + 1 and (select summary from ops order by id desc limit 1) = '기록: 실습실 뒷정리 +1.5 (전원) · 1 2번', '기록 작업 하나, 번호순 요약');
select pg_temp.ok((select count(*) from ledger where item = '실습실 뒷정리' and detail = '전원' and points = 1.5 and src = 'manual') = 2, '항목·세부 다듬어 저장');
select id as e1 from ledger where item = '실습실 뒷정리' and student_id = :'s1' \gset
set role anon;
select pg_temp.expect_msg(format('select edit_entry(%L, %L, %L, %L, %L, 1.5, %L)', :'t', :'e1', '2026-03-04', '실습실 뒷정리', '전원', '사유'), '바뀐 내용이 없어요', '바뀐 것 없는 수정');
select pg_temp.expect_msg(format('select edit_entry(%L, %L, %L, %L, %L, 1, %L)', :'t', :'e1', '2026-03-04', '실습실 뒷정리', '전원', ' '), '수정 사유를 입력하세요', '수정 사유 없음');
select pg_temp.expect_msg(format('select edit_entry(%L, %L, %L, %L, %L, 0.3, %L)', :'t', :'e1', '2026-03-04', '실습실 뒷정리', '전원', 'r'), '점수는%', '수정 점수 0.3');
select pg_temp.expect_msg(format('select edit_entry(%L, gen_random_uuid(), %L, %L, %L, 1, %L)', :'t', '2026-03-04', 'x', '', 'r'), '기록을 찾을 수 없어요', '없는 기록 수정');
select edit_entry(:'t', :'e1', '2026-03-05', '실습실 정리', '전원', 1, ' 오기 ');
set role postgres;
select pg_temp.ok((select date = '2026-03-05' and item = '실습실 정리' and points = 1 from ledger where id = :'e1'), '수정 반영');
select pg_temp.ok((select before = '{"date":"2026-03-04","item":"실습실 뒷정리","points":1.5}'::jsonb and after = '{"date":"2026-03-05","item":"실습실 정리","points":1}'::jsonb
  and reason = '오기' and edited_by = '부총대' from ledger_revisions where ledger_id = :'e1'), '수정 이력은 바뀐 칸만');
select pg_temp.ok((select summary from ops order by id desc limit 1) = '수정: 2번 실습실 뒷정리 +1.5 (오기)', '수정 작업 요약');
set role anon;
select pg_temp.expect_msg(format('select void_entry(%L, %L, %L)', :'t', :'e1', ' '), '무효 처리 사유를 입력하세요', '무효 사유 없음');
select void_entry(:'t', :'e1', ' 착오 ');
select pg_temp.expect_msg(format('select void_entry(%L, %L, %L)', :'t', :'e1', 'x'), '이미 무효 처리된 기록이에요', '두 번 무효');
select pg_temp.expect_msg(format('select void_entry(%L, gen_random_uuid(), %L)', :'t', 'x'), '이미 무효 처리된 기록이에요', '없는 기록 무효');
set role postgres;
select pg_temp.ok((select voided_at is not null and void_reason = '착오' from ledger where id = :'e1') and (select voided_by = '부총대' from ledger_private where ledger_id = :'e1'), '무효 처리 기록');
select pg_temp.ok((select summary from ops order by id desc limit 1) = '무효 처리: 2번 실습실 정리 +1 (착오)', '무효 작업 요약');
\echo 7. 직접 기록·수정·무효 통과

-- ───────── 8. 총대단 요청 ─────────
set role anon;
select pg_temp.expect_msg(format('select create_request(%L, %L, %L::uuid[], %L, %L, 1, %L, null)', :'ot', '2026-03-05', '{}', 'x', '', ''), '학생을 골라 주세요', '요청 학생 없음');
select pg_temp.expect_msg(format('select create_request(%L, %L, array[%L]::uuid[], %L, %L, 0, %L, null)', :'ot', '2026-03-05', :'s1', 'x', '', ''), '점수는%', '요청 0점');
select pg_temp.expect_msg(format('select create_request(%L, %L, array[%L]::uuid[], %L, %L, 1, %L, %L)', :'ot', '2026-03-05', :'s1', 'x', '', '', 'data:text/html;base64,AAAA'), '사진 형식이 올바르지 않아요', '사진 형식');
select pg_temp.expect_msg(format('select create_request(%L, %L, array[%L]::uuid[], %L, %L, 1, %L, %L)', :'ot', '2026-03-05', :'s1', 'x', '', '', 'data:image/jpeg;base64,' || repeat('A', 400000)), '사진이 너무 커요', '사진 크기');
select create_request(:'ot', '2026-03-05', array[:'s1', :'s3']::uuid[], ' 매점 ', '', -1, ' 도움 ', null) as rq1 \gset
select create_request(:'ct', '2026-03-05', array[:'s2']::uuid[], '청소', '', 2, '', 'data:image/jpeg;base64,/9j/AAAA') as rq2 \gset
select create_request(:'t', '2026-03-05', array[:'s5']::uuid[], '봉사', '', -2, '', null) as rq3 \gset
set role postgres;
select pg_temp.ok((select item = '매점' and reason = '도움' and status = 'pending' and requested_by = '학습부장' from requests where id = :'rq1'), '요청 저장');
select pg_temp.ok((select summary from ops order by id desc limit 1) = '요청: 봉사 -2 · 5번', '요청 작업 요약 (부총대도 요청할 수 있음)');
select photo_id as ph_req from requests where id = :'rq2' \gset
set role anon;
select pg_temp.ok(get_photo(:'ot', :'ph_req') = 'data:image/jpeg;base64,/9j/AAAA' and get_photo(:'t', :'ph_req') is not null, '요청 사진은 총대단도 봄');
select pg_temp.ok(get_photo(:'ot', gen_random_uuid()) is null, '없는 사진');
select pg_temp.ok(json_array_length(private_state(:'ot') -> 'requests') = 4, '총대단은 모든 요청을 봄 (면제 확인 요청 포함)');
select pg_temp.ok(review_request(:'t', :'rq1', true, null) = 2, '요청 승인 → 학생 수만큼 기록');
select pg_temp.expect_msg(format('select review_request(%L, %L, true, null)', :'t', :'rq1'), '이미 처리된 요청이에요', '두 번 승인');
select pg_temp.expect_msg(format('select review_request(%L, %L, false, %L)', :'t', :'rq2', ''), '반려 사유를 입력하세요', '반려 사유 없음');
select review_request(:'t', :'rq2', false, ' 중복 ');
select roster_apply(:'t', format('[{"op":"remove","id":"%s"}]', :'s5')::jsonb, '[]', '2026-03-05');
select pg_temp.ok(review_request(:'t', :'rq3', true, null) = 1, '제외된 학생에게도 요청 기록은 들어감');
select roster_apply(:'t', format('[{"op":"restore","id":"%s","no":5}]', :'s5')::jsonb, '[]', '2026-03-05');
set role postgres;
select pg_temp.ok((select count(*) from ledger l join ledger_private lp on lp.ledger_id = l.id where l.request_id = :'rq1' and l.src = 'request' and l.item = '매점'
  and lp.requested_by = '학습부장' and lp.approved_by = '부총대' and lp.created_by = '부총대') = 2, '요청 기록의 요청자·승인자');
select pg_temp.ok((select status = 'rejected' and review_note = '중복' and reviewed_by = '부총대' from requests where id = :'rq2'), '요청 반려 기록');
select pg_temp.ok(not exists (select 1 from ledger where request_id = :'rq2'), '반려하면 기록 없음');
set role anon;
select pg_temp.ok((select e ->> 'by' from json_array_elements(private_state(:'t') -> 'ledger') e where (e ->> 'src') = 'request' and e ->> 'item' = '매점' limit 1) = '학습부장', '로그인 상태의 요청 기록은 요청자 표시');
\echo 8. 총대단 요청 통과

-- ───────── 9. 공결 ─────────
set role postgres;
select id as e_late from ledger where period_id = :'p1' and student_id = :'s2' and voided_at is null \gset
select id as e_void from ledger where period_id = :'p1' and student_id = :'s1' \gset
select id as e_manual from ledger where item = '실습실 뒷정리' and student_id = :'s2' \gset
select id as e_import from ledger where item = '기존 누적' and student_id = :'s1' \gset
set role anon;
select pg_temp.expect_msg(format('select create_excuse(%L, %L, %L, null)', :'s2', :'e_manual', ''), '공결 신청할 수 있는 출결 기록이 아니에요', '지각·결석이 아닌 기록');
select pg_temp.expect_msg(format('select create_excuse(%L, %L, %L, null)', :'s1', :'e_import', ''), '공결 신청할 수 있는%', '기존 누적');
select pg_temp.expect_msg(format('select create_excuse(%L, %L, %L, null)', :'s1', :'e_late', ''), '공결 신청할 수 있는%', '다른 학생의 기록');
select pg_temp.expect_msg(format('select create_excuse(%L, %L, %L, null)', :'s1', :'e_void', ''), '공결 신청할 수 있는%', '무효 처리된 기록');
select pg_temp.expect_msg(format('select create_excuse(%L, %L, %L, %L)', :'s2', :'e_late', '', 'javascript:alert(1)'), '사진 형식이 올바르지 않아요', '공결 사진 형식');
select create_excuse(:'s2', :'e_late', '', null) as x1 \gset
select pg_temp.expect_msg(format('select create_excuse(%L, %L, %L, null)', :'s2', :'e_late', ''), '이미 신청해서 확인을 기다리는 중이에요', '같은 기록 두 번 신청');
set role postgres;
select pg_temp.ok((select actor = '1번 학생' and summary = '공결 신청: 1번 3/3 지각' from ops order by id desc limit 1), '공결 신청 작업은 학생 번호로 남음');
set role anon;
select create_request(:'ot', '2026-03-05', array[:'s3']::uuid[], '지각', '', 1, '', null) as rq4 \gset
select review_request(:'t', :'rq4', true, null);
select add_entries(:'t', '2026-03-05', array[:'s4']::uuid[], '결석', '', 2);
set role postgres;
select id as e_req from ledger where request_id = :'rq4' \gset
select id as e_abs from ledger where student_id = :'s4' and item = '결석' and src = 'manual' \gset
set role anon;
select create_excuse(:'s3', :'e_req', repeat('가', 600), null) as x2 \gset
select create_excuse(:'s4', :'e_abs', ' 병원 ', 'data:image/jpeg;base64,/9j/BBBB') as x3 \gset
set role postgres;
select pg_temp.ok((select length(reason) from excuses where id = :'x2') = 500 and (select reason from excuses where id = :'x3') = '병원', '공결 사유는 500자까지, 다듬어 저장');
select photo_id as ph_exc from excuses where id = :'x3' \gset
set role anon;
select pg_temp.expect(format('select get_photo(%L, %L)', :'ot', :'ph_exc'), '42501', '공결 증빙은 총대단이 못 봄');
select pg_temp.ok(get_photo(:'t', :'ph_exc') = 'data:image/jpeg;base64,/9j/BBBB', '공결 증빙은 부총대가 봄');
select pg_temp.expect_msg(format('select review_excuse(%L, %L, false, %L)', :'t', :'x1', ''), '반려 사유를 입력하세요', '공결 반려 사유');
select review_excuse(:'t', :'x1', false, '증빙 없음');
set role postgres;
select pg_temp.ok((select status = 'rejected' and review_note = '증빙 없음' from excuses where id = :'x1') and (select voided_at is null from ledger where id = :'e_late'), '공결 반려는 기록을 건드리지 않음');
set role anon;
select create_excuse(:'s2', :'e_late', '', null) as x4 \gset
select review_excuse(:'t', :'x4', true, null);
select review_excuse(:'t', :'x3', true, null);
select void_entry(:'t', :'e_req', '착오');
select review_excuse(:'t', :'x2', true, null);
select pg_temp.expect_msg(format('select review_excuse(%L, %L, true, null)', :'t', :'x2'), '이미 처리된 신청이에요', '두 번 처리');
set role postgres;
select pg_temp.ok((select void_reason = '공결 승인' from ledger where id = :'e_late') and (select status from attendance where period_id = :'p1' and student_id = :'s2') = 'excused'
  and (select voided_by = '부총대' from ledger_private where ledger_id = :'e_late'), '출석 기록 공결 승인 → 무효 + 출결은 공결');
select pg_temp.ok((select void_reason = '공결 승인 (병원)' from ledger where id = :'e_abs') and not exists (select 1 from attendance where student_id = :'s4' and status = 'excused'), '직접 기록 공결 승인은 사유를 붙여 무효 (출결 없음)');
select pg_temp.ok((select void_reason = '착오' from ledger where id = :'e_req') and (select status = 'approved' from excuses where id = :'x2'), '이미 무효인 기록의 공결 승인은 상태만');
set role anon;
select public_state()::text as pub \gset
select pg_temp.ok(not exists (select 1 from json_array_elements(:'pub'::json -> 'excuses') x where x ->> 'photo' is not null or x ->> 'reviewer' is not null or x ->> 'reviewedAt' is not null), '공개 상태의 공결에는 사진·처리자 없음');
select pg_temp.ok(exists (select 1 from json_array_elements(private_state(:'t') -> 'excuses') x where x ->> 'photo' = :'ph_exc'), '로그인 상태에는 증빙 사진 id');
\echo 9. 공결 통과

-- ───────── 10. 공개/비공개 상태 ─────────
select pg_temp.ok(not exists (select 1 from json_array_elements(:'pub'::json -> 'students') s where s::jsonb ? 'name'), '공개 상태에 이름 칸 없음');
select pg_temp.ok(json_array_length(:'pub'::json -> 'requests') = 0 and json_array_length(:'pub'::json -> 'attRequests') = 0, '공개 상태에 요청 없음');
select pg_temp.ok(not exists (select 1 from json_array_elements(:'pub'::json -> 'ledger') e
  where e ->> 'by' is not null or e ->> 'requestedBy' is not null or e ->> 'approvedBy' is not null or e -> 'voided' ->> 'by' is not null
     or exists (select 1 from json_array_elements(e -> 'revs') r where r ->> 'by' is not null)), '공개 상태에 기록·요청·승인·무효·수정한 사람 없음');
select pg_temp.ok(position('가' in (:'pub'::json -> 'students')::text) = 0 and position('다다' in :'pub') = 0, '공개 상태에 학생 이름 문자열 없음');
select pg_temp.ok(json_array_length(:'pub'::json -> 'accounts') = 9 and position('pw_hash' in :'pub') = 0, '직책 목록은 공개, 비밀번호는 없음');
select private_state(:'ot')::text as prv \gset
select pg_temp.ok(position('다다' in :'prv') > 0 and json_array_length(:'prv'::json -> 'attRequests') = 3, '로그인 상태에는 이름과 출석 요청');
\echo 10. 공개/비공개 상태 통과

-- ───────── 11. 작업 로그와 변경 알림 ─────────
set role postgres;
select pg_temp.nops() as n0, (select version from app_version) as v0 \gset
set role anon;
select public_state(), private_state(:'t'), ops_list(:'t', 5), get_photo(:'t', :'ph_req'), backup_dump(), login('총무', '1234'), login('총무', 'x');
select history_move(:'t', 0, true) is not null;
set role postgres;
select pg_temp.ok(pg_temp.nops() = :n0 and (select version from app_version) = :v0, '읽기·미리보기는 작업도 변경 알림도 없음');
set role anon;
select pg_temp.expect(format('select add_entries(%L, %L, array[%L]::uuid[], %L, %L, 0)', :'t', '2026-03-05', :'s1', 'x', ''), 'P0001', '실패한 기록');
select pg_temp.expect(format('select roster_apply(%L, %L, %L, %L)', :'t', '[{"op":"add","name":"겹침","no":1}]', '[]', '2026-03-05'), 'P0001', '실패한 명단');
set role postgres;
select pg_temp.ok(pg_temp.nops() = :n0 and (select version from app_version) = :v0, '실패한 작업은 흔적 없음');
set role anon;
select add_entries(:'t', '2026-03-06', array[:'s1']::uuid[], '실습', '', 1);
set role postgres;
select pg_temp.ok(pg_temp.nops() = :n0 + 1 and (select version from app_version) > :v0, '바꾸는 작업은 작업 1개 + 변경 알림');
select pg_temp.ok((select array_agg(distinct kind order by kind) from ops) @> array['add_entries', 'create_excuse', 'create_request', 'edit_entry', 'ensure_period',
  'my_presets_save', 'request_attendance', 'review_attendance', 'review_excuse', 'review_request', 'roster_apply', 'save_attendance', 'void_entry'], '데이터를 바꾸는 함수 13종이 모두 작업 내역에 남음');
select pg_temp.ok(not exists (select 1 from ops where actor not in (select role from accounts) and actor !~ '^[0-9]+번 학생$'), '작업한 사람은 직책이나 학생 번호');
set role anon;
select pg_temp.ok(json_array_length(ops_list(:'t', 3)) = 3 and json_array_length(ops_list(:'t', null)) = least(50, (select count(*) from json_array_elements(ops_list(:'t', 1000)))), 'ops_list 개수 제한 (기본 50)');
select pg_temp.ok((ops_list(:'t', 1000) -> 0 ->> 'id')::bigint > (ops_list(:'t', 1000) -> 1 ->> 'id')::bigint, 'ops_list는 최신순');
\echo 11. 작업 로그·변경 알림 통과

-- ───────── 12. 오래된 사진·로그인 정리 ─────────
set role anon;
select create_request(:'ot', '2026-03-06', array[:'s1']::uuid[], 'x', '', 1, '', 'data:image/jpeg;base64,/9j/CCCC') as rq5 \gset
set role postgres;
select photo_id as ph_pending from requests where id = :'rq5' \gset
update requests set reviewed_at = now() - interval '181 days' where id = :'rq2';
update requests set created_at = now() - interval '400 days' where id = :'rq5';
update excuses set reviewed_at = now() - interval '179 days' where id = :'x3';
insert into sessions (role, expires_at) values ('총무', now() - interval '1 day') returning token as old_t \gset
set role anon;
select login('총무', '1234') is not null;
set role postgres;
select pg_temp.ok((select photo_id is null from requests where id = :'rq2') and not exists (select 1 from photos where id = :'ph_req'), '처리 180일 지난 사진 삭제');
select pg_temp.ok(exists (select 1 from photos where id = :'ph_pending') and exists (select 1 from photos where id = :'ph_exc'), '대기 중이거나 180일 안 된 사진은 남음');
select pg_temp.ok(not exists (select 1 from sessions where token = :'old_t'), '만료된 로그인 삭제');
set role anon;
select pg_temp.ok(get_photo(:'t', :'ph_req') is null, '지워진 사진은 null (화면: 사진이 삭제됐어요)');
\echo 12. 사진·로그인 정리 통과

-- ───────── 13. 백업·되살리기 ─────────
set role anon;
select backup_dump()::text as dump \gset
select pg_temp.ok(position('$2a$' in :'dump') = 0 and position('$2b$' in :'dump') = 0 and position('data:image' in :'dump') = 0
  and position('recovery' in :'dump') = 0 and position(:'t' in :'dump') = 0, '백업에 비밀번호·복구 코드·로그인·사진 없음');
select pg_temp.ok((select array_agg(k order by k) from json_object_keys(:'dump'::json -> 'tables') k) = array['attendance', 'attendance_requests', 'excuses', 'ledger',
  'ledger_private', 'ledger_revisions', 'periods', 'presets', 'requests', 'students'], '백업에 모든 데이터 표');
set role postgres;
create or replace function pg_temp.sig_all() returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from students x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from presets x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from periods x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.period_id, x.student_id) from attendance x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from ledger x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.ledger_id) from ledger_private x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from ledger_revisions x),
    (select string_agg((to_jsonb(x) - 'photo_id')::text, ',' order by x.id) from requests x),
    (select string_agg((to_jsonb(x) - 'photo_id')::text, ',' order by x.id) from excuses x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from attendance_requests x)))
$$;
select pg_temp.sig_all() as sig_before \gset
set role anon;
select pg_temp.expect_msg(format('select restore_backup(%L, %L)', :'t', '{"format":"x","tables":{}}'), '자봉 장부 백업 파일이 아니에요', '다른 파일');
select pg_temp.expect_msg(format('select restore_backup(%L, %L)', :'t', '{"format":"jabong-backup"}'), '자봉 장부 백업 파일이 아니에요', '표 없는 파일');
select add_entries(:'t', '2026-03-07', array[:'s1', :'s2', :'s3']::uuid[], '망가짐', '', 5);
select roster_apply(:'t', '[{"op":"add","name":"새학생","no":9}]', '[]', '2026-03-07');
-- 자봉 면제 칸이 생기기 전 백업도 되살릴 수 있다
select restore_backup(:'t', jsonb_set(:'dump'::jsonb, '{tables,students}', (select jsonb_agg(x - 'exempt') from jsonb_array_elements(:'dump'::jsonb -> 'tables' -> 'students') x)));
set role postgres;
select pg_temp.ok(not exists (select 1 from students where exempt), '옛 백업은 면제 없음으로');
set role anon;
select restore_backup(:'t', :'dump'::jsonb)::json as rs \gset
set role postgres;
select pg_temp.ok(pg_temp.sig_all() = :'sig_before', '되살리면 모든 표가 백업과 똑같음');
select pg_temp.ok((select count(*) from ops) = 1 and (select kind = 'restore_backup' and not undoable from ops), '되살리기 뒤 작업 내역은 되살리기 한 줄');
select pg_temp.ok((:'rs'::json ->> 'students')::int = (select count(*) from students), '되살리기 결과');
select pg_temp.ok((select photo_id = :'ph_pending' from requests where id = :'rq5') and (select photo_id is null from requests where id = :'rq2'), '남아 있는 사진만 다시 연결');
set role anon;
select pg_temp.expect_msg(format('select history_move(%L, 0, false)', :'t'), '보관 후 정리나 백업에서 되살리기 너머로는%', '되살리기 너머로 이동 불가');
select pg_temp.ok(private_state(:'ot') is not null, '되살려도 로그인은 유지');
\echo 13. 백업·되살리기 통과

-- ───────── 14. 보관 후 정리 ─────────
set role anon;
-- 음수로 이월되는 학생도 있게 한다
select add_entries(:'t', '2026-03-01', array[:'s6']::uuid[], '매점', '', -1);
set role postgres;
select string_agg(id || ':' || pg_temp.bal(id), ',' order by id) as bals, (select count(*) from ledger where date > '2026-03-04') as later from students \gset
select (select count(*) from requests where status = 'pending') as pend \gset
set role anon;
select purge(:'t', '2026-03-04')::json as pr \gset
set role postgres;
select pg_temp.ok((select string_agg(id || ':' || pg_temp.bal(id), ',' order by id) from students) = :'bals', '정리해도 학생별 자봉 그대로');
select pg_temp.ok(not exists (select 1 from ledger where date < '2026-03-04') and not exists (select 1 from ledger where date = '2026-03-04' and src <> 'carry'), '기준일까지는 이월만 남음');
select pg_temp.ok((select count(*) from ledger where date > '2026-03-04') = :later, '기준일 뒤 기록은 그대로');
select pg_temp.ok((:'pr'::json ->> 'carry')::int = (select count(*) from ledger where src = 'carry')
  and (select bool_and(item = '이월' and detail = '3/4까지 합계') from ledger where src = 'carry')
  and exists (select 1 from ledger where src = 'carry' and points < 0), '이월 기록 (음수 포함)');
select pg_temp.ok(not exists (select 1 from periods where date <= '2026-03-04') and not exists (select 1 from attendance_requests) and not exists (select 1 from excuses where ledger_id is null), '옛 교시·출석 요청·연결 끊긴 공결 삭제');
select pg_temp.ok((select count(*) from requests where status = 'pending') = :pend and not exists (select 1 from requests where status <> 'pending' and date <= '2026-03-04'), '처리된 옛 요청만 삭제');
select pg_temp.ok(not exists (select 1 from photos p where not exists (select 1 from requests where photo_id = p.id) and not exists (select 1 from excuses where photo_id = p.id)), '쓰이지 않는 사진 삭제');
select pg_temp.ok((select count(*) from ops) = 1 and (select kind = 'purge' and not undoable and actor = '부총대' from ops), '정리 뒤 작업 내역은 정리 한 줄');
set role anon;
select purge(:'t', '2026-03-04');
set role postgres;
select pg_temp.ok((select string_agg(id || ':' || pg_temp.bal(id), ',' order by id) from students) = :'bals'
  and not exists (select 1 from ledger where src = 'carry' group by student_id having count(*) > 1), '같은 날짜로 다시 정리해도 학생마다 이월 한 줄');
\echo 14. 보관 후 정리 통과

\echo 모든 서버 함수 테스트 통과
