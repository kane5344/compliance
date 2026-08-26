-- ============================================================
-- 심의번호 주체명 변경 : 아정당 → 아정인슈어런스
--   "아정당 준법심의필 제2026-0001호"
--   → "아정인슈어런스 준법심의필 제2026-0001호"
--
-- ★ 확정 접두어는 "아정인슈어런스 준법심의필" (아정당인슈어런스 아님).
--   1차 적용 때 "아정당인슈어런스"로 잘못 넣었다가 같은 날 재정정했다.
--   아래 SQL 은 두 구 접두어("아정당 …", "아정당인슈어런스 …") 모두를
--   확정 접두어로 수렴시킨다. 코드측 상수는 ComplianceReviewManager.jsx 의 ORG_PREFIX.
--
-- ★ 실행 완료 : 2026-08-26, REST API(anon key) 적용.
--   1차 아정당 → 아정당인슈어런스 374건 / 실패 0건
--   2차 아정당인슈어런스 → 아정인슈어런스 374건 / 실패 0건
--   최종 검증: 구 접두어 잔존 0건, 확정 접두어 374건, 중복 0건, 번호 1~374 결번 0건.
--   변경 전 원본(아정당 …)은 20260826_org_prefix_rename.backup.json 에 보관(375건).
--
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 실행.
-- 재실행 안전(idempotent): 이미 변환된 행은 조건에 걸리지 않는다.
-- ============================================================

-- ---------- 0. 실행 전 확인 (몇 건이 바뀌는지) ----------
select
  count(*) filter (where review_no like '아정당 준법심의필%')          as 구접두어_아정당,
  count(*) filter (where review_no like '아정당인슈어런스 준법심의필%') as 구접두어_아정당인슈어런스,
  count(*) filter (where review_no like '아정인슈어런스 준법심의필%')   as 확정접두어
from public.review_number;

-- ---------- 1. 백업 스냅샷 (문제 시 복구용) ----------
create table if not exists public.review_number_backup_20260826 as
select id, review_no from public.review_number
where review_no like '아정당%';

-- ---------- 2. 일괄 변경 ----------
-- 긴 접두어를 먼저 처리해야 한다. '아정당 준법심의필' 을 먼저 바꾸면
-- '아정당인슈어런스…' 는 애초에 매칭되지 않으므로 순서 무관하지만,
-- 두 갈래를 한 문장으로 수렴시켜 실수 여지를 없앤다.
update public.review_number
set review_no = regexp_replace(
      review_no,
      '^(아정당인슈어런스|아정당) 준법심의필',
      '아정인슈어런스 준법심의필'
    )
where review_no like '아정당인슈어런스 준법심의필%'
   or review_no like '아정당 준법심의필%';

-- ---------- 3. 결과 검증 ----------
-- 구 접두어 2종 모두 0 이어야 한다.
select
  count(*) filter (where review_no like '아정당 준법심의필%')          as 미변경_아정당,
  count(*) filter (where review_no like '아정당인슈어런스 준법심의필%') as 미변경_아정당인슈어런스,
  count(*) filter (where review_no like '아정인슈어런스 준법심의필%')   as 확정접두어,
  count(*) filter (where review_no is not null
                     and review_no not like '아정%')                    as 협회번호_등_기타
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
--   ※ 정정 이력을 note(비고) 에 적었다가 "0013" 검색에 잡혀 2026-08-26 제거했다.
--     이후 앱 검색에서 note 를 제외했으므로(hay = review_no·title·product·
--     applicant·usages.url) 지금은 비고에 적어도 검색에 걸리지 않는다.
--     다만 번호 변경 이력은 이 파일과 backup.json 으로 관리하는 편이 낫다.
-- ============================================================
-- update public.review_number
-- set review_no = '아정인슈어런스 준법심의필 제2026-0374호'   -- note 는 건드리지 않는다
-- where id = 29;

-- ---------- 중복 감시 쿼리 (정기 점검용) ----------
select review_no, count(*) as 건수, array_agg(id order by id) as ids
from public.review_number
where review_no is not null and review_no <> ''
group by review_no
having count(*) > 1;
