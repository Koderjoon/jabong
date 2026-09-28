-- 작업 내역 전수 검증: 데이터를 바꾸는 모든 함수를 한 번 이상 부른 뒤,
-- 모든 시점으로 (거꾸로·차례로·뒤섞어) 이동해도 그 시점의 데이터와 똑같은지, 미리보기가 실제 결과와 같은지,
-- 작업마다 "이 작업만 되돌리기 → 다시 살리기"가 되거나 겹침(P0002)으로 안전하게 멈추는지 확인한다.
-- 새 DB에 schema.sql을 실행한 뒤 돌린다.
\set QUIET on
\set ON_ERROR_STOP on
create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FAIL: %', msg; end if; end $$;
-- 작업 내역이 다루는 모든 표의 내용 요약
create or replace function pg_temp.sig() returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from students x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from presets x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from periods x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.period_id, x.student_id) from attendance x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from ledger x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.ledger_id) from ledger_private x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from ledger_revisions x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from requests x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from excuses x),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from attendance_requests x)))
$$;
create temp table sigs (op bigint primary key, sig text not null);
create or replace function pg_temp.snap() returns void language sql as $$
  insert into sigs select coalesce((select max(id) from ops), 0), pg_temp.sig()
  on conflict (op) do update set sig = excluded.sig
$$;

select init_app('1234') \gset
select (login('부총대', '1234')::json ->> 'token') as t \gset
select (login('총대', '1234')::json ->> 'token') as ct \gset
select (login('실습부장 1', '1234')::json ->> 'token') as pt \gset
select (login('학습부장', '1234')::json ->> 'token') as ot \gset
select set_config('tt.t', :'t', false);
select pg_temp.snap();

-- ───────── 모든 종류의 작업 ─────────
select roster_apply(:'t', '[{"op":"add","name":"가","no":1},{"op":"add","name":"나","no":2},{"op":"add","name":"다","no":3},{"op":"add","name":"라","no":4}]',
  '[{"name":"가","to":2},{"name":"다","to":-1}]', '2026-04-01');
