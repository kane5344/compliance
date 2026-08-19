-- ============================================================
-- 준법심의번호 관리 테이블 + RLS
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 실행하세요.
-- ============================================================

create table if not exists public.review_number (
  id            bigint generated always as identity primary key,
  category      text not null,              -- 사내준법 / 생보협회 / 손보협회
  review_no     text,                       -- 심의번호 (사내는 자동생성, 협회는 수동)
  title         text not null,              -- 자료명
  media_type    text,                       -- 대표 매체
  product       text,                       -- 상품 / 제휴사
  applied_date  date,
  reviewed_date date,
  result        text,                       -- 심사중/승인/조건부승인/부적합/재심
  valid_from    date,
  valid_to      date,
  applicant     text,
  approver      text,
  usages        jsonb not null default '[]'::jsonb,  -- [{channel, url}, ...]
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- updated_at 자동 갱신
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_review_number_updated on public.review_number;
create trigger trg_review_number_updated
  before update on public.review_number
  for each row execute function public.set_updated_at();

-- ============================================================
-- RLS: 로그인(authenticated)한 사용자만 접근. anon 은 전면 차단.
-- ============================================================
alter table public.review_number enable row level security;

drop policy if exists "auth read"   on public.review_number;
drop policy if exists "auth insert" on public.review_number;
drop policy if exists "auth update" on public.review_number;
drop policy if exists "auth delete" on public.review_number;

create policy "auth read"   on public.review_number for select to authenticated using (true);
create policy "auth insert" on public.review_number for insert to authenticated with check (true);
create policy "auth update" on public.review_number for update to authenticated using (true) with check (true);
create policy "auth delete" on public.review_number for delete to authenticated using (true);

-- ============================================================
-- 초기 예시(더미) 데이터 : 제거함.
-- 재실행 시 더미가 다시 생기지 않도록 seed insert 를 두지 않는다.
-- ============================================================
