-- 25학번 자봉 장부 — Supabase 스키마
--
-- Supabase 대시보드 → SQL Editor에 이 파일 전체를 붙여넣고 한 번 실행한다.
-- 그다음 README의 "처음 설정" 절차대로 init_app()을 실행해 비밀번호와 복구 코드를 만든다.
--
-- 설계 원칙
-- * 브라우저(anon 키)는 테이블을 직접 읽거나 쓰지 못한다. 모든 읽기·쓰기는 아래 함수(RPC)로만 한다.
-- * 공개 함수(public_state)는 번호와 자봉 내역만 내보낸다. 이름·기록자·요청자는 로그인한 사람에게만 준다.
-- * 기록은 지우지 않는다. 수정은 ledger_revisions에, 무효 처리는 voided_at에 남는다.
--   예외는 purge()뿐이며, 그때도 학생별 "이월" 기록으로 점수를 보존한다.
-- * 어떤 데이터가 바뀌면 app_version.version이 올라가고, 브라우저는 Realtime으로 이를 받아 새로 불러온다.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ───────────────────────── 테이블 ─────────────────────────

create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  no int not null check (no > 0),
  name text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
-- 재학 중인 학생끼리만 번호가 겹치면 안 된다 (제외된 학생의 옛 번호는 재사용 가능)
create unique index if not exists students_no_active on students (no) where active;
-- 자봉 면제 (총대단 중 일부): 출석·직접 기록·요청으로 들어오는 +점수는 기록하지 않고, 상점(−)만 받는다
alter table students add column if not exists exempt boolean not null default false;

-- 자주 쓰는 항목. 직책(owner)마다 따로 두는 "내 항목"이다. 공용 항목은 없다.
create table if not exists presets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  points int not null,
  sort int not null default 0
);
alter table presets add column if not exists owner text;
-- kind: 'item'(항목명·점수) 또는 'period'(출석 교시 이름, 점수 0)
alter table presets add column if not exists kind text not null default 'item';

create table if not exists periods (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  label text not null,
  morning boolean not null default false,
  saved_at timestamptz,
  unique (date, label)
);

create table if not exists attendance (
  period_id uuid not null references periods on delete cascade,
  student_id uuid not null references students on delete cascade,
  status text not null check (status in ('late', 'absent', 'excused')),
  primary key (period_id, student_id)
);

-- (0.5점 도입 전에 만든 DB라면) 점수 칸을 0.5 단위로 바꾸고, 정수 버전 함수를 지운다
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'ledger' and column_name = 'points' and data_type = 'integer') then
    alter table ledger alter column points type numeric(7,1);
    alter table ledger add constraint ledger_points_half check (points * 2 = trunc(points * 2));
    alter table requests alter column points type numeric(7,1);
    alter table requests add constraint requests_points_half check (points * 2 = trunc(points * 2));
  end if;
end $$;
drop function if exists _entry(date, uuid, text, text, int, text, uuid, uuid, text, text, text);
drop function if exists _check_items(text, int);
drop function if exists create_request(uuid, date, uuid[], text, text, int, text, text);
drop function if exists add_entries(uuid, date, uuid[], text, text, int);
drop function if exists edit_entry(uuid, uuid, date, text, text, int, text);

-- 공개되는 기록 본문. 누가 기록·요청했는지는 ledger_private에 따로 둔다.
create table if not exists ledger (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  student_id uuid not null references students on delete cascade,
  item text not null,
  detail text not null default '',
  points numeric(7,1) not null check (points * 2 = trunc(points * 2)),
  src text not null check (src in ('att', 'manual', 'request', 'import', 'carry')),
  period_id uuid references periods on delete set null,
  request_id uuid,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text
);
alter table ledger drop constraint if exists ledger_src_check;
alter table ledger add constraint ledger_src_check check (src in ('att', 'manual', 'request', 'import', 'carry', 'reaction'));
create index if not exists ledger_student on ledger (student_id);
create index if not exists ledger_date on ledger (date);
create index if not exists ledger_period on ledger (period_id);

create table if not exists ledger_private (
  ledger_id uuid primary key references ledger on delete cascade,
  created_by text,
  requested_by text,
  approved_by text,
  voided_by text
);

create table if not exists ledger_revisions (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references ledger on delete cascade,
  before jsonb not null,
  after jsonb not null,
  reason text not null,
  edited_by text,
  edited_at timestamptz not null default now()
);

-- 증빙 사진 (브라우저에서 줄인 JPEG data URL). 처리 180일 뒤 자동 삭제된다.
create table if not exists photos (
  id uuid primary key default gen_random_uuid(),
  data text not null,
  created_at timestamptz not null default now()
);