select pg_temp.snap();
select id as s1 from students where name = '가' \gset
select id as s2 from students where name = '나' \gset
select id as s3 from students where name = '다' \gset
select id as s4 from students where name = '라' \gset
select my_presets_save(:'ot', '[{"name":"청소","points":2}]'); select pg_temp.snap();
select my_presets_save(:'t', '[{"name":"매점","points":-1},{"name":"실습","points":1}]'); select pg_temp.snap();
select my_periods_save(:'t', '["1교시 해부학","2교시"]'); select pg_temp.snap();
select ensure_period(:'t', '2026-04-03', '9교시 지울 교시', false) as pdel \gset
select pg_temp.snap();
select save_attendance(:'t', :'pdel', format('{"%s":"late","%s":"absent"}', :'s1', :'s2')::jsonb); select pg_temp.snap();
select delete_period(:'t', :'pdel'); select pg_temp.snap();
select my_presets_save(:'t', '[{"name":"매점","points":-1}]'); select pg_temp.snap();
select ensure_period(:'t', '2026-04-02', '아침 출석', true) as p1 \gset
select pg_temp.snap();
select save_attendance(:'t', :'p1', format('{"%s":"late","%s":"absent"}', :'s1', :'s2')::jsonb); select pg_temp.snap();
select save_attendance(:'t', :'p1', format('{"%s":"absent","%s":"late"}', :'s2', :'s3')::jsonb); select pg_temp.snap();
select ensure_period(:'ct', '2026-04-02', '1교시', false) as p2 \gset
select pg_temp.snap();
select request_attendance(:'ct', :'p2', format('{"%s":"late"}', :'s4')::jsonb) as ar1 \gset
select pg_temp.snap();
select request_attendance(:'pt', :'p2', format('{"%s":"absent","%s":"excused"}', :'s4', :'s1')::jsonb) as ar2 \gset
select pg_temp.snap();
select request_attendance(:'ct', :'p2', format('{"%s":"absent"}', :'s1')::jsonb); select pg_temp.snap();
select review_attendance(:'t', :'ar1', false, '중복'); select pg_temp.snap();
select review_attendance(:'t', :'ar2', true, null); select pg_temp.snap();
select add_entries(:'t', '2026-04-03', array[:'s1', :'s3']::uuid[], '실습실 뒷정리', '전원', 1.5); select pg_temp.snap();
select id as e1 from ledger where item = '실습실 뒷정리' and student_id = :'s1' \gset
select id as e3 from ledger where item = '실습실 뒷정리' and student_id = :'s3' \gset
select edit_entry(:'t', :'e1', '2026-04-04', '실습실 정리', '전원', 1, '오기'); select pg_temp.snap();
select void_entry(:'t', :'e3', '착오'); select pg_temp.snap();
select create_request(:'ot', '2026-04-04', array[:'s2', :'s4']::uuid[], '매점', '', -1, '도움', 'data:image/jpeg;base64,/9j/AAAA') as rq1 \gset
select pg_temp.snap();
select create_request(:'ct', '2026-04-04', array[:'s1']::uuid[], '결석', '', 2, '', null) as rq2 \gset
select pg_temp.snap();
select create_request(:'ct', '2026-04-04', array[:'s3']::uuid[], '지각', '', 1, '', null) as rq3 \gset
select pg_temp.snap();
select review_request(:'t', :'rq1', true, null); select pg_temp.snap();
select review_request(:'t', :'rq2', true, null); select pg_temp.snap();
select review_request(:'t', :'rq3', false, '사실 아님'); select pg_temp.snap();
select id as late2 from ledger where period_id = :'p1' and student_id = :'s3' and voided_at is null \gset
select id as req_abs from ledger where request_id = :'rq2' \gset
select create_excuse(:'s3', :'late2', '병원', 'data:image/jpeg;base64,/9j/BBBB') as x1 \gset
select pg_temp.snap();
select create_excuse(:'s1', :'req_abs', '', null) as x2 \gset
select pg_temp.snap();
select review_excuse(:'t', :'x1', true, null); select pg_temp.snap();
select review_excuse(:'t', :'x2', false, '증빙 없음'); select pg_temp.snap();
select roster_apply(:'t', format('[{"op":"renum","id":"%s","no":2},{"op":"renum","id":"%s","no":1},{"op":"rename","id":"%s","name":"다다"},{"op":"remove","id":"%s"}]',
  :'s1', :'s2', :'s3', :'s4')::jsonb, '[{"name":"가","to":10}]', '2026-04-05');
select pg_temp.snap();
select roster_apply(:'t', format('[{"op":"restore","id":"%s","no":7},{"op":"add","name":"마","no":8}]', :'s4')::jsonb, '[{"name":"마","to":3}]', '2026-04-05');
select pg_temp.snap();
select add_entries(:'t', '2026-04-06', array[:'s4']::uuid[], '실습', '', -0.5); select pg_temp.snap();
select roster_apply(:'t', format('[{"op":"exempt","id":"%s","on":true}]', :'s2')::jsonb, '[]', '2026-04-06'); select pg_temp.snap();
select save_attendance(:'t', :'p2', format('{"%s":"late"}', :'s2')::jsonb); select pg_temp.snap();

select pg_temp.ok((select count(*) from sigs) = (select count(*) from ops) + 1, '작업마다 시점 하나 (+ 맨 처음)');
select pg_temp.ok((select array_agg(distinct kind order by kind) from ops) = array['add_entries', 'create_excuse', 'create_request', 'delete_period', 'edit_entry', 'ensure_period',
  'my_periods_save', 'my_presets_save', 'request_attendance', 'review_attendance', 'review_excuse', 'review_request', 'roster_apply', 'save_attendance', 'void_entry'],
  '데이터를 바꾸는 함수 15종 모두 사용');
