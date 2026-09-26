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

create table if not exists presets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  points int not null,
  sort int not null default 0
);

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
  ('부총대', true, 1), ('총대', true, 2),
  ('실습부장 1', false, 3), ('실습부장 2', false, 4), ('운영부장', false, 5),
  ('총무', false, 6), ('학습부장', false, 7), ('정리부장', false, 8), ('치아부장', false, 9)
on conflict do nothing;

-- 출석 체크 권한 (부총대·총대는 항상 가능). 칸을 처음 만들 때만 실습부장에게 켜 두고, 이후에는 관리 탭에서 바꾼다.
do $$ begin
  if not exists (select 1 from information_schema.columns where table_name = 'accounts' and column_name = 'can_attend') then
    alter table accounts add column can_attend boolean not null default false;
    update accounts set can_attend = true where role in ('실습부장 1', '실습부장 2');
  end if;
end $$;

insert into presets (name, points, sort)
select * from (values ('지각', 1, 1), ('결석', 2, 2), ('실습실 뒷정리 미흡', 1, 3), ('실습', 1, 4), ('소치 실습', 1, 5), ('매점', -1, 6)) v
where not exists (select 1 from presets);

-- ───────────────────────── 권한 ─────────────────────────
-- 테이블은 모두 잠그고, app_version만 Realtime 알림용으로 읽기를 연다.

alter table students enable row level security;
alter table presets enable row level security;
alter table periods enable row level security;
alter table attendance enable row level security;
alter table ledger enable row level security;
alter table ledger_private enable row level security;
alter table ledger_revisions enable row level security;
alter table photos enable row level security;
alter table requests enable row level security;
alter table excuses enable row level security;
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
  update app_version set version = version + 1, updated_at = now() where id = 1;
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['students','presets','periods','attendance','ledger','ledger_revisions','requests','excuses'] loop
    execute format('drop trigger if exists bump on %I', t);
    execute format('create trigger bump after insert or update or delete on %I for each statement execute function _bump()', t);
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
  if p_admin and not adm then raise exception '부총대·총대만 할 수 있어요' using errcode = '42501'; end if;
  return r;
end $$;

-- 출석 체크는 부총대·총대와 출석 권한을 받은 총대단이 할 수 있다
create or replace function _session_attend(p_token uuid) returns text
language plpgsql security definer set search_path = public as $$
declare r text := _session(p_token, false);
begin
  if not exists (select 1 from accounts where role = r and (is_admin or can_attend)) then
    raise exception '출석 체크 권한이 없어요' using errcode = '42501';
  end if;
  return r;
end $$;