create table if not exists requests (
  id uuid primary key default gen_random_uuid(),
  requested_by text not null,
  date date not null,
  student_ids uuid[] not null,
  item text not null,
  detail text not null default '',
  points numeric(7,1) not null check (points * 2 = trunc(points * 2)),
  reason text not null default '',
  photo_id uuid references photos on delete set null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by text,
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create table if not exists excuses (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students on delete cascade,
  ledger_id uuid references ledger on delete set null,
  reason text not null default '',
  photo_id uuid references photos on delete set null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by text,
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

-- 총대단이 보낸 출석 요청. 부총대가 승인하면 그 교시의 출석으로 저장된다.
-- 리액션 상점 신청: 학생이 수업 중 대답한 것을 그날 안에 적어 내고, 부총대가 승인한다.
-- 승인된 리액션 3개마다 상점 1점(-1, src 'reaction'). 남는 것은 다음으로 이월된다.
create table if not exists reactions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students on delete cascade,
  date date not null,
  period text not null,
  question text not null,
  answer text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  -- 이 리액션이 들어간 상점 기록 id (3개씩 묶인다). 외래키가 아니다: 정리로 그 기록이 지워져도 "이미 상점이 됨"은 남아야 한다
  merit uuid,
  reviewed_by text,
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists reactions_student_date on reactions (student_id, date);
-- adj: 부총대가 이월 횟수를 맞추려고 넣은 줄 (엑셀로 정리하던 이월을 옮길 때). 실제 리액션이 아니라 내역에는 안 보인다.
alter table reactions add column if not exists adj boolean not null default false;

-- 화면의 바로가기 링크 (id: 'store' = 학급 매점). 부총대가 관리 탭에서 바꾸고, 누구나 본다.
create table if not exists links (
  id text primary key,
  url text not null
);

-- 하루 전체 공결: 그날의 지각·결석마다 한 줄씩 만들고 같은 grp로 묶는다 (승인·반려도 묶음째)
alter table excuses add column if not exists grp uuid;
create index if not exists excuses_grp on excuses (grp) where grp is not null;

create table if not exists attendance_requests (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references periods on delete cascade,
  statuses jsonb not null default '{}',
  requested_by text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by text,
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

-- 작업 로그 (뒤로가기·앞으로 가기용). 서버 함수 하나를 부를 때마다 ops 한 줄이 생기고,
-- 그 작업이 바꾼 행의 전·후가 op_changes에 남는다 (트리거 _log_change).
-- 작업들은 한 줄로 이어진 시간선이다. 뒤로 가면 최근 작업부터 undone이 되고, 앞으로 가면 다시 적용된다.
-- 뒤로 간 상태에서 새 작업을 하면 undone 작업들(앞으로 갈 수 있던 것)은 지워진다.
create table if not exists ops (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  kind text not null,
  summary text not null,
  undoable boolean not null default true,
  undone boolean not null default false,
  dropped boolean not null default false
);
-- 예전(되돌리기 작업을 따로 남기던) 방식의 로그는 새 방식과 맞지 않으니 비우고 칸을 정리한다
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'ops' and column_name = 'undone_by') then
    delete from ops where true;
    alter table ops drop column undone_by, drop column if exists undo_of, drop column if exists meta;
  end if;
end $$;
alter table ops add column if not exists undone boolean not null default false;
-- "이 작업만 되돌리기"로 빼 둔 작업. 데이터에는 적용되지 않은 채 목록에 남아 "다시 살리기"를 기다린다.
alter table ops add column if not exists dropped boolean not null default false;
create table if not exists op_changes (
  id bigserial primary key,
  op_id bigint not null references ops on delete cascade,
  tbl text not null,
  row_key jsonb not null,
  action char(1) not null check (action in ('I', 'U', 'D')),
  before jsonb,
  after jsonb
);
-- (op_id, id): 이동 중 "이번 작업에서 새로 바뀐 행"을 id 범위로 바로 찾는다
drop index if exists op_changes_op;
create index if not exists op_changes_op_id on op_changes (op_id, id);
create index if not exists op_changes_row on op_changes (tbl, row_key);
-- 학생 표에 칸(exempt)이 생기기 전의 작업 기록은 그 칸이 없어서 지금 행과 비교가 어긋난다. 기본값으로 채운다.
update op_changes set before = case when before is not null and not before ? 'exempt' then before || '{"exempt": false}' else before end,
  after = case when after is not null and not after ? 'exempt' then after || '{"exempt": false}' else after end
where tbl = 'students' and ((before is not null and not before ? 'exempt') or (after is not null and not after ? 'exempt'));
-- 리액션 표에 adj 칸이 생기기 전의 작업 기록도
update op_changes set before = case when before is not null and not before ? 'adj' then before || '{"adj": false}' else before end,
  after = case when after is not null and not after ? 'adj' then after || '{"adj": false}' else after end
where tbl = 'reactions' and ((before is not null and not before ? 'adj') or (after is not null and not after ? 'adj'));
-- 공결 표에 grp 칸이 생기기 전의 작업 기록도
update op_changes set before = case when before is not null and not before ? 'grp' then before || '{"grp": null}' else before end,
  after = case when after is not null and not after ? 'grp' then after || '{"grp": null}' else after end
where tbl = 'excuses' and ((before is not null and not before ? 'grp') or (after is not null and not after ? 'grp'));
-- 항목 표에 kind 칸이 생기기 전의 작업 기록도 같은 방식으로 채운다
update op_changes set before = case when before is not null and not before ? 'kind' then before || '{"kind": "item"}' else before end,
  after = case when after is not null and not after ? 'kind' then after || '{"kind": "item"}' else after end
where tbl = 'presets' and ((before is not null and not before ? 'kind') or (after is not null and not after ? 'kind'));

-- 직책별 계정. role이 곧 화면에 보이는 이름이다.
create table if not exists accounts (
  role text primary key,
  is_admin boolean not null,
  sort int not null default 0,
  pw_hash text,
  fails int not null default 0,
  locked_until timestamptz
);

create table if not exists sessions (
  token uuid primary key default gen_random_uuid(),
  role text not null references accounts on delete cascade,
  expires_at timestamptz not null
);

create table if not exists settings (
  id int primary key default 1 check (id = 1),
  recovery_hash text,
  recovery_fails int not null default 0,
  recovery_locked_until timestamptz
);
insert into settings (id) values (1) on conflict do nothing;

-- 변경 알림 전용. 브라우저가 Realtime으로 구독하는 유일한 테이블이라 비밀 정보를 두지 않는다.
create table if not exists app_version (
  id int primary key default 1 check (id = 1),
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into app_version (id) values (1) on conflict do nothing;

insert into accounts (role, is_admin, sort) values
  ('부총대', true, 1), ('총대', false, 2),
  ('실습부장 1', false, 3), ('실습부장 2', false, 4), ('운영부장', false, 5),
  ('총무', false, 6), ('학습부장', false, 7), ('정리부장', false, 8), ('치아부장', false, 9)
on conflict do nothing;

-- 관리자는 부총대 한 명이다. 총대는 총대단이다 (예전 DB는 여기서 바뀐다).
update accounts set is_admin = false where role = '총대' and is_admin;
-- 출석 요청을 보낼 수 있는 총대단: 실습부장 1·2와 총대 (고정)
alter table accounts add column if not exists can_attend boolean not null default false;
update accounts set can_attend = (role in ('실습부장 1', '실습부장 2', '총대')) where true;

-- 처음 만들 때는 부총대의 항목으로 기본 목록을 넣는다. 예전의 공용 항목도 부총대 항목이 된다.
insert into presets (name, points, sort, owner)
select v.*, '부총대' from (values ('지각', 1, 1), ('결석', 2, 2), ('실습실 뒷정리 미흡', 1, 3), ('실습', 1, 4), ('소치 실습', 1, 5), ('매점', -1, 6)) v
where not exists (select 1 from presets);
update presets set owner = '부총대' where owner is null;

-- ───────────────────────── 권한 ─────────────────────────
-- 테이블은 모두 잠그고, app_version만 Realtime 알림용으로 읽기를 연다.

alter table students enable row level security;
alter table presets enable row level security;
alter table links enable row level security;
alter table periods enable row level security;
alter table attendance enable row level security;
alter table ledger enable row level security;
alter table ledger_private enable row level security;
alter table ledger_revisions enable row level security;
alter table photos enable row level security;
alter table requests enable row level security;
alter table excuses enable row level security;
alter table attendance_requests enable row level security;
alter table reactions enable row level security;
alter table ops enable row level security;
alter table op_changes enable row level security;
alter table accounts enable row level security;
alter table sessions enable row level security;
alter table settings enable row level security;
alter table app_version enable row level security;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'grant select on app_version to anon, authenticated';
  end if;
end $$;
drop policy if exists app_version_read on app_version;
create policy app_version_read on app_version for select using (true);

-- 데이터가 바뀔 때마다 버전을 올려 브라우저에 알린다
create or replace function _bump() returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- 작업 내역 이동 중에는 문장마다 올리지 않고 끝에 한 번만 올린다 (수천 번 같은 행을 고치면 몇 초가 걸린다)
  if current_setting('jabong.moving', true) = 'on' then return null; end if;
  update app_version set version = version + 1, updated_at = now() where id = 1;
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['students','presets','periods','attendance','ledger','ledger_revisions','requests','excuses','attendance_requests','reactions','links'] loop
    execute format('drop trigger if exists bump on %I', t);
    execute format('create trigger bump after insert or update or delete on %I for each statement execute function _bump()', t);
  end loop;
end $$;

-- 바뀐 행을 지금 작업(jabong.op)에 기록한다. 작업 밖(SQL Editor 등)의 변경은 기록하지 않는다.
-- 외래키 연쇄 삭제로 바뀐 자식 행은 부모 행보다 나중에 기록된다. _apply_op가 교시 삭제의 순서를 따로 맞춘다.
create or replace function _log_change() returns trigger language plpgsql security definer set search_path = public as $$
declare
  op bigint := nullif(current_setting('jabong.op', true), '')::bigint;
  r jsonb := coalesce(to_jsonb(NEW), to_jsonb(OLD));
  pk text[] := case TG_TABLE_NAME when 'attendance' then array['period_id', 'student_id'] when 'ledger_private' then array['ledger_id'] else array['id'] end;
begin
  if op is null then return null; end if;
  if TG_OP = 'UPDATE' and to_jsonb(OLD) = to_jsonb(NEW) then return null; end if;
  insert into op_changes (op_id, tbl, row_key, action, before, after)
  values (op, TG_TABLE_NAME, (select jsonb_object_agg(c, r -> c) from unnest(pk) c), left(TG_OP, 1),
    case when TG_OP <> 'INSERT' then to_jsonb(OLD) end, case when TG_OP <> 'DELETE' then to_jsonb(NEW) end);
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['students','presets','periods','attendance','ledger','ledger_private','ledger_revisions','requests','excuses','attendance_requests','reactions','links'] loop
    execute format('drop trigger if exists zz_log on %I', t);
    execute format('create trigger zz_log after insert or update or delete on %I for each row execute function _log_change()', t);
  end loop;
end $$;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'app_version') then
    execute 'alter publication supabase_realtime add table app_version';
  end if;
end $$;

-- ───────────────────────── 내부 도우미 ─────────────────────────

create or replace function _kst(t timestamptz) returns text language sql immutable as $$
  select to_char(t at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI')
$$;

create or replace function _norm_code(c text) returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(c, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

create or replace function _new_code() returns text language plpgsql set search_path = public, extensions as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  b bytea := gen_random_bytes(12);
  r text := '';
begin
  for i in 0..11 loop
    r := r || substr(chars, (get_byte(b, i) % 32) + 1, 1);
    if i in (3, 7) then r := r || '-'; end if;
  end loop;
  return r;
end $$;

-- 토큰을 확인하고 직책 이름을 돌려준다
create or replace function _session(p_token uuid, p_admin boolean) returns text
language plpgsql security definer set search_path = public as $$
declare r text; adm boolean;
begin
  select s.role, a.is_admin into r, adm
  from sessions s join accounts a on a.role = s.role
  where s.token = p_token and s.expires_at > now();
  if r is null then raise exception '로그인이 끊겼어요. 다시 로그인해 주세요' using errcode = '28000'; end if;
  if p_admin and not adm then raise exception '부총대만 할 수 있어요' using errcode = '42501'; end if;
  return r;
end $$;

-- 출석은 부총대가 저장하고, 실습부장 1·2와 총대는 요청을 보낸다
create or replace function _session_attend(p_token uuid) returns text
language plpgsql security definer set search_path = public as $$
declare r text := _session(p_token, false);
begin
  if not exists (select 1 from accounts where role = r and (is_admin or can_attend)) then
    raise exception '출석을 요청할 수 있는 직책이 아니에요' using errcode = '42501';
  end if;
  return r;
end $$;

create or replace function _entry(p_date date, p_sid uuid, p_item text, p_detail text, p_points numeric, p_src text,
  p_period uuid, p_request uuid, p_by text, p_requested_by text default null, p_approved_by text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare nid uuid;
begin
  -- 자봉 면제 학생에게는 +점수를 기록하지 않는다 (명단 붙여넣기의 점수 맞추기·이월은 예외). 기록 안 하면 null.
  if p_points > 0 and p_src in ('att', 'manual', 'request') and (select exempt from students where id = p_sid) then return null; end if;
  insert into ledger (date, student_id, item, detail, points, src, period_id, request_id)
  values (p_date, p_sid, p_item, coalesce(p_detail, ''), p_points, p_src, p_period, p_request)
  returning id into nid;
  insert into ledger_private (ledger_id, created_by, requested_by, approved_by)
  values (nid, p_by, p_requested_by, p_approved_by);
  return nid;
end $$;

create or replace function _void(p_id uuid, p_reason text, p_by text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update ledger set voided_at = now(), void_reason = p_reason where id = p_id and voided_at is null;
  update ledger_private set voided_by = p_by where ledger_id = p_id;
end $$;

create or replace function _photo(p_data text) returns uuid language plpgsql security definer set search_path = public as $$
declare nid uuid;
begin
  if p_data is null or p_data = '' then return null; end if;
  if p_data !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' then raise exception '사진 형식이 올바르지 않아요'; end if;
  if length(p_data) > 400000 then raise exception '사진이 너무 커요'; end if;
  insert into photos (data) values (p_data) returning id into nid;
  return nid;
end $$;

-- 처리 180일이 지난 증빙 사진과 만료된 로그인을 지운다
create or replace function _cleanup() returns void language plpgsql security definer set search_path = public as $$
begin
  delete from photos where id in (
    select photo_id from requests where photo_id is not null and status <> 'pending' and reviewed_at < now() - interval '180 days'
    union
    select photo_id from excuses where photo_id is not null and status <> 'pending' and reviewed_at < now() - interval '180 days'
  );
  delete from sessions where expires_at < now();
end $$;

create or replace function _check_items(p_item text, p_points numeric) returns void language plpgsql as $$
begin
  if coalesce(trim(p_item), '') = '' then raise exception '항목명을 입력하세요'; end if;
  if p_points is null or p_points = 0 or p_points * 2 <> trunc(p_points * 2) then
    raise exception '점수는 0이 아닌 0.5점 단위로 적어 주세요';
  end if;
end $$;

-- 작업을 시작한다. 이후 이 트랜잭션에서 바뀐 행은 모두 이 작업에 기록된다.
-- 되돌릴 수 없는 작업(정리·되살리기)은 행 변경을 기록하지 않는다.
-- 데이터를 바꾸는 함수는 모두 맨 처음에 이 잠금을 잡는다. 동시에 들어온 작업이 한 줄로 서서
-- (교시 삭제와 출석 저장이 겹치거나, 작업 내역 이동 중에 다른 작업이 끼어드는 일이 없게) 차례로 처리된다.
-- 행 잠금보다 먼저 잡아야 서로 기다리다 멈추는 일(교착)이 없다.
create or replace function _wlock() returns void language sql security definer set search_path = public as $$
  select pg_advisory_xact_lock(7243)
$$;

create or replace function _op(p_actor text, p_kind text, p_summary text, p_undoable boolean default true) returns bigint
language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  perform _wlock();
  -- 뒤로 간 상태에서 새 작업을 하면, 앞으로 갈 수 있던 작업들은 버린다
  delete from ops where undone;
  insert into ops (actor, kind, summary, undoable) values (p_actor, p_kind, p_summary, p_undoable) returning id into nid;
  perform set_config('jabong.op', case when p_undoable then nid::text else '' end, true);
  return nid;
end $$;

create or replace function _pt(p numeric) returns text language sql immutable as $$
  select case when p > 0 then '+' else '' end || regexp_replace(p::text, '\.0$', '')
$$;
create or replace function _nums(p_sids uuid[]) returns text language sql stable security definer set search_path = public as $$
  select coalesce(string_agg(no::text, ' ' order by no), '') from students where id = any (p_sids)
$$;
create or replace function _per(p_period uuid) returns text language sql stable security definer set search_path = public as $$
  select to_char(date, 'FMMM/FMDD') || ' ' || label from periods where id = p_period
$$;
create or replace function _attn(p_statuses jsonb) returns text language sql immutable as $$
  select format('지각 %s · 결석 %s · 공결 %s',
    (select count(*) from jsonb_each_text(coalesce(p_statuses, '{}')) where value = 'late'),
    (select count(*) from jsonb_each_text(coalesce(p_statuses, '{}')) where value = 'absent'),
    (select count(*) from jsonb_each_text(coalesce(p_statuses, '{}')) where value = 'excused'))
$$;

-- 이월을 줄일 때 실제 리액션에 붙이는 표시 ("상점은 안 됐지만 이월에서 뺌")
create or replace function _merit_cleared() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-000000000000'::uuid $$;

-- 화면이 쓰는 전체 상태를 JSON 하나로 만든다. p_private가 아니면 이름·기록자를 뺀다.
create or replace function _state(p_private boolean) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'students', (select coalesce(json_agg(case when p_private
        then json_build_object('id', id, 'no', no, 'name', name, 'active', active, 'exempt', exempt)
        else json_build_object('id', id, 'no', no, 'active', active, 'exempt', exempt) end order by active desc, no), '[]')
      from students),
    'presets', (select coalesce(json_agg(json_build_object('id', id, 'name', name, 'points', points, 'owner', owner, 'kind', kind) order by sort, name), '[]') from presets),
    'periods', (select coalesce(json_agg(json_build_object('id', id, 'date', date, 'label', label, 'morning', morning, 'savedAt', _kst(saved_at))
      order by date, morning desc, nullif(substring(label from '^[0-9]{1,9}'), '')::int nulls last, label), '[]') from periods),
    -- 명단에서 빠진 학생의 출결은 표에는 남기되(다시 들어오면 쓴다) 화면에는 싣지 않는다 (출석 화면의 지각·결석 수에 섞이지 않게)
    'att', (select coalesce(json_object_agg(p.id, (select coalesce(json_object_agg(a.student_id, a.status), '{}') from attendance a
        join students s on s.id = a.student_id and s.active where a.period_id = p.id)), '{}')
      from periods p where p.saved_at is not null),
    'ledger', (select coalesce(json_agg(json_build_object(
        'id', l.id, 'date', l.date, 'sid', l.student_id, 'item', l.item, 'detail', l.detail, 'points', l.points,
        'src', l.src, 'pid', l.period_id, 'at', _kst(l.created_at),
        'by', case when p_private then case when l.src = 'request' then lp.requested_by else lp.created_by end end,
        'requestedBy', case when p_private then lp.requested_by end,
        'approvedBy', case when p_private then lp.approved_by end,
        'voided', case when l.voided_at is null then null else json_build_object(
          'reason', l.void_reason, 'at', _kst(l.voided_at), 'by', case when p_private then lp.voided_by end) end,
        'revs', (select coalesce(json_agg(json_build_object('at', _kst(r.edited_at), 'before', r.before, 'after', r.after,
            'reason', r.reason, 'by', case when p_private then r.edited_by end) order by r.edited_at), '[]')
          from ledger_revisions r where r.ledger_id = l.id)
      ) order by l.date, l.created_at), '[]')
      from ledger l left join ledger_private lp on lp.ledger_id = l.id),
    'excuses', (select coalesce(json_agg(json_build_object(
        'id', x.id, 'sid', x.student_id, 'eid', x.ledger_id, 'grp', x.grp, 'reason', x.reason, 'status', x.status,
        'note', x.review_note, 'at', _kst(x.created_at),
        'reviewer', case when p_private then x.reviewed_by end,
        'reviewedAt', case when p_private then _kst(x.reviewed_at) end,
        'photo', case when p_private and x.photo_id is not null then x.photo_id end
      ) order by x.created_at), '[]') from excuses x),
    'requests', case when p_private then (select coalesce(json_agg(json_build_object(
        'id', r.id, 'by', r.requested_by, 'date', r.date, 'sids', r.student_ids, 'item', r.item, 'detail', r.detail,
        'points', r.points, 'reason', r.reason, 'photo', r.photo_id, 'status', r.status, 'note', r.review_note,
        'reviewer', r.reviewed_by, 'reviewedAt', _kst(r.reviewed_at), 'at', _kst(r.created_at)
      ) order by r.created_at), '[]') from requests r) else '[]'::json end,
    'attRequests', case when p_private then (select coalesce(json_agg(json_build_object(
        'id', a.id, 'pid', a.period_id, 'statuses', a.statuses, 'by', a.requested_by, 'status', a.status,
        'note', a.review_note, 'reviewer', a.reviewed_by, 'at', _kst(a.created_at), 'reviewedAt', _kst(a.reviewed_at)
      ) order by a.created_at), '[]') from attendance_requests a) else '[]'::json end,
    -- 리액션: 글(질문·대답)은 부총대 화면에만, 대기 중인 것과 최근 14일 처리한 것. 학생 화면은 my_reactions로 자기 것만 받는다.
    -- (모두 싣으면 학기 중에 수 MB가 되어, 바뀔 때마다 모든 폰이 다시 받는다)
    'reactions', case when p_private then (select coalesce(json_agg(json_build_object(
        'id', x.id, 'sid', x.student_id, 'date', x.date, 'period', x.period, 'q', x.question, 'a', x.answer,
        'status', x.status, 'note', x.review_note, 'merit', x.merit is not null and x.merit <> _merit_cleared(), 'at', _kst(x.created_at),
        'reviewer', x.reviewed_by, 'reviewedAt', _kst(x.reviewed_at)
      ) order by x.created_at, x.id), '[]') from reactions x
      where not x.adj and (x.status = 'pending' or x.reviewed_at >= now() - interval '14 days')) else '[]'::json end,
    'reactProg', (select coalesce(json_object_agg(student_id, n), '{}') from
      (select student_id, count(*) as n from reactions where status = 'approved' and merit is null group by student_id) t),
    'ver', (select version from app_version where id = 1),
    'today', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD'),
    'accounts', (select json_agg(json_build_object('role', role, 'admin', is_admin, 'attend', is_admin or can_attend) order by sort) from accounts),
    -- 맨 위 작업 (부총대 화면의 "되돌리기" 버튼이 방금 한 작업인지 알아보는 데 쓴다)
    'lastOp', case when p_private then (select json_build_object('id', id, 'actor', actor, 'undoable', undoable, 'undone', undone, 'dropped', dropped)
      from ops where kind <> 'scratch' order by id desc limit 1) end,
    'links', (select coalesce(json_object_agg(id, url), '{}') from links),
    'updatedAt', (select _kst(updated_at) from app_version where id = 1)
  )
$$;

-- ───────────────────────── 공개 함수 (로그인 없이) ─────────────────────────

create or replace function public_state() returns json language sql stable security definer set search_path = public as $$
  select _state(false)
$$;

create or replace function create_excuse(p_student uuid, p_ledger uuid, p_reason text, p_photo text) returns uuid
language plpgsql security definer set search_path = public as $$
declare nid uuid;
begin
  perform _wlock();
  -- 출석 체크로 생긴 것뿐 아니라 직접 기록하거나 요청으로 들어온 지각·결석도 공결 신청할 수 있다
  if not exists (select 1 from ledger where id = p_ledger and student_id = p_student and voided_at is null
      and item in ('지각', '결석') and src in ('att', 'manual', 'request')) then
    raise exception '공결 신청할 수 있는 출결 기록이 아니에요';
  end if;
  if exists (select 1 from excuses where ledger_id = p_ledger and status = 'pending') then
    raise exception '이미 신청해서 확인을 기다리는 중이에요';
  end if;
  perform _op((select no from students where id = p_student) || '번 학생', 'create_excuse',
    format('공결 신청: %s번 %s %s', (select no from students where id = p_student),
      (select to_char(date, 'FMMM/FMDD') from ledger where id = p_ledger), (select item from ledger where id = p_ledger)));
  insert into excuses (student_id, ledger_id, reason, photo_id)
  values (p_student, p_ledger, left(coalesce(trim(p_reason), ''), 500), _photo(p_photo))
  returning id into nid;
  return nid;
end $$;

-- 하루 전체 공결 신청: 그날 공결 신청할 수 있는 지각·결석(이미 대기 중인 것은 빼고)을 한꺼번에. 사진은 한 장을 함께 쓴다.
create or replace function create_excuse_day(p_student uuid, p_date date, p_reason text, p_photo text) returns int
language plpgsql security definer set search_path = public as $$
declare g uuid := gen_random_uuid(); ph uuid; ids uuid[]; summ text;
begin
  perform _wlock();
  if p_date is null then raise exception '날짜를 고르세요'; end if;
  select array_agg(l.id order by l.created_at) into ids from ledger l
  where l.student_id = p_student and l.date = p_date and l.voided_at is null and l.item in ('지각', '결석') and l.src in ('att', 'manual', 'request')
    and not exists (select 1 from excuses x where x.ledger_id = l.id and x.status = 'pending');
  if ids is null then raise exception '그날 공결 신청할 지각·결석 기록이 없어요'; end if;
  select string_agg(format('%s %s', item, n), ' · ' order by item) into summ
    from (select item, count(*) n from ledger where id = any (ids) group by item) t;
  perform _op((select no from students where id = p_student) || '번 학생', 'create_excuse_day',
    format('하루 공결 신청: %s번 %s (%s)', (select no from students where id = p_student), to_char(p_date, 'FMMM/FMDD'), summ));
  ph := _photo(p_photo);
  insert into excuses (student_id, ledger_id, reason, photo_id, grp)
  select p_student, i, left(coalesce(trim(p_reason), ''), 500), ph, g from unnest(ids) with ordinality u(i, o) order by o;
  return array_length(ids, 1);
end $$;

-- 리액션 신청 (학생, 로그인 없음). 날짜는 서버의 한국 시각 오늘로 정한다 → 그날 안에만 낼 수 있다.
-- 하루 3번까지(반려된 것은 세지 않는다), 같은 날 같은 교시·같은 질문은 한 번.
create or replace function create_reaction(p_student uuid, p_period text, p_question text, p_answer text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  d date := (now() at time zone 'Asia/Seoul')::date; nid uuid; sno int;
  per text := trim(coalesce(p_period, '')); q text := trim(coalesce(p_question, '')); a text := trim(coalesce(p_answer, ''));
begin
  perform _wlock();
  select no into sno from students where id = p_student and active;
  if sno is null then raise exception '번호를 확인하세요'; end if;
  if per = '' then raise exception '교시를 적어 주세요'; end if;
  if q = '' then raise exception '질문을 적어 주세요'; end if;
  if a = '' then raise exception '내 대답을 적어 주세요'; end if;
  if length(per) > 40 then raise exception '교시는 40자까지예요'; end if;
  if length(q) > 300 or length(a) > 300 then raise exception '질문과 대답은 300자까지예요'; end if;
  if (select count(*) from reactions where student_id = p_student and date = d and status <> 'rejected' and not adj) >= 3 then
    raise exception '리액션은 하루 3번까지 신청할 수 있어요';
  end if;
  if exists (select 1 from reactions where student_id = p_student and date = d and status <> 'rejected' and period = per and question = q) then
    raise exception '이미 신청한 리액션이에요';
  end if;
  perform _op(sno || '번 학생', 'create_reaction', format('리액션 신청: %s번 %s %s', sno, to_char(d, 'FMMM/FMDD'), per));
  insert into reactions (student_id, date, period, question, answer) values (p_student, d, per, q, a) returning id into nid;
  return nid;
end $$;

create or replace function login(p_role text, p_pw text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a accounts; t uuid;
begin
  -- 동시에 들어온 시도도 하나씩 처리한다 (안 그러면 한꺼번에 보내 잠금을 피할 수 있다)
  select * into a from accounts where role = p_role for update;
  if not found or a.pw_hash is null then return json_build_object('error', '직책을 확인하세요'); end if;
  if a.locked_until > now() then
    return json_build_object('error', format('비밀번호를 여러 번 틀려서 잠겼어요. %s분 뒤에 다시 해보세요', ceil(extract(epoch from a.locked_until - now()) / 60)));
  end if;
  if a.pw_hash <> crypt(coalesce(p_pw, ''), a.pw_hash) then
    update accounts set fails = case when fails + 1 >= 5 then 0 else fails + 1 end,
      locked_until = case when fails + 1 >= 5 then now() + interval '10 minutes' else locked_until end
    where role = p_role;
    return json_build_object('error', '비밀번호가 맞지 않아요');
  end if;
  update accounts set fails = 0, locked_until = null where role = p_role;
  perform _cleanup();
  insert into sessions (role, expires_at) values (p_role, now() + interval '30 days') returning token into t;
  return json_build_object('token', t, 'role', p_role, 'admin', a.is_admin);
end $$;

create or replace function recover(p_code text, p_role text, p_new text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare s settings; code text; t uuid;
begin
  select * into s from settings where id = 1 for update;
  if s.recovery_locked_until > now() then return json_build_object('error', '복구 코드를 여러 번 틀렸어요. 10분 뒤에 다시 해보세요'); end if;
  if s.recovery_hash is null or s.recovery_hash <> crypt(_norm_code(p_code), s.recovery_hash) then
    update settings set recovery_fails = case when recovery_fails + 1 >= 5 then 0 else recovery_fails + 1 end,
      recovery_locked_until = case when recovery_fails + 1 >= 5 then now() + interval '10 minutes' else recovery_locked_until end where id = 1;
    return json_build_object('error', '복구 코드가 맞지 않아요');
  end if;
  if not exists (select 1 from accounts where role = p_role and is_admin) then return json_build_object('error', '복구 코드로는 부총대 비밀번호만 새로 정할 수 있어요'); end if;
  if length(coalesce(p_new, '')) < 4 then return json_build_object('error', '새 비밀번호는 4자 이상이어야 해요'); end if;
  code := _new_code();
  update settings set recovery_hash = crypt(_norm_code(code), gen_salt('bf')), recovery_fails = 0, recovery_locked_until = null where id = 1;
  update accounts set pw_hash = crypt(p_new, gen_salt('bf')), fails = 0, locked_until = null where role = p_role;
  -- 비밀번호가 새 것이 됐으니 다른 기기의 로그인은 끊는다 (새어 나간 비밀번호로 들어온 사람도)
  delete from sessions where role = p_role;
  insert into sessions (role, expires_at) values (p_role, now() + interval '30 days') returning token into t;
  return json_build_object('token', t, 'role', p_role, 'admin', true, 'code', code);
end $$;

-- ───────────────────────── 로그인한 사람용 ─────────────────────────

create or replace function private_state(p_token uuid) returns json language plpgsql security definer set search_path = public as $$
declare who text;
begin
  who := _session(p_token, false);
  return _state(true);
end $$;

create or replace function logout(p_token uuid) returns void language sql security definer set search_path = public as $$
  delete from sessions where token = p_token
$$;

create or replace function get_photo(p_token uuid, p_id uuid) returns text language plpgsql security definer set search_path = public as $$
begin
  perform _session(p_token, false);
  -- 공결 증빙(진료확인서 등)은 부총대만 본다
  if exists (select 1 from excuses where photo_id = p_id) then perform _session(p_token, true); end if;
  return (select data from photos where id = p_id);
end $$;

create or replace function create_request(p_token uuid, p_date date, p_sids uuid[], p_item text, p_detail text, p_points numeric, p_reason text, p_photo text)
returns uuid language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, false); nid uuid;
begin
  perform _wlock();
  if p_date is null then raise exception '날짜를 입력하세요'; end if;
  perform _check_items(p_item, p_points);
  if coalesce(array_length(p_sids, 1), 0) = 0 then raise exception '학생을 골라 주세요'; end if;
  perform _op(who, 'create_request', format('요청: %s %s · %s번', trim(p_item), _pt(p_points), _nums(p_sids)));
  insert into requests (requested_by, date, student_ids, item, detail, points, reason, photo_id)
  values (who, p_date, p_sids, trim(p_item), coalesce(trim(p_detail), ''), p_points, coalesce(trim(p_reason), ''), _photo(p_photo))
  returning id into nid;
  return nid;
end $$;

create or replace function change_pw(p_token uuid, p_cur text, p_new text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare who text := _session(p_token, false); h text;
begin
  select pw_hash into h from accounts where role = who;
  if h <> crypt(coalesce(p_cur, ''), h) then raise exception '현재 비밀번호가 맞지 않아요'; end if;
  if length(coalesce(p_new, '')) < 4 then raise exception '새 비밀번호는 4자 이상이어야 해요'; end if;
  update accounts set pw_hash = crypt(p_new, gen_salt('bf')) where role = who;
  -- 이 기기 말고 다른 기기의 로그인은 끊는다
  delete from sessions where role = who and token <> p_token;
end $$;

-- ───────────────────────── 부총대 전용 ─────────────────────────

create or replace function reset_pw(p_token uuid, p_role text, p_new text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare who text := _session(p_token, true);
begin
  if length(coalesce(p_new, '')) < 4 then raise exception '새 비밀번호는 4자 이상이어야 해요'; end if;
  update accounts set pw_hash = crypt(p_new, gen_salt('bf')), fails = 0, locked_until = null where role = p_role;
  if not found then raise exception '없는 직책이에요'; end if;
  delete from sessions where role = p_role;
end $$;

drop function if exists set_attend(uuid, text, boolean);

create or replace function new_recovery(p_token uuid, p_pw text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare who text := _session(p_token, true); h text; code text;
begin
  select pw_hash into h from accounts where role = who;
  if h <> crypt(coalesce(p_pw, ''), h) then raise exception '내 비밀번호가 맞지 않아요'; end if;
  code := _new_code();
  update settings set recovery_hash = crypt(_norm_code(code), gen_salt('bf')) where id = 1;
  return code;
end $$;

create or replace function ensure_period(p_token uuid, p_date date, p_label text, p_morning boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare who text := _session_attend(p_token); pid uuid;
begin
  perform _wlock();
  if coalesce(trim(p_label), '') = '' then raise exception '교시 이름을 입력하세요'; end if;
  if length(trim(p_label)) > 40 then raise exception '교시 이름은 40자까지예요'; end if;
  -- "아침 출석"은 부총대의 아침 출석만 쓰는 이름이다 (다른 교시가 쓰면 아침 출석 저장이 그 교시를 덮어쓴다)
  if trim(p_label) = '아침 출석' and not coalesce(p_morning, false) then raise exception '"아침 출석"은 교시 이름으로 쓸 수 없어요'; end if;
  select id into pid from periods where date = p_date and label = trim(p_label);
  if pid is not null and (select morning from periods where id = pid) <> coalesce(p_morning, false) then
    raise exception '같은 이름의 교시가 이미 있어요. 다른 이름을 써 주세요';
  end if;
  if pid is null then
    perform _op(who, 'ensure_period', format('교시 추가: %s %s', to_char(p_date, 'FMMM/FMDD'), trim(p_label)));
    -- 두 사람이 같은 교시를 동시에 추가해도 오류 없이 같은 교시로
    insert into periods (date, label, morning) values (p_date, trim(p_label), coalesce(p_morning, false))
    on conflict (date, label) do nothing returning id into pid;
    if pid is null then select id into pid from periods where date = p_date and label = trim(p_label); end if;
  end if;
  return pid;
end $$;

-- 교시 삭제. 출결·출석 요청은 함께 지워지고, 이 교시로 준 자봉은 지우지 않고 "교시 삭제"로 무효 처리한다(학생 상세에 남는다).
-- 부총대는 어느 교시든, 출석 요청을 보낼 수 있는 총대단은 아직 저장 안 됐고 다른 사람의 요청도 없는 교시만 지운다.
-- 처리하지 않은 출석 요청(부총대)이나 공결 신청이 있으면 먼저 처리하게 한다. 무효 처리한 자봉 수를 돌려준다.
create or replace function delete_period(p_token uuid, p_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare who text := _session_attend(p_token); per periods; admin boolean; l record; n int := 0;
begin
  perform _wlock();
  select * into per from periods where id = p_id for update;
  if not found then raise exception '교시를 찾을 수 없어요'; end if;
  admin := exists (select 1 from accounts where role = who and is_admin);
  if not admin and (per.saved_at is not null or exists (select 1 from ledger where period_id = p_id)
      or exists (select 1 from attendance_requests where period_id = p_id and requested_by <> who)) then
    raise exception '출석이 저장됐거나 다른 사람의 출석 요청이 있는 교시는 부총대만 지울 수 있어요';
  end if;
  if admin and exists (select 1 from attendance_requests where period_id = p_id and status = 'pending') then
    raise exception '이 교시에 처리하지 않은 출석 요청이 있어요. 요청함에서 먼저 처리해 주세요';
  end if;
  if exists (select 1 from excuses x join ledger e on e.id = x.ledger_id where e.period_id = p_id and x.status = 'pending') then
    raise exception '이 교시에 처리하지 않은 공결 신청이 있어요. 요청함에서 먼저 처리해 주세요';
  end if;
  perform _op(who, 'delete_period', format('교시 삭제: %s', _per(p_id)));
  for l in select id from ledger where period_id = p_id and voided_at is null order by created_at loop
    perform _void(l.id, '교시 삭제', who);
    n := n + 1;
  end loop;
  delete from periods where id = p_id;
  return n;
end $$;

-- 교시 이름 바꾸기. 지울 수 있는 사람과 같다: 부총대는 어느 교시든, 출석을 체크하는 총대단은 아직 저장 안 됐고
-- 다른 사람의 요청도 없는 교시만. 아침 출석은 바꾸지 않는다. 그 교시로 준 자봉의 세부내용(교시 이름)도 함께 바꾼다.
create or replace function rename_period(p_token uuid, p_id uuid, p_label text) returns void
language plpgsql security definer set search_path = public as $$
declare who text := _session_attend(p_token); per periods; lbl text := trim(coalesce(p_label, ''));
begin
  perform _wlock();
  select * into per from periods where id = p_id for update;
  if not found then raise exception '교시를 찾을 수 없어요'; end if;
  if per.morning then raise exception '아침 출석은 이름을 바꿀 수 없어요'; end if;
  if lbl = '' then raise exception '교시 이름을 입력하세요'; end if;
  if length(lbl) > 40 then raise exception '교시 이름은 40자까지예요'; end if;
  if lbl = per.label then raise exception '지금 이름과 같아요'; end if;
  if lbl = '아침 출석' then raise exception '"아침 출석"은 교시 이름으로 쓸 수 없어요'; end if;
  if not exists (select 1 from accounts where role = who and is_admin) and (per.saved_at is not null
      or exists (select 1 from ledger where period_id = p_id)
      or exists (select 1 from attendance_requests where period_id = p_id and requested_by <> who)) then
    raise exception '출석이 저장됐거나 다른 사람의 출석 요청이 있는 교시는 부총대만 이름을 바꿀 수 있어요';
  end if;
  if exists (select 1 from periods where date = per.date and label = lbl) then
    raise exception '그 날짜에 같은 이름의 교시가 이미 있어요';
  end if;
  perform _op(who, 'rename_period', format('교시 이름 바꾸기: %s %s → %s', to_char(per.date, 'FMMM/FMDD'), per.label, lbl));
  update periods set label = lbl where id = p_id;
  update ledger set detail = lbl where period_id = p_id and src = 'att' and detail = per.label;
end $$;

-- 한 교시의 출결을 저장한다. p_statuses = {학생 id: 'late'|'absent'|'excused'} (없으면 출석)
-- 한 교시의 출결을 반영한다. p_by는 저장(승인)한 사람, p_requested_by는 출석 요청을 보낸 사람
create or replace function _apply_attendance(p_period uuid, p_statuses jsonb, p_by text, p_requested_by text) returns int
language plpgsql security definer set search_path = public as $$
declare
  who text := p_by;
  per periods; st record; want text; want_item text; cur ledger; pts int; n int := 0; nid uuid; old jsonb;
begin
  select * into per from periods where id = p_period;
  if not found then raise exception '교시를 찾을 수 없어요'; end if;
  -- 전에 저장한 출결 (같은 출결인데 기록이 없으면 그때 면제였거나 부총대가 무효 처리한 것이라 다시 만들지 않는다)
  select coalesce(jsonb_object_agg(student_id, status), '{}') into old from attendance where period_id = p_period;
  update periods set saved_at = now() where id = p_period;
  -- 명단에서 빠진 학생의 출결은 그대로 둔다 (지우면 다시 들어온 뒤 재저장할 때 그 학생의 지각·결석이 "출석 정정"으로 무효가 된다)
  delete from attendance where period_id = p_period and student_id in (select id from students where active);
  insert into attendance (period_id, student_id, status)
  select p_period, s.id, e.value from jsonb_each_text(coalesce(p_statuses, '{}')) e
  join students s on s.id = e.key::uuid and s.active
  where e.value in ('late', 'absent', 'excused');
  for st in select id from students where active loop
    want := coalesce(p_statuses ->> st.id::text, 'present');
    want_item := case want when 'late' then '지각' when 'absent' then '결석' end;
    cur := null;
    select * into cur from ledger where period_id = p_period and student_id = st.id and src = 'att' and voided_at is null limit 1;
    if cur.id is not null and cur.item is distinct from want_item then
      perform _void(cur.id, case when want = 'excused' then '공결 처리' else '출석 정정' end, who);
    end if;
    if want_item is not null and (cur.id is null or cur.item <> want_item) and (cur.id is not null or old ->> st.id::text is distinct from want) then
      -- 출석 점수는 지각 +1, 결석 +2로 고정한다
      pts := case want_item when '지각' then 1 else 2 end;
      nid := _entry(per.date, st.id, want_item, per.label, pts, 'att', p_period, null, who,
        p_requested_by, case when p_requested_by is not null then who end);
      if nid is not null then n := n + 1; end if;
    end if;
  end loop;
  return n;
end $$;

create or replace function save_attendance(p_token uuid, p_period uuid, p_statuses jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true);
begin
  perform _wlock();
  perform _op(who, 'save_attendance', format('출석 저장: %s (%s)', _per(p_period), _attn(p_statuses)));
  return _apply_attendance(p_period, p_statuses, who, null);
end $$;

-- 총대단의 출석 요청. 같은 사람이 같은 교시에 대기 중인 요청이 있으면 내용을 바꾼다.
create or replace function request_attendance(p_token uuid, p_period uuid, p_statuses jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare who text := _session_attend(p_token); rid uuid;
begin
  perform _wlock();
  if not exists (select 1 from periods where id = p_period) then raise exception '교시를 찾을 수 없어요'; end if;
  perform _op(who, 'request_attendance', format('출석 요청: %s (%s)', _per(p_period), _attn(p_statuses)));
  select id into rid from attendance_requests where period_id = p_period and requested_by = who and status = 'pending';
  if rid is null then
    insert into attendance_requests (period_id, statuses, requested_by) values (p_period, coalesce(p_statuses, '{}'), who) returning id into rid;
  else
    update attendance_requests set statuses = coalesce(p_statuses, '{}'), created_at = now() where id = rid;
  end if;
  return rid;
end $$;

create or replace function review_attendance(p_token uuid, p_id uuid, p_approve boolean, p_note text) returns int
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); r attendance_requests; n int := 0;
begin
  perform _wlock();
  select * into r from attendance_requests where id = p_id for update;
  if not found or r.status <> 'pending' then raise exception '이미 처리된 요청이에요'; end if;
  -- 요청 뒤에 그 교시가 저장·공결 처리됐으면, 옛 내용으로 덮어쓰지 않게 승인하지 않는다
  if p_approve and (select saved_at from periods where id = r.period_id) > r.created_at then
    raise exception '요청을 보낸 뒤에 이 교시의 출석이 바뀌었어요. 반려하고 다시 보내 달라고 하거나, 출석 탭에서 직접 고치세요';
  end if;
  perform _op(who, 'review_attendance', format('출석 요청 %s: %s의 %s (%s)', case when p_approve then '승인' else '반려' end, r.requested_by, _per(r.period_id), _attn(r.statuses)));
  if p_approve then
    n := _apply_attendance(r.period_id, r.statuses, who, r.requested_by);
    update attendance_requests set status = 'approved', reviewed_by = who, reviewed_at = now() where id = p_id;
  else
    if coalesce(trim(p_note), '') = '' then raise exception '반려 사유를 입력하세요'; end if;
    update attendance_requests set status = 'rejected', review_note = trim(p_note), reviewed_by = who, reviewed_at = now() where id = p_id;
  end if;
  return n;
end $$;

create or replace function add_entries(p_token uuid, p_date date, p_sids uuid[], p_item text, p_detail text, p_points numeric) returns int
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); sid uuid; n int := 0; m int := 0;
begin
  perform _wlock();
  if p_date is null then raise exception '날짜를 입력하세요'; end if;
  perform _check_items(p_item, p_points);
  perform _op(who, 'add_entries', format('기록: %s %s%s · %s번', trim(p_item), _pt(p_points),
    case when coalesce(trim(p_detail), '') <> '' then ' (' || trim(p_detail) || ')' else '' end, _nums(p_sids)));
  foreach sid in array p_sids loop
    m := m + 1;
    if _entry(p_date, sid, trim(p_item), trim(p_detail), p_points, 'manual', null, null, who) is not null then n := n + 1; end if;
  end loop;
  if m = 0 then raise exception '학생을 골라 주세요'; end if;
  if n = 0 then raise exception '고른 학생이 모두 자봉 면제라 기록할 것이 없어요'; end if;
  return n;
end $$;

create or replace function edit_entry(p_token uuid, p_id uuid, p_date date, p_item text, p_detail text, p_points numeric, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); e ledger; b jsonb := '{}'; a jsonb := '{}';
begin
  perform _wlock();
  if coalesce(trim(p_reason), '') = '' then raise exception '수정 사유를 입력하세요'; end if;
  if p_date is null then raise exception '날짜를 입력하세요'; end if;
  perform _check_items(p_item, p_points);
  select * into e from ledger where id = p_id;
  if not found then raise exception '기록을 찾을 수 없어요'; end if;
  if e.date <> p_date then b := b || jsonb_build_object('date', e.date); a := a || jsonb_build_object('date', p_date); end if;
  if e.item <> trim(p_item) then b := b || jsonb_build_object('item', e.item); a := a || jsonb_build_object('item', trim(p_item)); end if;
  if e.detail <> coalesce(trim(p_detail), '') then b := b || jsonb_build_object('detail', e.detail); a := a || jsonb_build_object('detail', coalesce(trim(p_detail), '')); end if;
  if e.points <> p_points then b := b || jsonb_build_object('points', e.points); a := a || jsonb_build_object('points', p_points); end if;
  if a = '{}' then raise exception '바뀐 내용이 없어요'; end if;
  perform _op(who, 'edit_entry', format('수정: %s번 %s %s (%s)', (select no from students where id = e.student_id), e.item, _pt(e.points), trim(p_reason)));
  update ledger set date = p_date, item = trim(p_item), detail = coalesce(trim(p_detail), ''), points = p_points where id = p_id;
  insert into ledger_revisions (ledger_id, before, after, reason, edited_by) values (p_id, b, a, trim(p_reason), who);
end $$;

create or replace function void_entry(p_token uuid, p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true);
begin
  perform _wlock();
  if coalesce(trim(p_reason), '') = '' then raise exception '무효 처리 사유를 입력하세요'; end if;
  if not exists (select 1 from ledger where id = p_id and voided_at is null) then raise exception '이미 무효 처리된 기록이에요'; end if;
  perform _op(who, 'void_entry', (select format('무효 처리: %s번 %s %s (%s)', s.no, l.item, _pt(l.points), trim(p_reason))
    from ledger l join students s on s.id = l.student_id where l.id = p_id));
  perform _void(p_id, trim(p_reason), who);
end $$;

create or replace function review_request(p_token uuid, p_id uuid, p_approve boolean, p_note text) returns int
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); r requests; sid uuid; n int := 0;
begin
  perform _wlock();
  select * into r from requests where id = p_id for update;
  if not found or r.status <> 'pending' then raise exception '이미 처리된 요청이에요'; end if;
  perform _op(who, 'review_request', format('요청 %s: %s의 %s %s · %s번', case when p_approve then '승인' else '반려' end, r.requested_by, r.item, _pt(r.points), _nums(r.student_ids)));
  if p_approve then
    foreach sid in array r.student_ids loop
      if exists (select 1 from students where id = sid) then
        if _entry(r.date, sid, r.item, r.detail, r.points, 'request', null, r.id, who, r.requested_by, who) is not null then n := n + 1; end if;
      end if;
    end loop;
    update requests set status = 'approved', reviewed_by = who, reviewed_at = now() where id = p_id;
  else
    if coalesce(trim(p_note), '') = '' then raise exception '반려 사유를 입력하세요'; end if;
    update requests set status = 'rejected', review_note = trim(p_note), reviewed_by = who, reviewed_at = now() where id = p_id;
  end if;
  return n;
end $$;

create or replace function review_excuse(p_token uuid, p_id uuid, p_approve boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); x excuses; e ledger; r excuses; n int;
begin
  perform _wlock();
  select * into x from excuses where id = p_id for update;
  if not found or x.status <> 'pending' then raise exception '이미 처리된 신청이에요'; end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then raise exception '반려 사유를 입력하세요'; end if;
  -- 하루 전체 신청은 같은 grp의 대기 중인 것을 함께 처리한다
  select count(*) into n from excuses where status = 'pending' and (id = p_id or (x.grp is not null and grp = x.grp));
  perform _op(who, 'review_excuse', format('공결 %s: %s번 %s', case when p_approve then '승인' else '반려' end,
    (select no from students where id = x.student_id),
    case when x.grp is not null then coalesce((select to_char(date, 'FMMM/FMDD') from ledger where id = x.ledger_id), '') || format(' 하루 (%s건)', n)
      else coalesce((select to_char(date, 'FMMM/FMDD') || ' ' || item from ledger where id = x.ledger_id), '') end));
  -- 그사이 출석을 고쳐 대상 기록이 이미 무효가 됐으면, 한 건짜리 승인은 멈추고(조용히 "승인"되면 안 된다)
  -- 하루 전체 신청은 무효가 된 줄만 "이미 정정됨"으로 반려한다
  if p_approve and x.grp is null and exists (select 1 from ledger where id = x.ledger_id and voided_at is not null) then
    raise exception '신청한 출결이 그사이 정정되어 이미 무효예요. 반려하고, 필요하면 지금 출결로 다시 신청하게 해 주세요';
  end if;
  if p_approve and x.grp is not null and not exists (select 1 from excuses y join ledger l on l.id = y.ledger_id
      where y.grp = x.grp and y.status = 'pending' and l.voided_at is null) then
    raise exception '신청한 출결이 그사이 모두 정정되어 이미 무효예요. 반려하고, 필요하면 지금 출결로 다시 신청하게 해 주세요';
  end if;
  for r in select * from excuses where status = 'pending' and (id = p_id or (x.grp is not null and grp = x.grp)) order by created_at, id for update loop
    if p_approve and exists (select 1 from ledger where id = r.ledger_id and voided_at is not null) then
      update excuses set status = 'rejected', review_note = '그사이 정정되어 이미 무효인 출결', reviewed_by = who, reviewed_at = now() where id = r.id;
      continue;
    end if;
    if p_approve then
      select * into e from ledger where id = r.ledger_id;
      if e.id is not null and e.voided_at is null then
        perform _void(e.id, case when r.reason <> '' then format('공결 승인 (%s)', r.reason) else '공결 승인' end, who);
        if e.period_id is not null then
          update periods set saved_at = now() where id = e.period_id;
          insert into attendance (period_id, student_id, status) values (e.period_id, r.student_id, 'excused')
          on conflict (period_id, student_id) do update set status = 'excused';
        end if;
      end if;
      update excuses set status = 'approved', reviewed_by = who, reviewed_at = now() where id = r.id;
    else
      update excuses set status = 'rejected', review_note = trim(p_note), reviewed_by = who, reviewed_at = now() where id = r.id;
    end if;
  end loop;
end $$;

-- 학생 화면의 리액션: 그 학생의 대기 중인 것과 최근 30일 것, 오늘 낸 수, 이월 수, 받은 리액션 상점 수 (로그인 없음)

create or replace function my_reactions(p_student uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'rows', (select coalesce(json_agg(json_build_object('id', id, 'date', date, 'period', period, 'q', question, 'a', answer,
        'status', status, 'note', review_note, 'merit', merit is not null and merit <> _merit_cleared(), 'cleared', merit = _merit_cleared(),
        'at', _kst(created_at)) order by created_at desc, id desc), '[]')
      from reactions where student_id = p_student and not adj and (status = 'pending' or date >= (now() at time zone 'Asia/Seoul')::date - 30)),
    'today', (select count(*) from reactions where student_id = p_student and date = (now() at time zone 'Asia/Seoul')::date and status <> 'rejected' and not adj),
    'prog', (select count(*) from reactions where student_id = p_student and status = 'approved' and merit is null),
    'merits', (select count(distinct merit) from reactions where student_id = p_student and merit is not null and merit <> _merit_cleared()))
$$;

-- 누구나 보는 리액션 내역 (최신순, 번호만). 부총대가 맞춘 이월 줄은 빼고, 반려 사유는 싣지 않는다.
create or replace function reaction_feed(p_limit int) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(t.r order by t.ord desc, t.r ->> 'id' desc), '[]') from (
    select json_build_object('id', x.id, 'no', s.no, 'active', s.active, 'date', x.date, 'period', x.period, 'q', x.question, 'a', x.answer,
      'status', x.status, 'merit', x.merit is not null and x.merit <> _merit_cleared(), 'at', _kst(x.created_at)) as r, x.created_at as ord
    from reactions x join students s on s.id = x.student_id
    where not x.adj
    order by x.created_at desc, x.id desc
    limit least(greatest(coalesce(p_limit, 30), 1), 300)) t
$$;

-- 내보내기(엑셀)용 리액션 내역 (부총대): 기간 안의 실제 리액션 (이월 줄 제외), 날짜·신청 순
create or replace function reaction_export(p_token uuid, p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public as $$
begin
  perform _session(p_token, true);
  return (select coalesce(json_agg(json_build_object('date', x.date, 'no', s.no, 'active', s.active, 'period', x.period,
      'q', x.question, 'a', x.answer, 'status', x.status, 'merit', x.merit is not null and x.merit <> _merit_cleared(), 'note', x.review_note)
      order by x.date, x.created_at, x.id), '[]')
    from reactions x join students s on s.id = x.student_id
    where not x.adj and x.date between p_from and p_to);
end $$;

-- 이월 맞추기 (부총대): p_list = [{sid, n}], n은 0~2. 모자라면 조정 줄(adj)을 넣고, 넘치면 조정 줄부터 지우고
-- 그래도 넘치면 오래된 실제 리액션을 이월에서 뺀다(_merit_cleared). 3이 되면 상점이 되니 2까지만 받는다.
create or replace function reaction_adjust(p_token uuid, p_list jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  who text := _session(p_token, true); x jsonb; sid uuid; want int; cur int; k int; n int := 0; parts text[] := '{}';
  d date := (now() at time zone 'Asia/Seoul')::date; sno int;
begin
  perform _wlock();
  if jsonb_typeof(coalesce(p_list, 'null')) <> 'array' or jsonb_array_length(p_list) = 0 then raise exception '맞출 학생이 없어요'; end if;
  for x in select * from jsonb_array_elements(p_list) loop
    if coalesce(x ->> 'n', '') !~ '^[0-9]+$' or (x ->> 'n')::int > 2 then
      raise exception '이월 횟수는 0~2번이에요 (3번이 모이면 상점이 되니, 이미 받은 상점은 자봉 점수로 넣어 주세요)';
    end if;
    select no into sno from students where id = (x ->> 'sid')::uuid and active;
    if sno is null then raise exception '명단에 없는 학생이 있어요'; end if;
    cur := (select count(*) from reactions where student_id = (x ->> 'sid')::uuid and status = 'approved' and merit is null);
    if cur <> (x ->> 'n')::int then parts := parts || format('%s번 %s→%s', sno, cur, x ->> 'n'); end if;
  end loop;
  if cardinality(parts) = 0 then raise exception '바뀌는 것이 없어요'; end if;
  perform _op(who, 'reaction_adjust', '리액션 이월 맞추기: ' || array_to_string(parts, ' · '));
  for x in select * from jsonb_array_elements(p_list) loop
    sid := (x ->> 'sid')::uuid;
    want := (x ->> 'n')::int;
    cur := (select count(*) from reactions where student_id = sid and status = 'approved' and merit is null);
    if want = cur then continue; end if;
    n := n + 1;
    if want > cur then
      insert into reactions (student_id, date, period, question, answer, status, adj, reviewed_by, reviewed_at)
      select sid, d, '이월', '부총대 조정', '', 'approved', true, who, now() from generate_series(1, want - cur);
    else
      k := cur - want;
      with g as (select id from reactions where student_id = sid and status = 'approved' and merit is null and adj order by created_at desc, id desc limit k)
      delete from reactions where id in (select id from g);
      get diagnostics cur = row_count;
      if k > cur then
        update reactions set merit = _merit_cleared() where id in (
          select id from reactions where student_id = sid and status = 'approved' and merit is null order by created_at, id limit k - cur);
      end if;
    end if;
  end loop;
  return n;
end $$;


-- 리액션 승인·반려 (부총대, 여러 건 한 번에). 승인할 때마다 그 학생의 아직 상점이 안 된 승인 리액션을 세어
-- 3개가 모이면 상점 1점(-1)을 만들고 그 3개에 표시한다. 만든 상점 수를 돌려준다.
create or replace function review_reaction(p_token uuid, p_ids uuid[], p_approve boolean, p_note text) returns int
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); r reactions; g uuid[]; mid uuid; n int := 0; oid bigint;
begin
  perform _wlock();
  if coalesce(array_length(p_ids, 1), 0) = 0 then raise exception '고른 리액션이 없어요'; end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then raise exception '반려 사유를 입력하세요'; end if;
  if exists (select 1 from unnest(p_ids) i where not exists (select 1 from reactions where id = i and status = 'pending')) then
    raise exception '이미 처리된 리액션이 있어요. 새로 불러온 뒤 다시 해보세요';
  end if;
  oid := _op(who, 'review_reaction', format('리액션 %s: %s', case when p_approve then '승인' else '반려' end,
    (select string_agg(format('%s번 %s건', no, c), ' · ' order by no) from
      (select s.no, count(*) c from reactions x join students s on s.id = x.student_id where x.id = any (p_ids) group by s.no) t)));
  for r in select * from reactions where id = any (p_ids) order by created_at, id for update loop
    if p_approve then
      update reactions set status = 'approved', reviewed_by = who, reviewed_at = now() where id = r.id;
      select array_agg(id) into g from (select id from reactions where student_id = r.student_id and status = 'approved' and merit is null
        order by created_at, id limit 3) t;
      if array_length(g, 1) = 3 then
        -- 상점 날짜는 승인한 날(한국 오늘): 리액션 날짜로 하면 이미 낸 공지 날짜로 들어가 공지에서 빠진다
        mid := _entry((now() at time zone 'Asia/Seoul')::date, r.student_id, '리액션 상점', '', -1, 'reaction', null, null, who, null, who);
        update reactions set merit = mid where id = any (g);
        n := n + 1;
      end if;
    else
      update reactions set status = 'rejected', review_note = trim(p_note), reviewed_by = who, reviewed_at = now() where id = r.id;
    end if;
  end loop;
  if n > 0 then update ops set summary = summary || format(' (상점 %s점)', n) where id = oid; end if;
  return n;
end $$;

-- 바로가기 링크 바꾸기 (부총대). 빈 주소면 지운다(버튼이 사라진다). https:// 주소만 받는다.
create or replace function set_link(p_token uuid, p_id text, p_url text) returns void
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); u text := trim(coalesce(p_url, '')); cur text;
begin
  perform _wlock();
  if p_id is distinct from 'store' then raise exception '없는 링크예요'; end if;
  if u <> '' and (u !~ '^https://[^[:space:]<>"]+$' or length(u) > 1000) then
    raise exception '링크는 https:// 로 시작하는 주소여야 해요 (띄어쓰기 없이, 1000자까지)';
  end if;
  select url into cur from links where id = p_id;
  if coalesce(cur, '') = u then raise exception '바뀌는 것이 없어요'; end if;
  perform _op(who, 'set_link', case when u = '' then '매점 링크 지우기' when cur is null then '매점 링크 넣기' else '매점 링크 바꾸기' end);
  if u = '' then delete from links where id = p_id;
  else insert into links (id, url) values (p_id, u) on conflict (id) do update set url = excluded.url; end if;
end $$;

-- 명단 변경을 한 번에 적용한다.
-- p_ops: [{op:'add',name,no} | {op:'renum'|'restore',id,no} | {op:'remove',id} | {op:'rename',id,name} | {op:'exempt',id,on}]
-- p_adjs: [{name, to}]  — 해당 학생의 자봉이 to가 되도록 차이만큼 기록을 더한다
create or replace function roster_apply(p_token uuid, p_ops jsonb, p_adjs jsonb, p_date date) returns int
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); o jsonb; a jsonb; sid uuid; cur numeric; fresh boolean; n int := 0;
begin
  perform _wlock();
  perform _op(who, 'roster_apply', (select '명단: ' || coalesce(nullif(concat_ws(' · ',
      nullif(format('추가 %s', count(*) filter (where x ->> 'op' = 'add')), '추가 0'),
      nullif(format('번호 변경 %s', count(*) filter (where x ->> 'op' = 'renum')), '번호 변경 0'),
      nullif(format('복귀 %s', count(*) filter (where x ->> 'op' = 'restore')), '복귀 0'),
      nullif(format('제외 %s', count(*) filter (where x ->> 'op' = 'remove')), '제외 0'),
      nullif(format('이름 %s', count(*) filter (where x ->> 'op' = 'rename')), '이름 0'),
      nullif(format('자봉 면제 %s', count(*) filter (where x ->> 'op' = 'exempt' and (x ->> 'on')::boolean)), '자봉 면제 0'),
      nullif(format('면제 해제 %s', count(*) filter (where x ->> 'op' = 'exempt' and not (x ->> 'on')::boolean)), '면제 해제 0'),
      nullif(format('자봉 조정 %s', jsonb_array_length(coalesce(p_adjs, '[]'))), '자봉 조정 0')), ''), '변경 없음')
    from jsonb_array_elements(coalesce(p_ops, '[]')) x));
  -- 번호를 바꿀 학생은 잠시 명단에서 빼 두어야 번호를 서로 맞바꿀 수 있다
  update students set active = false
  where id in (select (x ->> 'id')::uuid from jsonb_array_elements(coalesce(p_ops, '[]')) x where x ->> 'op' in ('renum', 'remove'));
  for o in select * from jsonb_array_elements(coalesce(p_ops, '[]')) loop
    case o ->> 'op'
      when 'add' then insert into students (no, name) values ((o ->> 'no')::int, coalesce(o ->> 'name', ''));
      when 'renum', 'restore' then update students set no = (o ->> 'no')::int, active = true where id = (o ->> 'id')::uuid;
      when 'rename' then update students set name = coalesce(o ->> 'name', '') where id = (o ->> 'id')::uuid;
      when 'exempt' then update students set exempt = coalesce((o ->> 'on')::boolean, false) where id = (o ->> 'id')::uuid;
      when 'remove' then null;
      else raise exception '알 수 없는 명단 작업이에요';
    end case;
    n := n + 1;
  end loop;
  for a in select * from jsonb_array_elements(coalesce(p_adjs, '[]')) loop
    if (select count(*) from students where active and name = a ->> 'name') > 1 then raise exception '같은 이름의 학생이 여러 명이에요: % (이름을 구분해 주세요)', a ->> 'name'; end if;
    select id into sid from students where active and name = a ->> 'name';
    if sid is null then raise exception '학생을 찾을 수 없어요: %', a ->> 'name'; end if;
    select coalesce(sum(points), 0), count(*) = 0 into cur, fresh from ledger where student_id = sid and voided_at is null;
    if (a ->> 'to')::numeric * 2 <> trunc((a ->> 'to')::numeric * 2) then raise exception '자봉 점수는 0.5점 단위로 적어 주세요: %', a ->> 'name'; end if;
    if (a ->> 'to')::numeric <> cur then
      perform _entry(p_date, sid, case when fresh then '기존 누적' else '자봉 조정' end,
        case when fresh then '' else '명단 붙여넣기' end, (a ->> 'to')::numeric - cur, 'import', null, null, who);
    end if;
    n := n + 1;
  end loop;
  return n;
exception when unique_violation then
  raise exception '번호가 겹치는 학생이 있어요. 번호를 확인해 주세요';
end $$;

drop function if exists presets_save(uuid, jsonb);

-- 각자(부총대 포함)의 "내 항목"을 통째로 바꾼다
create or replace function my_presets_save(p_token uuid, p_list jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, false); p jsonb; i int := 0;
begin
  perform _wlock();
  perform _op(who, 'my_presets_save', format('자주 쓰는 항목 저장 (%s개)', jsonb_array_length(coalesce(p_list, '[]'))));
  delete from presets where owner = who and kind = 'item';
  for p in select * from jsonb_array_elements(coalesce(p_list, '[]')) loop
    i := i + 1;
    if coalesce(trim(p ->> 'name'), '') <> '' then
      if coalesce(p ->> 'points', '') !~ '^-?[0-9]{1,6}$' or (p ->> 'points')::int = 0 then raise exception '점수는 0이 아닌 정수여야 해요'; end if;
      insert into presets (name, points, sort, owner) values (trim(p ->> 'name'), (p ->> 'points')::int, 100 + i, who);
    end if;
  end loop;
  if i > 30 then raise exception '내 항목은 30개까지 만들 수 있어요'; end if;
end $$;

-- 출석 "교시 추가" 칸의 자주 쓰는 교시. p_list는 교시 이름 배열이다. 항목과 마찬가지로 직책마다 따로.
create or replace function my_periods_save(p_token uuid, p_list jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, false); p jsonb; i int := 0;
begin
  perform _wlock();
  if jsonb_typeof(coalesce(p_list, '[]')) <> 'array' then raise exception '교시 목록이 올바르지 않아요'; end if;
  perform _op(who, 'my_periods_save', format('자주 쓰는 교시 저장 (%s개)', jsonb_array_length(coalesce(p_list, '[]'))));
  delete from presets where owner = who and kind = 'period';
  for p in select * from jsonb_array_elements(coalesce(p_list, '[]')) loop
    if jsonb_typeof(p) <> 'string' then raise exception '교시 이름은 글자여야 해요'; end if;
    if trim(p #>> '{}') <> '' and not exists (select 1 from presets where owner = who and kind = 'period' and name = trim(p #>> '{}')) then
      i := i + 1;
      if length(trim(p #>> '{}')) > 40 then raise exception '교시 이름은 40자까지예요'; end if;
      insert into presets (name, points, sort, owner, kind) values (trim(p #>> '{}'), 0, 100 + i, who, 'period');
    end if;
  end loop;
  if i > 30 then raise exception '자주 쓰는 교시는 30개까지 만들 수 있어요'; end if;
end $$;

-- 기준 날짜까지의 기록을 학생별 "이월" 한 줄로 합친다. 점수는 그대로 유지된다.
-- ───────────────────────── 백업과 되살리기 ─────────────────────────
-- 백업에는 학생·기록·이력·요청·출석·항목이 모두 들어간다. 비밀번호, 로그인, 사진은 넣지 않는다.
create or replace function _dump() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'format', 'jabong-backup', 'version', 1, 'createdAt', _kst(now()),
    'tables', jsonb_build_object(
      'students', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from students x),
      'presets', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from presets x),
      'periods', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from periods x),
      'attendance', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from attendance x),
      'ledger', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from ledger x),
      'ledger_private', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from ledger_private x),
      'ledger_revisions', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from ledger_revisions x),
      'requests', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from requests x),
      'excuses', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from excuses x),
      'attendance_requests', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from attendance_requests x),
      'reactions', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from reactions x),
      'links', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from links x)
    ))
