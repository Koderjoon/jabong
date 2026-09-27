-- 한 학기 분량(학생 70명, 작업 약 600개)에서 속도 확인. Supabase는 앱(anon)의 요청을 약 3초에 끊으니 그 안에 끝나야 한다.
\set QUIET on
\set ON_ERROR_STOP on
create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FAIL: %', msg; end if; end $$;
select init_app('1234') \gset
select (login('부총대', '1234')::json ->> 'token') as t \gset
select roster_apply(:'t', (select jsonb_agg(jsonb_build_object('op', 'add', 'name', '학생' || n, 'no', n)) from generate_series(1, 70) n), '[]', '2026-03-02');
select min(id) as first from ops \gset
-- 120일 × 교시 3개 출석 저장 + 이틀에 한 번 직접 기록
do $$
declare t uuid := (select token from sessions order by expires_at desc limit 1); d date; p uuid; ids uuid[] := array(select id from students order by no); lbl text;
begin
  for i in 0..119 loop
    d := date '2026-03-02' + i;
    foreach lbl in array array['아침 출석', '1교시', '3교시'] loop
      p := ensure_period(t, d, lbl, lbl = '아침 출석');
      perform save_attendance(t, p, jsonb_build_object(ids[1 + (i * 7) % 70], 'late', ids[1 + (i * 13) % 70], 'absent'));
    end loop;
    if i % 2 = 0 then perform add_entries(t, d, ids[1 + i % 60 : 5 + i % 60], '실습실 뒷정리 미흡', '전원 안끔', 1); end if;
  end loop;
end $$;
select count(*) as nops, max(id) as last from ops \gset
\echo 작업 :nops 개
set role anon;
set statement_timeout = '3s';
select history_move(:'t', :first, true) is not null;
select history_move(:'t', :first, false) is not null;
select history_move(:'t', :last, false) is not null;
select private_state(:'t') is not null, public_state() is not null, ops_list(:'t', 50) is not null, backup_dump() is not null;
reset statement_timeout;
set role postgres;
select pg_temp.ok(not exists (select 1 from ops where undone), '맨 처음 ↔ 맨 끝을 3초 안에 오감');
\echo 한 학기 분량 속도 테스트 통과