create or replace function _entry(p_date date, p_sid uuid, p_item text, p_detail text, p_points numeric, p_src text,
  p_period uuid, p_request uuid, p_by text, p_requested_by text default null, p_approved_by text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare nid uuid;
begin
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

-- 화면이 쓰는 전체 상태를 JSON 하나로 만든다. p_private가 아니면 이름·기록자를 뺀다.
create or replace function _state(p_private boolean) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'students', (select coalesce(json_agg(case when p_private
        then json_build_object('id', id, 'no', no, 'name', name, 'active', active)
        else json_build_object('id', id, 'no', no, 'active', active) end order by active desc, no), '[]')
      from students),
    'presets', (select coalesce(json_agg(json_build_object('id', id, 'name', name, 'points', points) order by sort, name), '[]') from presets),
    'periods', (select coalesce(json_agg(json_build_object('id', id, 'date', date, 'label', label, 'morning', morning) order by date, morning desc, label), '[]') from periods),
    'att', (select coalesce(json_object_agg(p.id, (select coalesce(json_object_agg(a.student_id, a.status), '{}') from attendance a where a.period_id = p.id)), '{}')
      from periods p where p.saved_at is not null),
    'ledger', (select coalesce(json_agg(json_build_object(
        'id', l.id, 'date', l.date, 'sid', l.student_id, 'item', l.item, 'detail', l.detail, 'points', l.points,
        'src', l.src, 'pid', l.period_id, 'at', _kst(l.created_at),
        'by', case when p_private then case when l.src = 'request' then lp.requested_by else lp.created_by end end,
        'approvedBy', case when p_private then lp.approved_by end,
        'voided', case when l.voided_at is null then null else json_build_object(
          'reason', l.void_reason, 'at', _kst(l.voided_at), 'by', case when p_private then lp.voided_by end) end,
        'revs', (select coalesce(json_agg(json_build_object('at', _kst(r.edited_at), 'before', r.before, 'after', r.after,
            'reason', r.reason, 'by', case when p_private then r.edited_by end) order by r.edited_at), '[]')
          from ledger_revisions r where r.ledger_id = l.id)
      ) order by l.date, l.created_at), '[]')
      from ledger l left join ledger_private lp on lp.ledger_id = l.id),
    'excuses', (select coalesce(json_agg(json_build_object(
        'id', x.id, 'sid', x.student_id, 'eid', x.ledger_id, 'reason', x.reason, 'status', x.status,
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
    'accounts', (select json_agg(json_build_object('role', role, 'admin', is_admin, 'attend', is_admin or can_attend) order by sort) from accounts),
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
  -- 출석 체크로 생긴 것뿐 아니라 직접 기록하거나 요청으로 들어온 지각·결석도 공결 신청할 수 있다
  if not exists (select 1 from ledger where id = p_ledger and student_id = p_student and voided_at is null
      and item in ('지각', '결석') and src in ('att', 'manual', 'request')) then
    raise exception '공결 신청할 수 있는 출결 기록이 아니에요';
  end if;
  if exists (select 1 from excuses where ledger_id = p_ledger and status = 'pending') then
    raise exception '이미 신청해서 확인을 기다리는 중이에요';
  end if;
  insert into excuses (student_id, ledger_id, reason, photo_id)
  values (p_student, p_ledger, left(coalesce(trim(p_reason), ''), 500), _photo(p_photo))
  returning id into nid;
  return nid;
end $$;

create or replace function login(p_role text, p_pw text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare a accounts; t uuid;
begin
  select * into a from accounts where role = p_role;
  if not found or a.pw_hash is null then return json_build_object('error', '직책을 확인하세요'); end if;
  if a.locked_until > now() then
    return json_build_object('error', format('비밀번호를 여러 번 틀려서 잠겼어요. %s분 뒤에 다시 해보세요', ceil(extract(epoch from a.locked_until - now()) / 60)));
  end if;
  if a.pw_hash <> crypt(coalesce(p_pw, ''), a.pw_hash) then
    update accounts set fails = case when fails + 1 >= 5 then 0 else fails + 1 end,
      locked_until = case when fails + 1 >= 5 then now() + interval '10 minutes' end
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
  select * into s from settings where id = 1;
  if s.recovery_locked_until > now() then return json_build_object('error', '복구 코드를 여러 번 틀렸어요. 10분 뒤에 다시 해보세요'); end if;
  if s.recovery_hash is null or s.recovery_hash <> crypt(_norm_code(p_code), s.recovery_hash) then
    update settings set recovery_fails = case when recovery_fails + 1 >= 5 then 0 else recovery_fails + 1 end,
      recovery_locked_until = case when recovery_fails + 1 >= 5 then now() + interval '10 minutes' end where id = 1;
    return json_build_object('error', '복구 코드가 맞지 않아요');
  end if;
  if not exists (select 1 from accounts where role = p_role and is_admin) then return json_build_object('error', '부총대나 총대만 복구할 수 있어요'); end if;
  if length(coalesce(p_new, '')) < 4 then return json_build_object('error', '새 비밀번호는 4자 이상이어야 해요'); end if;
  code := _new_code();
  update settings set recovery_hash = crypt(_norm_code(code), gen_salt('bf')), recovery_fails = 0, recovery_locked_until = null where id = 1;
  update accounts set pw_hash = crypt(p_new, gen_salt('bf')), fails = 0, locked_until = null where role = p_role;
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
  -- 공결 증빙(진료확인서 등)은 부총대·총대만 본다
  if exists (select 1 from excuses where photo_id = p_id) then perform _session(p_token, true); end if;
  return (select data from photos where id = p_id);
end $$;

create or replace function create_request(p_token uuid, p_date date, p_sids uuid[], p_item text, p_detail text, p_points numeric, p_reason text, p_photo text)
returns uuid language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, false); nid uuid;
begin
  perform _check_items(p_item, p_points);
  if coalesce(array_length(p_sids, 1), 0) = 0 then raise exception '학생을 골라 주세요'; end if;
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
end $$;

-- ───────────────────────── 부총대·총대 전용 ─────────────────────────

create or replace function reset_pw(p_token uuid, p_role text, p_new text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare who text := _session(p_token, true);
begin
  if length(coalesce(p_new, '')) < 4 then raise exception '새 비밀번호는 4자 이상이어야 해요'; end if;
  update accounts set pw_hash = crypt(p_new, gen_salt('bf')), fails = 0, locked_until = null where role = p_role;
  if not found then raise exception '없는 직책이에요'; end if;
  delete from sessions where role = p_role;
end $$;

create or replace function set_attend(p_token uuid, p_role text, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true);
begin
  update accounts set can_attend = coalesce(p_on, false) where role = p_role and not is_admin;
  if not found then raise exception '총대단 직책만 바꿀 수 있어요'; end if;
  update app_version set version = version + 1, updated_at = now() where id = 1;
end $$;

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
  if coalesce(trim(p_label), '') = '' then raise exception '교시 이름을 입력하세요'; end if;
  select id into pid from periods where date = p_date and label = trim(p_label);
  if pid is null then
    insert into periods (date, label, morning) values (p_date, trim(p_label), coalesce(p_morning, false)) returning id into pid;
  end if;
  return pid;
end $$;

-- 한 교시의 출결을 저장한다. p_statuses = {학생 id: 'late'|'absent'|'excused'} (없으면 출석)
create or replace function save_attendance(p_token uuid, p_period uuid, p_statuses jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  who text := _session_attend(p_token);
  per periods; st record; want text; want_item text; cur ledger; pts int; n int := 0;
begin
  select * into per from periods where id = p_period;
  if not found then raise exception '교시를 찾을 수 없어요'; end if;
  update periods set saved_at = now() where id = p_period;
  delete from attendance where period_id = p_period;
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
    if want_item is not null and (cur.id is null or cur.item <> want_item) then
      select points into pts from presets where name = want_item order by sort limit 1;
      perform _entry(per.date, st.id, want_item, per.label, coalesce(pts, case want_item when '지각' then 1 else 2 end), 'att', p_period, null, who);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function add_entries(p_token uuid, p_date date, p_sids uuid[], p_item text, p_detail text, p_points numeric) returns int
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); sid uuid; n int := 0;
begin
  perform _check_items(p_item, p_points);
  foreach sid in array p_sids loop
    perform _entry(p_date, sid, trim(p_item), trim(p_detail), p_points, 'manual', null, null, who);
    n := n + 1;
  end loop;
  if n = 0 then raise exception '학생을 골라 주세요'; end if;
  return n;
end $$;

create or replace function edit_entry(p_token uuid, p_id uuid, p_date date, p_item text, p_detail text, p_points numeric, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); e ledger; b jsonb := '{}'; a jsonb := '{}';
begin
  if coalesce(trim(p_reason), '') = '' then raise exception '수정 사유를 입력하세요'; end if;
  perform _check_items(p_item, p_points);
  select * into e from ledger where id = p_id;
  if not found then raise exception '기록을 찾을 수 없어요'; end if;
  if e.date <> p_date then b := b || jsonb_build_object('date', e.date); a := a || jsonb_build_object('date', p_date); end if;
  if e.item <> trim(p_item) then b := b || jsonb_build_object('item', e.item); a := a || jsonb_build_object('item', trim(p_item)); end if;
  if e.detail <> coalesce(trim(p_detail), '') then b := b || jsonb_build_object('detail', e.detail); a := a || jsonb_build_object('detail', coalesce(trim(p_detail), '')); end if;
  if e.points <> p_points then b := b || jsonb_build_object('points', e.points); a := a || jsonb_build_object('points', p_points); end if;
  if a = '{}' then raise exception '바뀐 내용이 없어요'; end if;
  update ledger set date = p_date, item = trim(p_item), detail = coalesce(trim(p_detail), ''), points = p_points where id = p_id;
  insert into ledger_revisions (ledger_id, before, after, reason, edited_by) values (p_id, b, a, trim(p_reason), who);
end $$;

create or replace function void_entry(p_token uuid, p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true);
begin
  if coalesce(trim(p_reason), '') = '' then raise exception '무효 처리 사유를 입력하세요'; end if;
  if not exists (select 1 from ledger where id = p_id and voided_at is null) then raise exception '이미 무효 처리된 기록이에요'; end if;
  perform _void(p_id, trim(p_reason), who);
end $$;

create or replace function review_request(p_token uuid, p_id uuid, p_approve boolean, p_note text) returns int
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); r requests; sid uuid; n int := 0;
begin
  select * into r from requests where id = p_id for update;
  if not found or r.status <> 'pending' then raise exception '이미 처리된 요청이에요'; end if;
  if p_approve then
    foreach sid in array r.student_ids loop
      if exists (select 1 from students where id = sid) then
        perform _entry(r.date, sid, r.item, r.detail, r.points, 'request', null, r.id, who, r.requested_by, who);
        n := n + 1;
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
declare who text := _session(p_token, true); x excuses; e ledger;
begin
  select * into x from excuses where id = p_id for update;
  if not found or x.status <> 'pending' then raise exception '이미 처리된 신청이에요'; end if;
  if p_approve then
    select * into e from ledger where id = x.ledger_id;
    if e.id is not null and e.voided_at is null then
      perform _void(e.id, case when x.reason <> '' then format('공결 승인 (%s)', x.reason) else '공결 승인' end, who);
      if e.period_id is not null then
        update periods set saved_at = coalesce(saved_at, now()) where id = e.period_id;
        insert into attendance (period_id, student_id, status) values (e.period_id, x.student_id, 'excused')
        on conflict (period_id, student_id) do update set status = 'excused';
      end if;
    end if;
    update excuses set status = 'approved', reviewed_by = who, reviewed_at = now() where id = p_id;
  else
    if coalesce(trim(p_note), '') = '' then raise exception '반려 사유를 입력하세요'; end if;
    update excuses set status = 'rejected', review_note = trim(p_note), reviewed_by = who, reviewed_at = now() where id = p_id;
  end if;
end $$;

-- 명단 변경을 한 번에 적용한다.
-- p_ops: [{op:'add',name,no} | {op:'renum'|'restore',id,no} | {op:'remove',id} | {op:'rename',id,name}]
-- p_adjs: [{name, to}]  — 해당 학생의 자봉이 to가 되도록 차이만큼 기록을 더한다
create or replace function roster_apply(p_token uuid, p_ops jsonb, p_adjs jsonb, p_date date) returns int
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); o jsonb; a jsonb; sid uuid; cur numeric; fresh boolean; n int := 0;
begin
  -- 번호를 바꿀 학생은 잠시 명단에서 빼 두어야 번호를 서로 맞바꿀 수 있다
  update students set active = false
  where id in (select (x ->> 'id')::uuid from jsonb_array_elements(coalesce(p_ops, '[]')) x where x ->> 'op' in ('renum', 'remove'));
  for o in select * from jsonb_array_elements(coalesce(p_ops, '[]')) loop
    case o ->> 'op'
      when 'add' then insert into students (no, name) values ((o ->> 'no')::int, coalesce(o ->> 'name', ''));
      when 'renum', 'restore' then update students set no = (o ->> 'no')::int, active = true where id = (o ->> 'id')::uuid;
      when 'rename' then update students set name = coalesce(o ->> 'name', '') where id = (o ->> 'id')::uuid;
      when 'remove' then null;
      else raise exception '알 수 없는 명단 작업이에요';
    end case;
    n := n + 1;
  end loop;
  for a in select * from jsonb_array_elements(coalesce(p_adjs, '[]')) loop
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

create or replace function presets_save(p_token uuid, p_list jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); p jsonb; i int := 0;
begin
  -- Supabase는 앱에서 온 요청이 where 없는 delete/update를 하면 막는다 (pg_safeupdate)
  delete from presets where true;
  for p in select * from jsonb_array_elements(coalesce(p_list, '[]')) loop
    i := i + 1;
    if coalesce(trim(p ->> 'name'), '') <> '' then
      insert into presets (name, points, sort) values (trim(p ->> 'name'), (p ->> 'points')::int, i);
    end if;
  end loop;
  if not exists (select 1 from presets where name = '지각') then insert into presets (name, points, sort) values ('지각', 1, 0); end if;
  if not exists (select 1 from presets where name = '결석') then insert into presets (name, points, sort) values ('결석', 2, 0); end if;
end $$;

-- 기준 날짜까지의 기록을 학생별 "이월" 한 줄로 합친다. 점수는 그대로 유지된다.
create or replace function purge(p_token uuid, p_cut date) returns json
language plpgsql security definer set search_path = public as $$
declare who text := _session(p_token, true); old_n int; carry_n int := 0; r record;
begin
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
  delete from periods where date <= p_cut;
  delete from photos p where not exists (select 1 from requests where photo_id = p.id) and not exists (select 1 from excuses where photo_id = p.id);
  return json_build_object('old', old_n, 'carry', carry_n);
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
      'public_state()', 'create_excuse(uuid,uuid,text,text)', 'login(text,text)', 'recover(text,text,text)',
      'private_state(uuid)', 'logout(uuid)', 'get_photo(uuid,uuid)', 'create_request(uuid,date,uuid[],text,text,numeric,text,text)',
      'change_pw(uuid,text,text)', 'reset_pw(uuid,text,text)', 'set_attend(uuid,text,boolean)', 'new_recovery(uuid,text)', 'ensure_period(uuid,date,text,boolean)',
      'save_attendance(uuid,uuid,jsonb)', 'add_entries(uuid,date,uuid[],text,text,numeric)', 'edit_entry(uuid,uuid,date,text,text,numeric,text)',
      'void_entry(uuid,uuid,text)', 'review_request(uuid,uuid,boolean,text)', 'review_excuse(uuid,uuid,boolean,text)',
      'roster_apply(uuid,jsonb,jsonb,date)', 'presets_save(uuid,jsonb)', 'purge(uuid,date)'
    ] loop
      execute format('grant execute on function %s to anon, authenticated', f);
    end loop;
  end if;
end $$;