$$;

-- ───────────────────────── 뒤로가기·앞으로 가기 ─────────────────────────
-- 이동은 아무 기록도 남기지 않는다 (작업 목록에 줄이 생기지 않고, 학생 기록에도 흔적이 없다).
-- 한 작업을 거꾸로(p_back) 또는 다시(not p_back) 적용한다. 행이 예상과 다르면(작업 밖에서 바뀐 경우) 멈춘다.
-- 이동 중에 바뀐 행은 잠깐 임시 작업(scratch)에 기록해서, 그 작업에 없던 행이 바뀌었는지 확인한 뒤 지운다.
drop function if exists undo_ops(uuid, bigint, text, boolean);
drop function if exists _undo_one(bigint, bigint);
drop function if exists _set_undone(bigint, bigint, bigint);
create or replace function _apply_op(p_op bigint, p_back boolean, p_scratch bigint) returns void
language plpgsql security definer set search_path = public as $$
declare c op_changes; cur jsonb; want jsonb; cols text; kc text; kw text; mark bigint; bad boolean := false; o ops; act char(1);
begin
  perform _wlock();
  select * into o from ops where id = p_op;
  select coalesce(max(id), 0) into mark from op_changes;
  begin
  -- 교시 삭제는 연쇄로 바뀐 자식 행(출결·자봉의 period_id)보다 교시 행이 먼저 기록된다(트리거가 도는 순서).
  -- 그래서 교시 행 삭제는 앞으로 갈 때 맨 나중에, 뒤로 갈 때(다시 넣기) 맨 먼저 한다.
  for c in select * from op_changes where op_id = p_op
    order by case when tbl = 'periods' and action = 'D' then case when p_back then 0 else 2 end else 1 end,
      case when p_back then -id else id end loop
    -- 기본키로 찾는다 (to_jsonb(t) @> 로 찾으면 표 전체를 훑어서, 한 학기 분량을 오가면 수 초가 걸린다)
    kc := case c.tbl when 'attendance' then 'period_id, student_id' when 'ledger_private' then 'ledger_id' else 'id' end;
    kw := format('(%2$s) = (select %2$s from jsonb_populate_record(null::%1$I, $1))', c.tbl, kc);
    execute format('select to_jsonb(t) from %I t where ', c.tbl) || kw into cur using c.row_key;
    -- 뒤로 갈 때: 넣은 것은 지우고(I→D), 지운 것은 넣고(D→I), 바꾼 것은 전으로. 앞으로 갈 때는 그대로.
    act := case when not p_back then c.action when c.action = 'I' then 'D' when c.action = 'D' then 'I' else 'U' end;
    if act = 'I' then
      want := case when p_back then c.before else c.after end;
      if cur is not null then
        if cur = want then continue; end if;
        bad := true; exit;
      end if;
      execute format('insert into %1$I select (jsonb_populate_record(null::%1$I, $1)).*', c.tbl) using want;
    elsif act = 'D' then
      if cur is null then continue; end if;
      if cur <> (case when p_back then c.after else c.before end) then bad := true; exit; end if;
      execute format('delete from %I t where ', c.tbl) || kw using c.row_key;
    else
      if cur is distinct from (case when p_back then c.after else c.before end) then bad := true; exit; end if;
      select string_agg(quote_ident(attname), ',' order by attnum) into cols
      from pg_attribute where attrelid = format('public.%I', c.tbl)::regclass and attnum > 0 and not attisdropped;
      execute format('update %1$I t set (%2$s) = (select %2$s from jsonb_populate_record(null::%1$I, $1)) where ', c.tbl, cols)
        || replace(kw, '$1', '$2')
        using case when p_back then c.before else c.after end, c.row_key;
    end if;
  end loop;
  exception when foreign_key_violation or unique_violation then
    raise exception '"%" 작업이 기대는 다른 작업이 빠져 있거나(이 작업만 되돌림) 같은 것이 새로 생겨서 이동할 수 없어요. 빼 둔 작업을 먼저 다시 살려 보세요', o.summary using errcode = 'P0002';
  end;
  if not bad and exists (
      select 1 from op_changes u where u.id > mark and u.op_id = p_scratch
        and not exists (select 1 from op_changes x where x.op_id = p_op and x.tbl = u.tbl and x.row_key = u.row_key)) then
    bad := true;
  end if;
  if bad then
    raise exception '"%" 작업의 기록이 작업 내역 밖에서 바뀌어서 이동할 수 없어요', o.summary using errcode = 'P0002';
  end if;
  update ops set undone = p_back where id = p_op;
