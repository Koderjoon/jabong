-- 한 학기 분량(학생 70명, 작업 약 600개)에서 속도 확인. Supabase는 앱(anon)의 요청을 약 3초에 끊으니 그 안에 끝나야 한다.
\set QUIET on
\set ON_ERROR_STOP on
create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FAIL: %', msg; end if; end $$;
create or replace function pg_temp.expect_msg(q text, pattern text, msg text) returns void language plpgsql as $$
declare m text;
begin
  begin execute q; exception when others then m := sqlerrm; end;
  if m is null or m not like pattern then raise exception 'FAIL: % (메시지 %, 기대 %)', msg, coalesce(m, '오류 없음'), pattern; end if;
end $$;
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
  -- 학생 리액션 신청처럼 작은 작업이 많이 쌓인 경우 (작업 내역 이동 속도)
  for i in 1..1500 loop
    perform reaction_adjust(t, jsonb_build_array(jsonb_build_object('sid', ids[1 + i % 70], 'n', (i / 70) % 2 + 1)));
  end loop;
end $$;
-- 리액션: 학생마다 하루 1번꼴로 한 학기(70 × 120 = 8,400개, 긴 질문·대답), 3개씩 상점으로 묶임 + 오늘 대기 210개
insert into reactions (student_id, date, period, question, answer, status, created_at, reviewed_at, reviewed_by)
select s.id, date '2026-03-02' + d, '1교시 구강해부학', repeat('질문 ', 60), repeat('대답 ', 60), 'approved',
  timestamptz '2026-03-02 10:00+09' + d * interval '1 day', timestamptz '2026-03-02 20:00+09' + d * interval '1 day', '부총대'
from students s, generate_series(0, 119) d;
update reactions r set merit = md5(r.student_id::text || g.k)::uuid
from (select id, (row_number() over (partition by student_id order by created_at) - 1) / 3 as k,
             count(*) over (partition by student_id) as n from reactions) g
where g.id = r.id and g.k < g.n / 3;
insert into reactions (student_id, date, period, question, answer, created_at)
select s.id, (now() at time zone 'Asia/Seoul')::date, k || '교시', repeat('오늘 질문 ', 30), repeat('오늘 대답 ', 30), now() - interval '1 hour' + k * interval '1 minute'
from students s, generate_series(1, 3) k;
select count(*) as nops, max(id) as last from ops \gset
\echo 작업 :nops 개
select array_agg(id)::text as pend from reactions where status = 'pending' \gset
select id as s1 from students order by no limit 1 \gset
set role anon;
set statement_timeout = '3s';
-- 1,500개까지는 3초 안에 오가고, 그보다 많으면 한국어로 나눠서 옮기라고 한다
select history_move(:'t', :last - 1500, true) is not null;
select history_move(:'t', :last - 1500, false) is not null;
select history_move(:'t', :last, false) is not null;
reset statement_timeout;
set role postgres;
select pg_temp.ok(not exists (select 1 from ops where undone), '1,500개를 3초 안에 오감');
set role anon;
select pg_temp.expect_msg(format('select history_move(%L, %s, true)', :'t', :first), '한 번에 작업 1,500개까지만%', '그보다 많으면 나눠서');
set statement_timeout = '3s';
select private_state(:'t') is not null, public_state() is not null, ops_list(:'t', 50) is not null, backup_dump() is not null;
-- 리액션 화면·내보내기·한꺼번에 승인 (210개)도 3초 안에
select my_reactions(:'s1') is not null, reaction_feed(300) is not null,
  reaction_export(:'t', '2026-01-01', '2026-12-31') is not null;
select length(public_state()::text) as pub_len, length(private_state(:'t')::text) as priv_len \gset
select review_reaction(:'t', :'pend'::uuid[], true, null) as rx_merits \gset
select (ops_list(:'t', 1) -> 0 ->> 'id')::bigint as rx_op \gset
select history_drop(:'t', :rx_op, true) is not null;
reset statement_timeout;
set role postgres;
select pg_temp.ok(not exists (select 1 from ops where undone), '맨 끝으로 돌아옴');
-- 공개 상태(학생 폰이 바뀔 때마다 받는 것)는 리액션이 쌓여도 가볍다. 부총대 상태도 리액션 글은 대기 + 최근 14일만
-- (한 학기 분량 기록이 약 45만 바이트, 압축하면 약 7만 바이트. 리액션 8,400개가 더해져도 거의 늘지 않아야 한다)
select pg_temp.ok(:pub_len < 600000, format('공개 상태 크기 %s바이트', :pub_len));
select pg_temp.ok(:priv_len < :pub_len * 1.6, format('부총대 상태 크기 %s바이트', :priv_len));
select pg_temp.ok(json_array_length(public_state() -> 'reactions') = 0, '공개 상태에 리액션 글 없음');
select pg_temp.ok(:rx_merits > 0 and not exists (select student_id from reactions where status = 'approved' and merit is null group by student_id having count(*) >= 3), '한꺼번에 승인해도 3개마다 상점');
\echo 한 학기 분량 속도 테스트 통과
