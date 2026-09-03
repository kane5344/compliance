// 엑셀 다운로드/업로드 헬퍼 (SheetJS, 브라우저)
import * as XLSX from "xlsx";

// 화면 컬럼 순서로 내보내기용 행 구성
const CAT_LABEL = { 사내준법: "사내준법(내부)", 생보협회: "생명보험협회", 손보협회: "손해보험협회" };

function usagesToText(usages) {
  if (!Array.isArray(usages) || usages.length === 0) return "";
  return usages
    .filter((u) => u && (u.channel || u.url))
    .map((u) => `${u.channel || ""}${u.url ? `: ${u.url}` : ""}`)
    .join(" | ");
}

// review_number 행 배열 → 엑셀 다운로드
export function exportRows(rows, { filenameBase }) {
  const data = rows.map((r) => ({
    구분: CAT_LABEL[r.category] || r.category,
    심의번호: r.review_no || "",
    자료명: r.title || "",
    매체: r.media_type || "",
    "상품/제휴사": r.product || "",
    담당자: r.applicant || "",
    승인자: r.approver || "",
    신청일: r.applied_date || "",
    심의일: r.reviewed_date || "",
    심의결과: r.result || "",
    유효시작: r.valid_from || "",
    유효종료: r.valid_to || "",
    "사용처(채널:URL)": usagesToText(r.usages),
    "URL등록여부": (r.usages || []).some((u) => u.url && u.url.trim()) ? "등록" : "미등록",
    비고: r.note || "",
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  // 열 너비 대략치
  ws["!cols"] = [
    { wch: 14 }, { wch: 24 }, { wch: 34 }, { wch: 10 }, { wch: 20 },
    { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
    { wch: 12 }, { wch: 12 }, { wch: 40 }, { wch: 10 }, { wch: 30 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "심의목록");
  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${filenameBase}_${today}.xlsx`);
}

// 사내준법 대량 업로드용 양식 다운로드 (컬럼 + 예시 1행 + 안내)
export function downloadUploadTemplate() {
  const headers = [
    "자료명(필수)", "매체(필수)", "상품/제휴사", "신청일", "심의일",
    "심의결과", "유효시작", "유효종료", "담당자", "사용처URL", "비고",
  ];
  const example = [
    "제휴카드 X 보험 크로스셀 블로그 3월호",
    "블로그",
    "통신·렌탈 제휴카드 연계",
    "2026-03-02",
    "2026-03-05",
    "승인",
    "2026-03-05",
    "2026-06-05",
    "정담당",
    "https://blog.naver.com/ajeongdang/223011",
    "비고 예시(비워도 됨)",
  ];
  const guide = [
    "※ 사내준법 대량 등록 양식 — 심의번호는 업로드 시 자동 생성됩니다(입력 불필요).",
  ];
  const guide2 = [
    "※ 매체 예: 블로그/네이버카페/영상/유튜브/홈페이지/랜딩페이지/알림톡/DM/SMS/전단/스크립트/기타 · 날짜는 2026-03-02 형식",
  ];
  const guide3 = [
    "※ 사용처URL은 1건만 기입(추가 게시처는 업로드 후 개별 등록). 비워도 등록되며, 목록에서 'URL 미등록'으로 표시됩니다.",
  ];

  const aoa = [headers, example, [], guide, guide2, guide3];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 36 }, { wch: 12 }, { wch: 22 }, { wch: 12 }, { wch: 12 },
    { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 40 }, { wch: 24 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "사내준법_업로드양식");
  XLSX.writeFile(wb, "사내준법_대량등록_양식.xlsx");
}

// 업로드된 파일(File) → 파싱된 행 배열. 헤더 유연 매칭.
export async function parseUploadFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  // 헤더 키 정규화(괄호·공백 제거)
  const norm = (k) => String(k).replace(/\(.*?\)/g, "").replace(/\s/g, "").trim();
  const pick = (obj, names) => {
    for (const key of Object.keys(obj)) {
      const nk = norm(key);
      if (names.includes(nk)) return obj[key];
    }
    return "";
  };

  const out = [];
  const errors = [];
  rows.forEach((raw, idx) => {
    // 안내문(※) 행 스킵
    const firstVal = String(Object.values(raw)[0] || "");
    if (firstVal.startsWith("※") || firstVal.trim() === "") return;

    const title = String(pick(raw, ["자료명"])).trim();
    const media = String(pick(raw, ["매체"])).trim();
    if (!title || !media) {
      errors.push({ line: idx + 2, reason: "자료명·매체 필수 누락" });
      return;
    }
    const url = String(pick(raw, ["사용처URL", "사용처", "URL"])).trim();
    out.push({
      title,
      media_type: media,
      product: String(pick(raw, ["상품/제휴사", "상품", "제휴사"])).trim(),
      applied_date: normDate(pick(raw, ["신청일"])),
      reviewed_date: normDate(pick(raw, ["심의일"])),
      result: String(pick(raw, ["심의결과", "결과"])).trim() || "승인",
      valid_from: normDate(pick(raw, ["유효시작"])),
      valid_to: normDate(pick(raw, ["유효종료"])),
      applicant: String(pick(raw, ["담당자"])).trim(),
      note: String(pick(raw, ["비고"])).trim(),
      usages: url ? [{ channel: media, url }] : [],
    });
  });
  return { rows: out, errors };
}

// 엑셀 날짜(문자열 또는 serial) → YYYY-MM-DD 또는 ""
function normDate(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number") {
    // 엑셀 serial date
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const s = String(v).trim();
  const m = s.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return "";
}