end $$;

-- 학생별 번호·이름·재학·자봉 (미리보기 비교용)
create or replace function _snap() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(s.id, jsonb_build_object('no', s.no, 'name', s.name, 'active', s.active,
    'bal', coalesce((select sum(points) from ledger l where l.student_id = s.id and l.voided_at is null), 0))), '{}')
  from students s
$$;

-- 미리보기용: 학생별 전·후 비교
create or replace function _snap_diff(p_before jsonb, p_after jsonb) returns json language sql stable as $$
  select coalesce(json_agg(json_build_object(
      'no', coalesce(a -> 'no', b -> 'no'), 'name', coalesce(a ->> 'name', b ->> 'name'),
      'beforeNo', b -> 'no', 'afterNo', a -> 'no', 'beforeActive', b -> 'active', 'afterActive', a -> 'active',
      'before', b -> 'bal', 'after', a -> 'bal') order by coalesce((a ->> 'no')::int, (b ->> 'no')::int)), '[]')
  from (select k, p_before -> k as b, p_after -> k as a from (select jsonb_object_keys(p_before) k union select jsonb_object_keys(p_after)) keys) d
  where b is distinct from a
$$;
create or replace function _op_json(p_ids bigint[], p_desc boolean) returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('id', id, 'at', _kst(at), 'actor', actor, 'summary', summary)
    order by case when p_desc then -id else id end), '[]') from ops where id = any (p_ids)
