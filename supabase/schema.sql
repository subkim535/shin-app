-- SHIN MASTER V4 web — 지금 실제로 쓰는 스키마.
-- 여러 사용자가 실시간으로 같은 공정표를 보고 고치게 하는 게 목표라, 지금 단계에서는
-- 프론트엔드의 전체 상태(동/공정/변경이력/특이사항/템플릿/현장정보)를 JSONB 하나로
-- 저장하고 Realtime으로 구독한다. 정규화된 테이블 구조는 나중에 로그인·권한이 필요해질
-- 때 schema_future_normalized.sql로 옮겨가면 된다 (프론트 비즈니스 로직은 그대로 재사용 가능).
--
-- 이 파일 전체를 Supabase 대시보드 SQL Editor에 붙여넣고 실행하세요.

create extension if not exists "pgcrypto";

create table if not exists schedule_state (
  site_key text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table schedule_state enable row level security;

-- 지금은 로그인 기능이 없어서 publishable(anon) key로 오는 모든 요청을 허용한다.
-- 내부 소수 인원 공유용이라 이렇게 열어두지만, URL이 새어나가면 누구나 수정 가능하니
-- 외부에 공개 배포할 계획이면 나중에 Supabase Auth로 로그인을 추가하고 이 정책을 좁혀야 한다.
create policy "anyone can read schedule_state" on schedule_state
  for select using (true);

create policy "anyone can upsert schedule_state" on schedule_state
  for insert with check (true);

create policy "anyone can update schedule_state" on schedule_state
  for update using (true) with check (true);

-- Realtime으로 UPDATE 이벤트를 받으려면 publication에 테이블을 추가해야 한다.
alter publication supabase_realtime add table schedule_state;
