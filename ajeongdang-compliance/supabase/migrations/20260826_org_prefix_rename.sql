-- ============================================================
-- 심의번호 주체명 변경 : 아정당 → 아정당인슈어런스
--   "아정당 준법심의필 제2026-0001호"
--   → "아정당인슈어런스 준법심의필 제2026-0001호"
--
-- ★ 실행 완료 : 2026-08-26, REST API(anon key)로 374건 적용 / 실패 0건.
--   변경 전 원본 값은 20260826_org_prefix_rename.backup.json 에 보관(id/review_no 375건).
--   아래 SQL 은 이력 보존 + 재실행/타 환경 적용용. 이미 적용된 DB 에 돌려도 0건 변경.
--
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 실행.
-- 재실행 안전(idempotent): 이미 변환된 행은 조건에 걸리지 않는다.
-- ============================================================

-- ---------- 0. 실행 전 확인 (몇 건이 바뀌는지) ----------
select count(*) as 변경대상건수
from public.review_number
where review_no like '아정당 준법심의필%';

-- ---------- 1. 백업 스냅샷 (문제 시 복구용) ----------
create table if not exists public.review_number_backup_20260826 as
select id, review_no from public.review_number
where review_no like '아정당 준법심의필%';

-- ---------- 2. 일괄 변경 ----------
update public.review_number
set review_no = regexp_replace(review_no, '^아정당 준법심의필', '아정당인슈어런스 준법심의필')
where review_no like '아정당 준법심의필%';

-- ---------- 3. 결과 검증 ----------
-- 남아있는 구 접두어 = 0 이어야 한다.
select
  count(*) filter (where review_no like '아정당 준법심의필%')            as 미변경_구접두어,
  count(*) filter (where review_no like '아정당인슈어런스 준법심의필%') as 신접두어,
  count(*) filter (where review_no is not null
                     and review_no not like '아정당%')                   as 협회번호_등_기타
from public.review_number;

-- ---------- 4. 복구 방법 (필요시에만 실행) ----------
-- update public.review_number r
-- set review_no = b.review_no
-- from public.review_number_backup_20260826 b
-- where r.id = b.id;

-- ---------- 5. 정리 (검증 끝난 뒤) ----------
-- drop table public.review_number_backup_20260826;


-- ============================================================
-- [후속] 심의번호 중복 정정 : 제2026-0013호
--   원인 : #29 가 2026-08-13 수동등록으로 제2026-0013호를 보유한 상태에서,
--          2026-08-24 대량등록 373건이 0001호부터 시작해 0013호가 겹쳤다.
--          (앱 엑셀업로드는 기존 최댓값+1 부여 → 해당 배치는 앱을 거치지 않은 직접 import)
--   판단 : 사용처 URL 이 등록된(=실제 게시된) #415 가 0013호 유지,
--          URL 공란인 #29 를 다음 미사용 번호 0374호로 재부여.
--   실행 : 2026-08-26 REST API 적용 완료. 잔존 중복 0건, 번호 1~374 결번 0건.
--
--   ※ #30 "아정-준법-2026-3823-0023-광고"(담당 전진)는 구 번호체계로 의도적 보존.
--
--   ※ 정정 이력을 note(비고) 에 적지 말 것.
--     앱 검색이 note 까지 훑기 때문에(review_no·title·product·applicant·usages.url·note)
--     비고에 옛 번호를 남기면 폐기된 번호로 검색해도 이 행이 계속 잡힌다.
--     실제로 #29 비고에 이력을 넣었다가 "0013" 검색에 잡혀 2026-08-26 제거했다.
--     번호 변경 이력은 이 파일과 backup.json 으로만 관리한다.
-- ============================================================
-- update public.review_number
-- set review_no = '아정당인슈어런스 준법심의필 제2026-0374호'   -- note 는 건드리지 않는다
-- where id = 29;

-- ---------- 중복 감시 쿼리 (정기 점검용) ----------
select review_no, count(*) as 건수, array_agg(id order by id) as ids
from public.review_number
where review_no is not null and review_no <> ''
group by review_no
having count(*) > 1;