$$;

-- 리액션 3개당 상점 1점이 어긋났으면(상점이 안 된 승인 리액션이 3개 이상) 멈춘다.
-- 작업 하나만 빼기·살리기나 이동을 섞으면 행이 겹치지 않아도 생길 수 있다 (뒤의 승인은 그때 개수로 상점 여부를 정했으므로).
create or replace function _check_reactions() returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from reactions where status = 'approved' and merit is null group by student_id having count(*) >= 3) then
    raise exception '그렇게 하면 어떤 학생의 승인 리액션 3개가 상점으로 묶이지 않은 채 남아서(3개당 1점이 어긋나서) 할 수 없어요. 다른 시점을 고르거나 다른 작업부터 되돌려 보세요'
      using errcode = 'P0002';
  end if;
end $$;

-- p_target 작업 바로 뒤의 상태로 이동한다 (0이면 작업 내역의 맨 처음).
-- 그 뒤의 적용된 작업은 최신부터 거꾸로, 그 앞의 되돌린 작업은 오래된 것부터 다시 적용한다.
-- "이 작업만 되돌리기"로 빼 둔 작업(dropped)은 데이터를 건드리지 않고 undone 표시만 함께 옮긴다.
-- p_preview면 이동해 본 결과만 돌려주고 모두 취소한다.
create or replace function history_move(p_token uuid, p_target bigint, p_preview boolean) returns json
language plpgsql security definer set search_path = public as $$
declare
  who text := _session(p_token, true); x bigint; scratch bigint; back_ids bigint[]; fwd_ids bigint[];
  before jsonb; result json; nledger int;
