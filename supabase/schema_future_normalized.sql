-- 참고용: 인증/권한(auth.users, site_members)까지 갖췄을 때를 위한 정규화 스키마 초안.
-- 지금 당장 쓰는 건 schema.sql(JSONB 단일 문서 방식)이고, 이 파일은 나중에
-- 로그인·역할별 권한이 필요해지면 마이그레이션할 목표 구조로 남겨둔다.

create extension if not exists "pgcrypto";

create table sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table blocks (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  name text not null,
  sort_order int not null,
  created_at timestamptz not null default now(),
  unique (site_id, name)
);

create table process_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text not null check (category in ('main','sub')),
  main_sequence int,
  show_floor_label boolean not null default false,
  created_at timestamptz not null default now()
);

create table processes (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  block_id uuid not null references blocks(id) on delete cascade,
  process_type_id uuid not null references process_types(id),
  work_date date not null,
  floor_label text,
  linked_main_process_id uuid references processes(id),
  status text not null default 'active' check (status in ('active','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on processes (site_id, block_id, work_date);

create table holidays (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  holiday_date date not null,
  kind text not null check (kind in ('sunday','public_holiday','substitute_holiday','temporary_holiday')),
  note text,
  unique (site_id, holiday_date)
);

create table change_history (
  id uuid primary key default gen_random_uuid(),
  process_id uuid not null references processes(id) on delete cascade,
  previous_date date not null,
  new_date date not null,
  reason text not null,
  changed_by uuid not null,
  changed_at timestamptz not null default now()
);
create index on change_history (process_id, changed_at);

create table conflicts (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  work_date date not null,
  process_group text not null,
  process_id uuid not null references processes(id) on delete cascade,
  sequence_no int not null,
  unique (site_id, work_date, process_group, sequence_no)
);

create table site_members (
  site_id uuid not null references sites(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'editor' check (role in ('viewer','editor','admin')),
  primary key (site_id, user_id)
);