select max(op) as last from sigs \gset
select count(*) as nops from ops \gset
\echo 시나리오 준비 (작업 :nops 개)

-- ───────── 모든 시점으로 이동 ─────────
-- 미리보기와 실제 이동 결과가 같은지, 이동 뒤 데이터가 그 시점과 같은지, 작업 목록이 그대로인지 본다.
create or replace function pg_temp.go(p_target bigint, p_label text) returns void language plpgsql as $$
declare pv json; before jsonb; n int; tok uuid := current_setting('tt.t')::uuid; nops bigint := (select count(*) from ops);
begin
  if not exists (select 1 from ops where (id > p_target and not undone) or (id <= p_target and undone)) then
    perform pg_temp.ok(pg_temp.sig() = (select sig from sigs where op = p_target), p_label || ': 이미 그 시점');
    return;
  end if;
  before := _snap();
  pv := history_move(tok, p_target, true);
  perform pg_temp.ok(_snap() = before, p_label || ': 미리보기는 바꾸지 않음');
  perform history_move(tok, p_target, false);
  perform pg_temp.ok(pg_temp.sig() = (select sig from sigs where op = p_target), format('%s: 작업 %s 직후와 같음', p_label, p_target));
  select count(*) into n from ledger where voided_at is null;
  perform pg_temp.ok((pv -> 'ledger' ->> 'after')::int = n, p_label || ': 미리보기의 기록 수 = 실제');
  perform pg_temp.ok(_snap_diff(before, _snap())::jsonb = (pv -> 'students')::jsonb, p_label || ': 미리보기의 학생 변화 = 실제');
  perform pg_temp.ok((select count(*) from ops) = nops and not exists (select 1 from ops where kind = 'scratch'), p_label || ': 이동 흔적 없음');
  perform pg_temp.ok((select count(*) from ops where not undone) = (select count(*) from ops where id <= p_target), p_label || ': 시점 앞은 적용, 뒤는 되돌림');
end $$;

select pg_temp.go(op, '거꾸로 한 칸씩') from (select op from sigs order by op desc) x;
\echo 맨 끝에서 맨 처음까지 한 칸씩 뒤로 통과
select pg_temp.go(op, '차례로 한 칸씩') from (select op from sigs order by op) x;
\echo 맨 처음에서 맨 끝까지 한 칸씩 앞으로 통과
select pg_temp.go(op, '뒤섞어') from (select op from sigs, generate_series(1, 3) g order by md5(op::text || g)) x;
select pg_temp.go(:last, '맨 끝으로');
\echo 뒤섞은 순서로 모든 시점 이동 통과

-- ───────── 작업마다 이 작업만 되돌리기 → 다시 살리기 ─────────
-- 되면: 미리보기와 같고, 빼 둔 채 맨 처음·맨 끝을 오가도 빼 둔 상태가 유지되고, 다시 살리면 원래대로.
-- 안 되면: 뒤의 작업과 겹친 경우(P0002)뿐이고 아무것도 바뀌지 않는다.
create temp table drops (op bigint, result text);
do $$
declare r record; tok uuid := current_setting('tt.t')::uuid; pv json; before jsonb; s_end text := pg_temp.sig(); s_drop text; st text;
begin
  for r in select id from ops order by id desc loop
    before := _snap();
    st := null;
    begin pv := history_drop(tok, r.id, true); exception when others then st := sqlstate; end;
    if st is not null then
      if st <> 'P0002' then raise exception 'FAIL: 작업 %의 이 작업만 되돌리기 미리보기: 오류 %', r.id, st; end if;
      perform pg_temp.ok(pg_temp.sig() = s_end, '겹쳐서 멈추면 그대로');
      insert into drops values (r.id, 'conflict');
      continue;
    end if;
    perform pg_temp.ok(pg_temp.sig() = s_end, '이 작업만 되돌리기 미리보기는 바꾸지 않음');
    perform history_drop(tok, r.id, false);
    perform pg_temp.ok(_snap_diff(before, _snap())::jsonb = (pv -> 'students')::jsonb, format('작업 %s 빼기: 미리보기 = 실제', r.id));
    perform pg_temp.ok((select dropped and not undone from ops where id = r.id), '빼 둠 표시');
    s_drop := pg_temp.sig();
    perform pg_temp.ok(s_drop <> s_end, format('작업 %s 빼면 데이터가 바뀜', r.id));
    perform history_move(tok, 0, false);
    perform pg_temp.ok(pg_temp.sig() = (select sig from sigs where op = 0), format('작업 %s 빼 둔 채 맨 처음', r.id));
    perform history_move(tok, (select max(id) from ops), false);
    perform pg_temp.ok(pg_temp.sig() = s_drop, format('작업 %s 빼 둔 채 다시 맨 끝 (빼 둔 작업은 적용 안 됨)', r.id));
    perform history_restore(tok, r.id, false);
    perform pg_temp.ok(pg_temp.sig() = s_end and not exists (select 1 from ops where dropped or undone), format('작업 %s 다시 살리면 원래대로', r.id));
    insert into drops values (r.id, 'ok');
  end loop;