begin
  perform _wlock();
  select coalesce(array_agg(id order by id desc), '{}') into back_ids from ops where id > p_target and not undone and kind <> 'scratch';
  select coalesce(array_agg(id order by id), '{}') into fwd_ids from ops where id <= p_target and undone;
  -- 빼 둔 작업만 옮기는 이동도 한다 (맨 끝의 빼 둔 작업을 제자리로 돌려놓아야 새 작업에 지워지지 않는다)
  if cardinality(back_ids) + cardinality(fwd_ids) = 0 then raise exception '이미 그 시점이에요'; end if;
  if exists (select 1 from ops where (id = any (back_ids) or id = any (fwd_ids)) and not undoable) then
    raise exception '보관 후 정리나 백업에서 되살리기 너머로는 이동할 수 없어요';
  end if;
  -- 한 번에 너무 많이 옮기면 Supabase의 3초 제한을 넘는다 (작업 하나에 약 1ms). 나눠서 옮기게 한다
  if (select count(*) from ops where (id = any (back_ids) or id = any (fwd_ids)) and not dropped) > 1500 then
    raise exception '한 번에 작업 1,500개까지만 이동할 수 있어요. 목록에서 더 가까운 작업의 "이 시점으로"를 눌러 나눠서 이동해 주세요';
  end if;
  before := _snap();
  select count(*) into nledger from ledger where voided_at is null;
  begin
    -- 이동 중 바뀐 행을 잠깐 받아 둘 임시 작업. 끝나면 지운다.
    insert into ops (actor, kind, summary, undoable, undone) values (who, 'scratch', '', false, true) returning id into scratch;
    perform set_config('jabong.op', scratch::text, true);
    perform set_config('jabong.moving', 'on', true);
    foreach x in array back_ids loop
      if (select dropped from ops where id = x) then update ops set undone = true where id = x;
      else perform _apply_op(x, true, scratch); end if;
    end loop;
    foreach x in array fwd_ids loop
      if (select dropped from ops where id = x) then update ops set undone = false where id = x;
      else perform _apply_op(x, false, scratch); end if;
    end loop;
    delete from ops where id = scratch;
    perform set_config('jabong.op', '', true);
    perform set_config('jabong.moving', '', true);
    update app_version set version = version + 1, updated_at = now() where id = 1;
    perform _check_reactions();
    result := json_build_object(
      'back', _op_json(array(select id from ops where id = any (back_ids) and not dropped), true),
      'forward', _op_json(array(select id from ops where id = any (fwd_ids) and not dropped), false),
      'ledger', json_build_object('before', nledger, 'after', (select count(*) from ledger where voided_at is null)),
      'students', _snap_diff(before, _snap()));
    if p_preview then raise exception using errcode = 'P0003', message = 'preview'; end if;
  exception when sqlstate 'P0003' then
    return result;
  end;
  return result;
end $$;

-- 이 작업만 되돌리기(p_restore = false) / 다시 살리기(p_restore = true).
-- 작업은 목록에 "빼 둠"(dropped)으로 남고 새 작업 기록은 생기지 않는다. 다른 작업의 위치(뒤로·앞으로)는 그대로다.
-- 뒤의 작업이 같은 행을 바꿨으면 _apply_op가 알아채고 멈춘다.
-- 앞으로 가기 전(undone)인 작업을 살리면 데이터는 그대로 두고 표시만 푼다. 앞으로 갈 때 함께 적용된다.
create or replace function _history_one(p_token uuid, p_op bigint, p_restore boolean, p_preview boolean) returns json
language plpgsql security definer set search_path = public as $$
declare
  who text := _session(p_token, true); o ops; scratch bigint; before jsonb; result json; nledger int;
begin
  perform _wlock();
  select * into o from ops where id = p_op and kind <> 'scratch';
  if not found then raise exception '작업을 찾을 수 없어요'; end if;
  if not o.undoable then raise exception '보관 후 정리나 백업에서 되살리기는 되돌릴 수 없어요'; end if;
  if p_restore and not o.dropped then raise exception '빼 둔 작업이 아니에요'; end if;
  if not p_restore and o.dropped then raise exception '이미 빼 둔 작업이에요'; end if;
  if not p_restore and o.undone then raise exception '뒤로 가 있는 작업이에요. 먼저 앞으로 가서 적용한 뒤에 빼세요'; end if;
  -- 뒤에 적용된 작업이 같은 행을 건드렸으면 멈춘다. (_apply_op는 이미 지워진 행을 건너뛰므로,
  --  예를 들어 뒤의 작업이 이 작업이 넣은 행을 지웠으면 이것만으로는 알아채지 못한다)
  if not o.undone and exists (
      select 1 from op_changes a join op_changes b on b.tbl = a.tbl and b.row_key = a.row_key
      join ops l on l.id = b.op_id
      where a.op_id = p_op and l.id > p_op and not l.undone and not l.dropped and l.kind <> 'scratch') then
    raise exception '"%" 작업 뒤에 같은 기록을 바꾼 작업이 있어서, 이 작업만 %수 없어요. "이 시점으로"를 써 보세요',
      o.summary, case when p_restore then '다시 살릴 ' else '되돌릴 ' end using errcode = 'P0002';
  end if;
  -- 리액션 상점은 "그 학생의 아직 안 묶인 승인 리액션 3개"로 만들어지니, 뒤의 작업이 같은 학생의 리액션을 건드렸으면
  -- 행이 겹치지 않아도 이 작업만 빼거나 살리면 3개당 1점이 어긋난다
  if not o.undone and exists (
      select 1 from op_changes a join op_changes b on b.tbl = 'reactions'
        and coalesce(b.after, b.before) ->> 'student_id' = coalesce(a.after, a.before) ->> 'student_id'
      join ops l on l.id = b.op_id
      where a.op_id = p_op and a.tbl = 'reactions' and l.id > p_op and not l.undone and not l.dropped and l.kind <> 'scratch') then
    raise exception '"%" 작업 뒤에 같은 학생의 리액션을 처리한 작업이 있어서, 이 작업만 %수 없어요. "이 시점으로"를 써 보세요',
      o.summary, case when p_restore then '다시 살릴 ' else '되돌릴 ' end using errcode = 'P0002';
  end if;
  before := _snap();
  select count(*) into nledger from ledger where voided_at is null;
  begin
    if not o.undone then
      insert into ops (actor, kind, summary, undoable, undone) values (who, 'scratch', '', false, true) returning id into scratch;
      perform set_config('jabong.op', scratch::text, true);
      perform _apply_op(p_op, not p_restore, scratch);
      delete from ops where id = scratch;
      perform set_config('jabong.op', '', true);
    end if;
    update ops set dropped = not p_restore, undone = o.undone where id = p_op;
    perform _check_reactions();
    result := json_build_object(
      'back', case when p_restore then '[]'::json else _op_json(array[p_op], true) end,
      'forward', case when p_restore then _op_json(array[p_op], false) else '[]'::json end,
      'ledger', json_build_object('before', nledger, 'after', (select count(*) from ledger where voided_at is null)),
      'students', _snap_diff(before, _snap()));
    if p_preview then raise exception using errcode = 'P0003', message = 'preview'; end if;
  exception
    when sqlstate 'P0003' then return result;
    when sqlstate 'P0002' then
      if sqlerrm like '그렇게 하면%' then raise; end if;
      raise exception '"%" 작업 뒤에 같은 기록을 바꾼 작업이 있거나 작업 내역 밖에서 바뀌어서, 이 작업만 %수 없어요. "이 시점으로"를 써 보세요',
        o.summary, case when p_restore then '다시 살릴 ' else '되돌릴 ' end using errcode = 'P0002';
  end;
  return result;