end $$;
select count(*) filter (where result = 'ok') as nok, count(*) filter (where result = 'conflict') as nconf from drops \gset
select pg_temp.ok(:nok >= 10, '대부분의 작업은 하나만 되돌릴 수 있음');
-- 뒤 작업이 같은 기록을 바꾼 작업은 반드시 겹침으로 멈춰야 한다
select pg_temp.ok((select result from drops where op = (select min(id) from ops)) = 'conflict', '명단 추가(뒤에서 번호·이름을 바꿈)는 하나만 되돌릴 수 없음');
-- 뒤 작업이 이 작업이 넣은 행을 지운 경우도 (지워진 행은 건너뛰니 _apply_op만으로는 모른다)
select pg_temp.ok((select result from drops where op = (select min(id) from ops where kind = 'my_presets_save' and actor = '부총대')) = 'conflict', '뒤에서 다시 저장한 항목 저장은 하나만 되돌릴 수 없음');
select pg_temp.ok((select result from drops d join ops o on o.id = d.op where o.summary like '요청: 결석%') = 'conflict', '승인된 요청의 작성은 하나만 되돌릴 수 없음');
select pg_temp.ok(pg_temp.sig() = (select sig from sigs where op = :last) and (select count(*) from ops) = :nops, '끝나고 원래 상태');
select string_agg(o.id || ' ' || o.summary, E'\n' order by o.id) as conf_list from drops d join ops o on o.id = d.op where d.result = 'conflict' \gset
\echo 하나만 되돌릴 수 없는 작업 (뒤 작업과 겹침):
\echo :conf_list
\echo 이 작업만 되돌리기·다시 살리기 (되돌림 :nok 개, 겹쳐서 멈춤 :nconf 개) 통과

-- ───────── 여러 작업을 빼 둔 채 오가기 ─────────
do $$
declare tok uuid := current_setting('tt.t')::uuid; ids bigint[]; x bigint; s_end text := pg_temp.sig(); s_all text;
begin
  select array_agg(op order by op desc) into ids from (select op from drops where result = 'ok' order by op desc limit 4) d;
  foreach x in array ids loop perform history_drop(tok, x, false); end loop;
  s_all := pg_temp.sig();
  perform history_move(tok, 0, false);
  perform history_move(tok, (select max(id) from ops), false);
  perform pg_temp.ok(pg_temp.sig() = s_all, '여러 개 빼 둔 채 맨 처음에 갔다 오기');
  foreach x in array ids loop perform history_restore(tok, x, false); end loop;
  perform pg_temp.ok(pg_temp.sig() = s_end, '모두 다시 살리기');
end $$;
\echo 여러 작업 빼 둔 채 이동 통과

\echo 작업 내역 전수 테스트 통과