end $$;
create or replace function history_drop(p_token uuid, p_op bigint, p_preview boolean) returns json
language sql security definer set search_path = public as $$ select _history_one(p_token, p_op, false, p_preview) $$;
create or replace function history_restore(p_token uuid, p_op bigint, p_preview boolean) returns json
language sql security definer set search_path = public as $$ select _history_one(p_token, p_op, true, p_preview) $$;

-- 작업 내역 (최신순). undone인 작업은 "앞으로 가기"로 다시 적용할 수 있다.
create or replace function ops_list(p_token uuid, p_limit int) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform _session(p_token, true);
  return (select coalesce(json_agg(json_build_object('id', o.id, 'at', _kst(o.at), 'actor', o.actor, 'kind', o.kind, 'summary', o.summary,
      'undoable', o.undoable, 'undone', o.undone, 'dropped', o.dropped) order by o.id desc), '[]')
    from (select * from ops where kind <> 'scratch' order by id desc limit greatest(coalesce(p_limit, 50), 1)) o);
end $$;

-- 백업 파일 받기. 로그인 없이 누구나 부를 수 있다 (학급이 이름 공개를 괜찮다고 정했다).
-- jabong-backup 저장소의 GitHub Actions가 매일 부르고, 관리 탭의 "지금 백업 파일 받기"도 이것을 쓴다.
drop function if exists backup_dump(text);
drop function if exists admin_dump(uuid);
drop function if exists new_backup_key(uuid);
create or replace function backup_dump() returns jsonb language sql stable security definer set search_path = public as $$
  select _dump()
$$;

-- 백업 파일의 내용으로 데이터를 통째로 바꾼다. 비밀번호·로그인·사진은 그대로 둔다.
create or replace function restore_backup(p_token uuid, p_data jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); t jsonb := p_data -> 'tables';
begin
  perform _wlock();
  if p_data ->> 'format' is distinct from 'jabong-backup' or t is null then raise exception '자봉 장부 백업 파일이 아니에요'; end if;
  -- 되살리면 그 전 작업 로그는 지금 데이터와 맞지 않으니 비운다. 되살리기 자체는 되돌릴 수 없다.
  delete from ops where true;
  perform _op(who, 'restore_backup', format('백업에서 되살리기 (%s 백업)', p_data ->> 'createdAt'), false);
  delete from requests where true;
  delete from periods where true;
  delete from presets where true;
  delete from students where true;
  -- 자봉 면제 칸이 생기기 전 백업에는 exempt가 없으니 false로 채운다
  insert into students select (jsonb_populate_record(null::students, '{"exempt": false}'::jsonb || e)).* from jsonb_array_elements(t -> 'students') e;
  -- 교시 저장(kind)이 생기기 전 백업의 항목은 모두 'item'이다
  -- 직책별 항목(owner)이 생기기 전 백업의 항목은 부총대 것
  insert into presets select (jsonb_populate_record(null::presets, '{"kind": "item", "owner": "부총대"}'::jsonb || jsonb_strip_nulls(e))).* from jsonb_array_elements(t -> 'presets') e;
  insert into periods select * from jsonb_populate_recordset(null::periods, t -> 'periods');
  insert into attendance select * from jsonb_populate_recordset(null::attendance, t -> 'attendance');
  insert into ledger select * from jsonb_populate_recordset(null::ledger, t -> 'ledger');
  insert into ledger_private select * from jsonb_populate_recordset(null::ledger_private, t -> 'ledger_private');
  insert into ledger_revisions select * from jsonb_populate_recordset(null::ledger_revisions, t -> 'ledger_revisions');
  -- 사진은 백업에 없으니, 서버에 남아 있는 사진만 다시 연결한다
  insert into requests select (jsonb_populate_record(null::requests, e - 'photo_id'
    || jsonb_build_object('photo_id', case when exists (select 1 from photos where id::text = e ->> 'photo_id') then e -> 'photo_id' end))).*
    from jsonb_array_elements(coalesce(t -> 'requests', '[]')) e;
  insert into excuses select (jsonb_populate_record(null::excuses, e - 'photo_id'
    || jsonb_build_object('photo_id', case when exists (select 1 from photos where id::text = e ->> 'photo_id') then e -> 'photo_id' end))).*
    from jsonb_array_elements(coalesce(t -> 'excuses', '[]')) e;
  insert into attendance_requests select * from jsonb_populate_recordset(null::attendance_requests, t -> 'attendance_requests');
  -- 리액션이 생기기 전 백업에는 없다
  -- adj 칸이 생기기 전 백업에는 없으니 false로
  insert into reactions select (jsonb_populate_record(null::reactions, '{"adj": false}'::jsonb || e)).* from jsonb_array_elements(coalesce(t -> 'reactions', '[]')) e;
  -- 링크가 생기기 전 백업에는 없다 (그때는 링크도 없었으니 비운다)
  delete from links where true;
  insert into links select * from jsonb_populate_recordset(null::links, coalesce(t -> 'links', '[]'));
  return json_build_object('students', (select count(*) from students), 'ledger', (select count(*) from ledger), 'createdAt', p_data ->> 'createdAt');
end $$;

create or replace function purge(p_token uuid, p_cut date) returns json
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); old_n int; carry_n int := 0; rx_n int := 0; r record;
begin
  perform _wlock();
  if exists (select 1 from excuses x join ledger l on l.id = x.ledger_id where x.status = 'pending' and l.date <= p_cut)
     or exists (select 1 from attendance_requests a join periods p on p.id = a.period_id where a.status = 'pending' and p.date <= p_cut)
     or exists (select 1 from reactions where status = 'pending' and date <= p_cut) then
    raise exception '정리할 기간에 아직 처리하지 않은 공결 신청이나 출석 요청, 리액션 신청이 있어요. 요청함에서 먼저 처리하세요';
  end if;
  -- 정리하면 그 전 작업은 되돌릴 수 없으니 작업 로그를 비운다
  delete from ops where true;
  perform _op(who, 'purge', format('보관 후 정리 (%s까지)', to_char(p_cut, 'FMMM/FMDD')), false);
  select count(*) into old_n from ledger where date <= p_cut;
  create temp table _sums on commit drop as
    select student_id, sum(points) as pts from ledger where date <= p_cut and voided_at is null group by student_id;
  delete from ledger where date <= p_cut;
  for r in select * from _sums where pts <> 0 loop
    perform _entry(p_cut, r.student_id, '이월', format('%s까지 합계', to_char(p_cut, 'FMMM/FMDD')), r.pts, 'carry', null, null, who);
    carry_n := carry_n + 1;
  end loop;
  delete from excuses where ledger_id is null;
  delete from requests where status <> 'pending' and date <= p_cut;
  -- 리액션: 정리할 기간의 내역(질문·대답)은 모두 지우고, 학생별 이월(상점이 아직 안 된 승인 리액션 수)만
  -- 그 수만큼 이월 줄(adj)로 남긴다. 자봉 점수가 "이월" 한 줄로 남는 것과 같다.
  create temp table _rx on commit drop as
    select student_id, count(*) as n from reactions where date <= p_cut and status = 'approved' and merit is null group by student_id;
  select count(*) into rx_n from reactions where date <= p_cut and not adj;
  -- 받은 리액션 상점 수(묶음 수)도 묶음마다 한 줄씩 남긴다
  create temp table _rxm on commit drop as
    select distinct student_id, merit from reactions where date <= p_cut and merit is not null and merit <> _merit_cleared();
  delete from reactions where date <= p_cut;
  insert into reactions (student_id, date, period, question, answer, status, adj, reviewed_by, reviewed_at, created_at)
  select student_id, p_cut, '이월', '정리 이월', '', 'approved', true, who, now(), p_cut::timestamptz from _rx, generate_series(1, n);
  insert into reactions (student_id, date, period, question, answer, status, adj, merit, reviewed_by, reviewed_at, created_at)
  select student_id, p_cut, '이월', '정리 이월 (받은 상점)', '', 'approved', true, merit, who, now(), p_cut::timestamptz from _rxm
  where not exists (select 1 from reactions x where x.merit = _rxm.merit and x.student_id = _rxm.student_id);
  delete from periods where date <= p_cut;
  delete from photos p where not exists (select 1 from requests where photo_id = p.id) and not exists (select 1 from excuses where photo_id = p.id);
  return json_build_object('old', old_n, 'carry', carry_n, 'reactions', rx_n);
end $$;

-- 처음 한 번만: 모든 직책의 비밀번호를 정하고 복구 코드를 돌려준다. SQL Editor에서만 실행할 수 있다.
create or replace function init_app(p_pw text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare code text;
begin
  if (select recovery_hash from settings where id = 1) is not null then
    raise exception '이미 설정했어요. 비밀번호는 앱의 관리 탭에서 바꾸세요';
  end if;
  if length(coalesce(p_pw, '')) < 4 then raise exception '비밀번호는 4자 이상이어야 해요'; end if;
  update accounts set pw_hash = crypt(p_pw, gen_salt('bf')) where true;
  code := _new_code();
  update settings set recovery_hash = crypt(_norm_code(code), gen_salt('bf')) where id = 1;
  return code;
end $$;

-- 함수 실행 권한: 내부 도우미와 init_app은 막고, 화면이 부르는 함수만 연다
do $$ declare f text; begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on all functions in schema public from public, anon, authenticated';
    foreach f in array array[
      'public_state()', 'create_excuse(uuid,uuid,text,text)', 'create_excuse_day(uuid,date,text,text)', 'create_reaction(uuid,text,text,text)', 'my_reactions(uuid)', 'reaction_feed(integer)', 'reaction_adjust(uuid,jsonb)', 'reaction_export(uuid,date,date)', 'review_reaction(uuid,uuid[],boolean,text)', 'login(text,text)', 'recover(text,text,text)',
      'private_state(uuid)', 'logout(uuid)', 'get_photo(uuid,uuid)', 'create_request(uuid,date,uuid[],text,text,numeric,text,text)',
      'change_pw(uuid,text,text)', 'reset_pw(uuid,text,text)', 'new_recovery(uuid,text)', 'ensure_period(uuid,date,text,boolean)', 'delete_period(uuid,uuid)', 'rename_period(uuid,uuid,text)',
      'save_attendance(uuid,uuid,jsonb)', 'request_attendance(uuid,uuid,jsonb)', 'review_attendance(uuid,uuid,boolean,text)', 'add_entries(uuid,date,uuid[],text,text,numeric)', 'edit_entry(uuid,uuid,date,text,text,numeric,text)',
      'void_entry(uuid,uuid,text)', 'review_request(uuid,uuid,boolean,text)', 'review_excuse(uuid,uuid,boolean,text)',
      'roster_apply(uuid,jsonb,jsonb,date)', 'my_presets_save(uuid,jsonb)', 'my_periods_save(uuid,jsonb)', 'purge(uuid,date)', 'backup_dump()', 'restore_backup(uuid,jsonb)', 'history_move(uuid,bigint,boolean)', 'history_drop(uuid,bigint,boolean)', 'history_restore(uuid,bigint,boolean)', 'ops_list(uuid,integer)', 'set_link(uuid,text,text)'
    ] loop
      execute format('grant execute on function %s to anon, authenticated', f);
    end loop;
  end if;
end $$;

-- 앱(PostgREST)이 새 함수를 바로 알아보게 한다
notify pgrst, 'reload schema';
