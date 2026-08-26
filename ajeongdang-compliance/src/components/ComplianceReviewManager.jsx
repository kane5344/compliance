import React, { useState, useMemo, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase.js";
import AdminPanel from "./AdminPanel.jsx";
import {
  Search, Plus, Pencil, Trash2, X, ShieldCheck, AlertTriangle,
  Clock, Filter, Wand2, Link2, ChevronDown, LogOut, RefreshCw, Users,
  Download, Upload, FileSpreadsheet,
} from "lucide-react";
import { exportRows, downloadUploadTemplate, parseUploadFile } from "../lib/excel.js";

/**
 * 준법심의번호 통합 관리 — Supabase 연동판
 * 테이블: review_number (컬럼은 아래 필드명과 1:1, snake_case)
 * RLS: authenticated 만 read/write (supabase/schema.sql 참고)
 */

const ORG_PREFIX = "아정당인슈어런스 준법심의필"; // ← 주체명 변경 시 여기만 수정
const FIXED_APPROVER = "유석일"; // 준법감시인(대행). 변경 시 여기만 수정

const CATEGORIES = ["사내준법", "생보협회", "손보협회"];
const INTERNAL_CAT = "사내준법";
const EXTERNAL_CATS = ["생보협회", "손보협회"];
// 외부심의 탭 안 생/손 넛지 배지(작게, 레이아웃 영향 최소)
const SUB_BADGE = {
  생보협회: { short: "생", cls: "bg-sky-100 text-sky-700" },
  손보협회: { short: "손", cls: "bg-violet-100 text-violet-700" },
};
const MEDIA_TYPES = ["블로그", "영상", "홈페이지", "랜딩페이지", "알림톡", "DM", "SMS", "전단", "스크립트", "기타"];
const RESULTS = ["심사중", "승인", "조건부승인", "부적합", "재심"];

const EXPIRY_SOON_DAYS = 30;

const iso = (d) => d.toISOString().slice(0, 10);
const DATE_FIELDS = ["applied_date", "reviewed_date", "valid_from", "valid_to"];

function nextInternalNo(rows) {
  const year = new Date().getFullYear();
  const re = new RegExp(`제${year}-(\\d+)호`);
  let max = 0;
  rows.forEach((r) => {
    if (r.category === "사내준법" && r.review_no) {
      const m = r.review_no.match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  });
  return `${ORG_PREFIX} 제${year}-${String(max + 1).padStart(4, "0")}호`;
}

function daysLeft(validTo) {
  if (!validTo) return null;
  const t = new Date(iso(new Date()));
  return Math.round((new Date(validTo) - t) / 86400000);
}
function deriveStatus(row) {
  if (row.result === "심사중") return { key: "review", label: "심사중" };
  if (row.result === "부적합") return { key: "rejected", label: "부적합" };
  if (row.result === "재심") return { key: "recheck", label: "재심" };
  const d = daysLeft(row.valid_to);
  if (d === null) return { key: "valid", label: "유효(기한없음)" };
  if (d < 0) return { key: "expired", label: "만료됨" };
  if (d <= EXPIRY_SOON_DAYS) return { key: "soon", label: `만료임박 D-${d}` };
  return { key: "valid", label: `유효 D-${d}` };
}
const STATUS_STYLE = {
  valid: "bg-emerald-50 text-emerald-700 border-emerald-200",
  soon: "bg-amber-50 text-amber-700 border-amber-200",
  expired: "bg-red-50 text-red-700 border-red-200",
  review: "bg-slate-100 text-slate-600 border-slate-200",
  recheck: "bg-orange-50 text-orange-700 border-orange-200",
  rejected: "bg-slate-100 text-slate-400 border-slate-200 line-through",
};
const ROW_ACCENT = {
  valid: "border-l-emerald-400", soon: "border-l-amber-400",
  expired: "border-l-red-400", review: "border-l-slate-300",
  recheck: "border-l-orange-400", rejected: "border-l-slate-200",
};

const emptyRow = (category = "사내준법") => ({
  id: null, category, review_no: "", title: "", media_type: "블로그",
  product: "", applied_date: iso(new Date()), reviewed_date: "", result: "심사중",
  valid_from: "", valid_to: "", applicant: "", approver: FIXED_APPROVER, usages: [], note: "",
});

// 빈 날짜 문자열 → null (date 컬럼 대응), 화면용 필드 제거
function toDbRow(row) {
  const { id, ...rest } = row;
  const out = { ...rest };
  DATE_FIELDS.forEach((f) => { if (!out[f]) out[f] = null; });
  if (!Array.isArray(out.usages)) out.usages = [];
  return out;
}
// DB → 화면 (null 날짜 → 빈 문자열, usages 보정)
function fromDbRow(row) {
  const out = { ...row };
  DATE_FIELDS.forEach((f) => { if (out[f] == null) out[f] = ""; });
  if (!Array.isArray(out.usages)) out.usages = out.usages ? out.usages : [];
  return out;
}

export default function ComplianceReviewManager({ userEmail, role, adminEmail, onSignOut }) {
  const isAdmin = role === "admin";
  const canEdit = role === "admin" || role === "editor";
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("내부"); // 내부심의 / 외부심의
  const [fMedia, setFMedia] = useState("전체");
  const [fStatus, setFStatus] = useState("전체");
  const [onlyNoUrl, setOnlyNoUrl] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(() => new Set()); // 일괄 삭제 선택(관리자 전용)
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    setSelected(new Set());
    const { data, error } = await supabase
      .from("review_number")
      .select("*")
      .order("id", { ascending: false });
    if (error) setLoadError(error.message);
    else setRows((data || []).map(fromDbRow));
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // 등록된 심의번호 색인 (모달 실시간 중복 경고용)
  const noIndex = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => {
      const n = (r.review_no || "").trim();
      if (n && !m.has(n)) m.set(n, { id: r.id, title: r.title });
    });
    return m;
  }, [rows]);

  const upsert = async (row) => {
    setSaving(true);
    const fixed = { ...row, approver: FIXED_APPROVER, review_no: (row.review_no || "").trim() };

    // 심의번호 중복 최종 검증 — 서버 기준. 동시 등록·화면 미갱신 상태까지 차단.
    if (fixed.review_no) {
      const { data: clash, error: clashErr } = await supabase
        .from("review_number").select("id,title").eq("review_no", fixed.review_no);
      if (clashErr) {
        alert("심의번호 중복 확인에 실패했습니다: " + clashErr.message + "\n등록을 중단합니다.");
        setSaving(false);
        return;
      }
      const other = (clash || []).find((c) => c.id !== fixed.id);
      if (other) {
        alert(
          `이미 등록된 심의번호입니다.\n\n  ${fixed.review_no}\n  → 기존 등록: #${other.id} ${other.title}\n\n` +
          `심의번호를 확인한 뒤 다시 등록하세요.`
        );
        setSaving(false);
        await load(); // 최신 목록 반영
        return;
      }
    }

    if (fixed.id == null) {
      const { error } = await supabase.from("review_number").insert(toDbRow(fixed));
      if (error) alert("저장 실패: " + error.message);
    } else {
      const { error } = await supabase.from("review_number").update(toDbRow(fixed)).eq("id", fixed.id);
      if (error) alert("수정 실패: " + error.message);
    }
    setSaving(false);
    setEditing(null);
    await load();
  };

  const remove = async (id) => {
    if (!isAdmin) return; // 권한 가드(RLS 미적용 환경이라 앱단에서 이중 확인)
    const { error } = await supabase.from("review_number").delete().eq("id", id);
    if (error) alert("삭제 실패: " + error.message);
    setConfirmId(null);
    await load();
  };

  const removeMany = async () => {
    if (!isAdmin) return;
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkDeleting(true);
    const { error } = await supabase.from("review_number").delete().in("id", ids);
    setBulkDeleting(false);
    if (error) { alert("일괄 삭제 실패: " + error.message); return; }
    setConfirmBulk(false);
    await load(); // load() 안에서 선택 초기화
  };

  // 탭(내부/외부)으로 1차 분류
  const tabRows = useMemo(() => {
    return rows.filter((r) =>
      tab === "내부" ? r.category === INTERNAL_CAT : EXTERNAL_CATS.includes(r.category)
    );
  }, [rows, tab]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return tabRows.filter((r) => {
      if (fMedia !== "전체" && r.media_type !== fMedia) return false;
      if (fStatus !== "전체" && deriveStatus(r).key !== fStatus) return false;
      if (onlyNoUrl) {
        const hasUrl = (r.usages || []).some((u) => u.url && u.url.trim());
        if (hasUrl) return false;
      }
      if (term) {
        // 비고(note)는 검색 대상에서 제외한다. 번호 정정·폐기 이력처럼
        // 옛 심의번호를 비고에 적어두면 폐기된 번호로 검색해도 그 행이 계속 잡힌다.
        const urls = (r.usages || []).map((u) => u.url).join(" ");
        const hay = `${r.review_no} ${r.title} ${r.product} ${r.applicant} ${urls}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [tabRows, q, fMedia, fStatus, onlyNoUrl]);

  // ── 일괄 선택 (관리자 전용) ─────────────────────────────
  const colCount = isAdmin ? 9 : 8; // 체크박스 열 유무에 따른 colSpan
  const selectedCount = selected.size;
  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));

  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (filtered.every((r) => next.has(r.id))) filtered.forEach((r) => next.delete(r.id));
      else filtered.forEach((r) => next.add(r.id));
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  // 필터/탭 변경으로 화면에서 사라진 건은 선택에서 제외 (보이지 않는 건 삭제 방지)
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(filtered.map((r) => r.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filtered]);

  const stats = useMemo(() => {
    let valid = 0, soon = 0, expired = 0, noUrl = 0;
    tabRows.forEach((r) => {
      const s = deriveStatus(r).key;
      if (s === "valid") valid++;
      if (s === "soon") soon++;
      if (s === "expired") expired++;
      const hasUrl = (r.usages || []).some((u) => u.url && u.url.trim());
      if (!hasUrl) noUrl++;
    });
    return { total: tabRows.length, valid, soon, expired, noUrl };
  }, [tabRows]);

  function resetFilters() { setFMedia("전체"); setFStatus("전체"); setQ(""); setOnlyNoUrl(false); }

  // 엑셀 다운로드
  const exportAll = () => exportRows(rows, { filenameBase: "준법심의번호_전체" });
  const exportTab = () => exportRows(tabRows, { filenameBase: `준법심의번호_${tab}심의` });

  // 엑셀 업로드(사내준법 대량 등록)
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);

  async function handleUploadFile(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!file) return;
    setUploading(true);
    setUploadResult(null);
    try {
      const { rows: parsed, errors } = await parseUploadFile(file);
      if (parsed.length === 0) {
        setUploadResult({ ok: 0, errors, msg: "등록할 유효한 행이 없습니다." });
        setUploading(false);
        return;
      }
      // 동시성 방어: 등록 직전 최신 최댓값 재조회
      const year = new Date().getFullYear();
      const { data: existing } = await supabase
        .from("review_number").select("review_no").eq("category", "사내준법");
      const re = new RegExp(`제${year}-(\\d+)호`);
      let max = 0;
      (existing || []).forEach((r) => {
        const m = (r.review_no || "").match(re);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      const payload = parsed.map((p, i) =>
        toDbRow({
          ...p,
          category: "사내준법",
          approver: FIXED_APPROVER,
          review_no: `${ORG_PREFIX} 제${year}-${String(max + 1 + i).padStart(4, "0")}호`,
        })
      );
      const { error } = await supabase.from("review_number").insert(payload);
      if (error) {
        setUploadResult({ ok: 0, errors: [{ line: "-", reason: error.message }], msg: "저장 실패" });
      } else {
        setUploadResult({
          ok: parsed.length,
          errors,
          msg: `${parsed.length}건 등록 완료${errors.length ? ` (누락 ${errors.length}건)` : ""}`,
        });
        await load();
      }
    } catch (err) {
      setUploadResult({ ok: 0, errors: [{ line: "-", reason: String(err.message || err) }], msg: "업로드 오류" });
    }
    setUploading(false);
  }

  const tiles = [
    { label: "전체", value: stats.total, tone: "text-slate-800", onClick: resetFilters },
    { label: "유효", value: stats.valid, tone: "text-emerald-600", onClick: () => { setOnlyNoUrl(false); setFStatus("valid"); } },
    { label: "만료임박", value: stats.soon, tone: "text-amber-600", onClick: () => { setOnlyNoUrl(false); setFStatus("soon"); } },
    { label: "만료됨", value: stats.expired, tone: "text-red-600", onClick: () => { setOnlyNoUrl(false); setFStatus("expired"); } },
    { label: "URL 미등록", value: stats.noUrl, tone: "text-rose-600", onClick: () => { setFStatus("전체"); setOnlyNoUrl(true); } },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <div className="flex">
        {/* 좌측 사이드바 */}
        <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
          <div className="flex items-center gap-2 px-5 py-5">
            <img src="/ajd-logo.webp" alt="아정당" className="h-7 w-auto" />
            <div className="leading-tight">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-brand">아정당 준법감시팀</p>
              <p className="text-sm font-bold text-slate-900">준법심의번호</p>
            </div>
          </div>

          <nav className="flex-1 space-y-1 px-3 py-2">
            {canEdit && (
              <button onClick={() => {
                const base = emptyRow(tab === "내부" ? INTERNAL_CAT : "생보협회");
                // 내부심의는 다음 번호를 미리 채워 접두어 고정 형태를 그대로 보여준다
                setEditing(tab === "내부" ? { ...base, review_no: nextInternalNo(rows) } : base);
              }}
                className="flex w-full items-center gap-2 rounded-lg bg-brand px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-dark">
                <Plus size={16} /> 심의 등록
              </button>
            )}
            {["내부", "외부"].map((t) => (
              <button key={t} onClick={() => { setTab(t); resetFilters(); }}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold transition ${
                  tab === t ? "bg-brand-50 text-brand-700 ring-1 ring-brand-100" : "text-slate-600 hover:bg-slate-50"
                }`}>
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${tab === t ? "bg-brand" : "bg-slate-300"}`} />
                {t}심의
              </button>
            ))}
            {isAdmin && (
              <button onClick={() => setAdminOpen(true)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                <Users size={16} /> 직원 관리
              </button>
            )}
          </nav>

          <div className="border-t border-slate-100 px-4 py-3">
            <div className="truncate text-xs text-slate-500" title={userEmail}>{userEmail}</div>
            <button onClick={onSignOut} className="mt-1 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-700">
              <LogOut size={13} /> 로그아웃
            </button>
          </div>
        </aside>

        {/* 메인 콘텐츠 */}
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-6xl px-6 py-8">
            <div className="mb-5">
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">{tab}심의 관리</h1>
              <p className="text-sm text-slate-500">
                {tab === "내부" ? "사내 준법감시 심의필" : "생명·손해보험협회 심의필"}
              </p>
            </div>

            {/* KPI 슬림 배지 */}

        <div className="mb-5 flex divide-x divide-slate-200 overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
          {tiles.map((t) => (
            <button key={t.label} onClick={t.onClick}
              className="flex flex-1 items-baseline gap-2 px-5 py-3 text-left transition hover:bg-slate-50">
              <span className={`text-xl font-bold tabular-nums ${t.tone}`}>{t.value}</span>
              <span className="text-xs font-medium text-slate-500">{t.label}</span>
            </button>
          ))}
        </div>

        {/* 필터바 */}
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <div className="relative min-w-[200px] flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="심의번호 · 자료명 · 상품 · 담당자 · URL 검색"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm outline-none focus:border-brand-400 focus:bg-white" />
          </div>
          <Filter size={16} className="text-slate-400" />
          <Select value={fMedia} onChange={setFMedia} options={["전체", ...MEDIA_TYPES]} />
          <Select value={fStatus} onChange={setFStatus}
            options={[["전체", "전체"], ["valid", "유효"], ["soon", "만료임박"], ["expired", "만료됨"], ["review", "심사중"], ["recheck", "재심"], ["rejected", "부적합"]]} />
          {(fMedia !== "전체" || fStatus !== "전체" || onlyNoUrl || q) && (
            <button onClick={resetFilters} className="text-xs font-medium text-slate-500 underline underline-offset-2 hover:text-slate-800">초기화</button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {tab === "내부" && canEdit && (
              <>
                <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUploadFile} />
                <button onClick={downloadUploadTemplate} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50" title="사내준법 대량 등록 양식 다운로드">
                  <FileSpreadsheet size={13} /> 업로드 양식
                </button>
                <button onClick={() => fileRef.current?.click()} disabled={uploading} className="inline-flex items-center gap-1 rounded-lg border border-brand-100 bg-brand-50 px-2.5 py-2 text-xs font-semibold text-brand-700 hover:bg-brand-100 disabled:opacity-50" title="엑셀 대량 업로드(사내준법)">
                  <Upload size={13} /> {uploading ? "업로드 중…" : "엑셀 업로드"}
                </button>
              </>
            )}
            <button onClick={exportTab} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50" title={`${tab}심의 목록 엑셀 다운로드`}>
              <Download size={13} /> {tab}심의 다운로드
            </button>
            <button onClick={exportAll} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50" title="전체(내부+외부) 엑셀 다운로드">
              <Download size={13} /> 전체 다운로드
            </button>
            <button onClick={load} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50" title="새로고침">
              <RefreshCw size={13} /> 새로고침
            </button>
          </div>
        </div>

        {/* 선택 액션바 (관리자 전용) */}
        {isAdmin && selectedCount > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5">
            <span className="text-sm font-semibold text-red-700">{selectedCount}건 선택</span>
            <button onClick={clearSelection} className="text-xs font-medium text-slate-500 underline underline-offset-2 hover:text-slate-800">
              선택 해제
            </button>
            <button onClick={() => setConfirmBulk(true)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700">
              <Trash2 size={13} /> 선택 {selectedCount}건 일괄 삭제
            </button>
          </div>
        )}

        {/* 테이블 */}
        <div className="overflow-hidden rounded-xl bg-white ring-1 ring-slate-200">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {isAdmin && (
                    <th className="w-9 px-3 py-3">
                      <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible}
                        disabled={filtered.length === 0}
                        className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-red-600 disabled:cursor-not-allowed"
                        title="현재 목록 전체 선택/해제" />
                    </th>
                  )}
                  <th className="w-8 px-2 py-3"></th>
                  <th className="px-3 py-3">담당자</th>
                  <th className="px-3 py-3">심의번호</th>
                  <th className="px-3 py-3">자료명</th>
                  <th className="px-3 py-3">매체</th>
                  <th className="px-3 py-3">유효기간</th>
                  <th className="px-3 py-3">상태</th>
                  <th className="px-3 py-3 text-right">관리</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && (
                  <tr><td colSpan={colCount} className="px-4 py-14 text-center text-sm text-slate-400">불러오는 중…</td></tr>
                )}
                {!loading && loadError && (
                  <tr><td colSpan={colCount} className="px-4 py-14 text-center text-sm text-red-500">
                    데이터를 불러오지 못했습니다: {loadError}
                  </td></tr>
                )}
                {!loading && !loadError && filtered.length === 0 && (
                  <tr><td colSpan={colCount} className="px-4 py-14 text-center text-sm text-slate-400">
                    표시할 심의 건이 없습니다. 좌측 사이드바 "심의 등록"으로 추가하세요.
                  </td></tr>
                )}
                {!loading && filtered.map((r) => {
                  const st = deriveStatus(r);
                  const open = openId === r.id;
                  const checked = selected.has(r.id);
                  return (
                    <React.Fragment key={r.id}>
                      <tr className={`border-l-4 ${ROW_ACCENT[st.key]} cursor-pointer hover:bg-slate-50/70 ${checked ? "bg-red-50/60" : ""}`}
                        onClick={() => setOpenId(open ? null : r.id)}>
                        {isAdmin && (
                          <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={checked} onChange={() => toggleOne(r.id)}
                              className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-red-600"
                              title="일괄 삭제 대상 선택" />
                          </td>
                        )}
                        <td className="px-2 py-3 text-slate-400">
                          <ChevronDown size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} />
                        </td>
                        <td className="px-3 py-3">
                          {r.applicant
                            ? <span className="text-sm text-slate-700">{r.applicant}</span>
                            : <span className="text-xs text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-3 font-mono text-[12px] text-slate-800">
                          {r.review_no || <span className="text-slate-300">— 미부여 —</span>}
                        </td>
                        <td className="px-3 py-3 font-medium text-slate-800">
                          <div className="flex items-center gap-1.5">
                            {tab === "외부" && SUB_BADGE[r.category] && (
                              <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold ${SUB_BADGE[r.category].cls}`}
                                title={r.category}>{SUB_BADGE[r.category].short}</span>
                            )}
                            <span>{r.title}</span>
                            {!(r.usages || []).some((u) => u.url && u.url.trim()) && (
                              <span className="inline-flex shrink-0 items-center rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600 ring-1 ring-rose-200">URL 미등록</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-slate-600">{r.media_type}</td>
                        <td className="px-3 py-3 text-xs text-slate-600">{r.valid_to || <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[st.key]}`}>
                            {st.key === "soon" && <Clock size={11} />}
                            {st.key === "expired" && <AlertTriangle size={11} />}
                            {st.label}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                            {canEdit && (
                              <button onClick={() => setEditing({ ...r, usages: [...(r.usages || [])] })}
                                className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand-700" title="수정"><Pencil size={15} /></button>
                            )}
                            {isAdmin && (
                              <button onClick={() => setConfirmId(r.id)}
                                className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title="삭제"><Trash2 size={15} /></button>
                            )}
                            {!canEdit && !isAdmin && <span className="text-xs text-slate-300">열람</span>}
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-slate-50/60">
                          <td colSpan={colCount} className="px-6 py-4">
                            <div className="grid grid-cols-2 gap-x-8 gap-y-3 md:grid-cols-4">
                              <Detail label="상품 / 제휴사" value={r.product} />
                              <Detail label="신청일" value={r.applied_date} />
                              <Detail label="심의일" value={r.reviewed_date} />
                              <Detail label="유효기간" value={r.valid_from || r.valid_to ? `${r.valid_from || "?"} ~ ${r.valid_to || "?"}` : ""} />
                              <Detail label="담당자" value={r.applicant} />
                              <Detail label="승인자" value={r.approver} />
                              <div className="col-span-2 md:col-span-4">
                                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">사용처</div>
                                {r.usages && r.usages.length > 0 ? (
                                  <div className="flex flex-wrap gap-1.5">
                                    {r.usages.map((u, i) =>
                                      u.url ? (
                                        <a key={i} href={u.url} target="_blank" rel="noreferrer"
                                          className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-xs text-slate-700 ring-1 ring-slate-200 hover:text-brand-700 hover:ring-brand-400">
                                          <Link2 size={12} /> <span className="font-medium">{u.channel}</span>
                                          <span className="max-w-[280px] truncate text-slate-400">{u.url}</span>
                                        </a>
                                      ) : (
                                        <span key={i} className="rounded-md bg-white px-2 py-1 text-xs text-slate-400 ring-1 ring-slate-200">{u.channel} (URL 없음)</span>
                                      )
                                    )}
                                  </div>
                                ) : (<span className="text-xs text-slate-400">등록된 사용처 없음</span>)}
                              </div>
                              {r.note && (
                                <div className="col-span-2 md:col-span-4">
                                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">비고</div>
                                  <p className="text-sm text-slate-600">{r.note}</p>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <p className="mt-4 text-xs text-slate-400">
          ※ 행을 클릭하면 상세가 펼쳐집니다. 사내준법 번호는 등록 시 자동 생성(수정 가능), 협회 번호는 수동 입력.
          만료임박·만료 건은 상단 배지에서 바로 필터링됩니다.
          {isAdmin && " 좌측 체크박스로 여러 건을 선택해 일괄 삭제할 수 있습니다(관리자 전용, 현재 목록에 보이는 건만 대상)."}
        </p>
          </div>
        </main>
      </div>

      {adminOpen && isAdmin && (
        <AdminPanel currentEmail={userEmail} adminEmail={adminEmail} onClose={() => setAdminOpen(false)} />
      )}

      {editing && (
        <EditModal initial={editing} saving={saving} onClose={() => setEditing(null)} onSave={upsert}
          suggestNo={() => nextInternalNo(rows)} existing={noIndex} />
      )}

      {uploadResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-slate-900">엑셀 업로드 결과</h3>
            <p className="mt-1 text-sm text-slate-600">{uploadResult.msg}</p>
            {uploadResult.ok > 0 && (
              <p className="mt-2 text-sm text-emerald-700">✓ {uploadResult.ok}건이 사내준법으로 등록되었습니다. (심의번호 자동 부여)</p>
            )}
            {uploadResult.errors && uploadResult.errors.length > 0 && (
              <div className="mt-3 max-h-40 overflow-y-auto rounded-lg bg-red-50 p-3 text-xs text-red-700 ring-1 ring-red-200">
                <div className="mb-1 font-semibold">누락/오류 {uploadResult.errors.length}건</div>
                {uploadResult.errors.map((e, i) => (
                  <div key={i}>· {e.line != null ? `${e.line}행: ` : ""}{e.reason}</div>
                ))}
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <button onClick={() => setUploadResult(null)} className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-dark">확인</button>
            </div>
          </div>
        </div>
      )}

      {confirmBulk && isAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-slate-900">선택한 {selectedCount}건을 삭제할까요?</h3>
            <p className="mt-1 text-sm text-slate-500">
              삭제하면 되돌릴 수 없습니다. 부여된 심의번호 이력 {selectedCount}건이 한 번에 사라집니다.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmBulk(false)} disabled={bulkDeleting}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">취소</button>
              <button onClick={removeMany} disabled={bulkDeleting}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                {bulkDeleting ? "삭제 중…" : `${selectedCount}건 삭제`}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmId != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-slate-900">심의 건을 삭제할까요?</h3>
            <p className="mt-1 text-sm text-slate-500">삭제하면 되돌릴 수 없습니다. 부여된 심의번호 이력이 사라집니다.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmId(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50">취소</button>
              <button onClick={() => remove(confirmId)} className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700">삭제</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }) {
  return (
    <div>
      <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-sm text-slate-700">{value || <span className="text-slate-300">—</span>}</div>
    </div>
  );
}

function Select({ value, onChange, options }) {
  const norm = options.map((o) => (Array.isArray(o) ? o : [o, o]));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-700 outline-none focus:border-brand-400">
      {norm.map(([v, label]) => (<option key={v} value={v}>{label}</option>))}
    </select>
  );
}

function EditModal({ initial, onClose, onSave, suggestNo, saving, existing }) {
  const [f, setF] = useState(initial);
  const set = (k, v) => setF({ ...f, [k]: v });
  const isInternal = f.category === "사내준법";

  // 구 형식 번호(예: 아정-준법-2026-…)는 접두어 고정에서 제외 — 기존 이력 보존
  const legacyNo = Boolean(initial.review_no) && !initial.review_no.startsWith(ORG_PREFIX);
  const lockPrefix = isInternal && !legacyNo;
  const suffix = f.review_no.startsWith(ORG_PREFIX)
    ? f.review_no.slice(ORG_PREFIX.length).replace(/^\s+/, "")
    : f.review_no;
  const setSuffix = (v) => set("review_no", v ? `${ORG_PREFIX} ${v}` : "");

  // 이미 등록된 심의번호와 충돌하는지 실시간 확인 (자기 자신은 제외)
  const noTrim = (f.review_no || "").trim();
  const hit = noTrim ? existing?.get(noTrim) : null;
  const dup = hit && hit.id !== f.id ? hit : null;

  const canSave = f.title.trim() && f.category && !saving && !dup;

  const addUsage = () => setF({ ...f, usages: [...(f.usages || []), { channel: "블로그", url: "" }] });
  const updateUsage = (i, k, v) => { const next = [...f.usages]; next[i] = { ...next[i], [k]: v }; setF({ ...f, usages: next }); };
  const removeUsage = (i) => setF({ ...f, usages: f.usages.filter((_, idx) => idx !== i) });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
          <h3 className="text-base font-semibold text-slate-900">{f.id == null ? "심의 등록" : "심의 수정"}</h3>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <Field label="심의구분"><Select value={f.category} onChange={(v) => set("category", v)} options={CATEGORIES} /></Field>
          <Field label="심의번호" full>
            <div className="flex gap-1.5">
              {lockPrefix ? (
                <div className={`flex min-w-0 flex-1 items-stretch overflow-hidden rounded-lg border bg-white ${dup ? "border-red-300" : "border-slate-200 focus-within:border-brand-400"}`}>
                  <span className="shrink-0 select-none border-r border-slate-200 bg-slate-50 px-2.5 py-2 text-sm font-medium text-slate-500"
                    title="주체명 고정 — 수정할 수 없습니다">
                    {ORG_PREFIX}
                  </span>
                  <input value={suffix} onChange={(e) => setSuffix(e.target.value)}
                    placeholder="제2026-0001호" className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none" />
                </div>
              ) : (
                <input value={f.review_no} onChange={(e) => set("review_no", e.target.value)}
                  placeholder={isInternal ? "구 형식 번호 — 자유 입력" : "협회 부여 번호 입력"}
                  className={`${inp} ${dup ? "border-red-300" : ""}`} />
              )}
              {isInternal && (
                <button onClick={() => set("review_no", suggestNo())}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-brand-100 bg-brand-50 px-2 text-xs font-medium text-brand-700 hover:bg-brand-100" title="다음 번호 자동 생성">
                  <Wand2 size={13} /> 생성
                </button>
              )}
            </div>
            {dup ? (
              <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 ring-1 ring-red-200">
                <AlertTriangle size={13} className="mt-px shrink-0" />
                <span>이미 등록된 심의번호입니다 — #{dup.id} “{dup.title}”. 번호를 확인한 뒤 다시 입력하세요. (등록 불가)</span>
              </p>
            ) : legacyNo && isInternal ? (
              <p className="mt-1.5 text-[11px] text-amber-600">
                구 형식 번호라 주체명 고정을 적용하지 않았습니다. 비우고 “생성”을 누르면 현행 형식으로 재부여됩니다.
              </p>
            ) : lockPrefix ? (
              <p className="mt-1.5 text-[11px] text-slate-400">주체명은 고정입니다. 뒤 번호만 입력하세요(비우면 미부여로 저장).</p>
            ) : null}
          </Field>
          <Field label="자료명" full><input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="광고물·게시물 제목" className={inp} /></Field>
          <Field label="대표 매체"><Select value={f.media_type} onChange={(v) => set("media_type", v)} options={MEDIA_TYPES} /></Field>
          <Field label="상품 / 제휴사"><input value={f.product} onChange={(e) => set("product", e.target.value)} className={inp} /></Field>
          <Field label="신청일"><input type="date" value={f.applied_date} onChange={(e) => set("applied_date", e.target.value)} className={inp} /></Field>
          <Field label="심의일"><input type="date" value={f.reviewed_date} onChange={(e) => set("reviewed_date", e.target.value)} className={inp} /></Field>
          <Field label="심의결과"><Select value={f.result} onChange={(v) => set("result", v)} options={RESULTS} /></Field>
          <Field label="유효기간 시작"><input type="date" value={f.valid_from} onChange={(e) => set("valid_from", e.target.value)} className={inp} /></Field>
          <Field label="유효기간 종료"><input type="date" value={f.valid_to} onChange={(e) => set("valid_to", e.target.value)} className={inp} /></Field>
          <Field label="담당자"><input value={f.applicant} onChange={(e) => set("applicant", e.target.value)} className={inp} /></Field>
          <Field label="승인자 (준법감시인)">
            <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              {FIXED_APPROVER} <span className="ml-1.5 text-xs text-slate-400">· 고정</span>
            </div>
          </Field>

          <Field label="사용처 (채널 + URL)" full>
            <div className="space-y-2">
              {(f.usages || []).map((u, i) => (
                <div key={i} className="flex gap-2">
                  <select value={u.channel} onChange={(e) => updateUsage(i, "channel", e.target.value)}
                    className="w-28 shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm outline-none focus:border-brand-400">
                    {MEDIA_TYPES.map((m) => (<option key={m} value={m}>{m}</option>))}
                  </select>
                  <input value={u.url} onChange={(e) => updateUsage(i, "url", e.target.value)} placeholder="게시 URL" className={inp} />
                  <button onClick={() => removeUsage(i)} className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"><X size={16} /></button>
                </div>
              ))}
              <button onClick={addUsage} className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:text-brand-dark">
                <Plus size={13} /> 사용처 추가
              </button>
            </div>
          </Field>

          <Field label="비고 (조건부 이행사항 등)" full>
            <textarea value={f.note} onChange={(e) => set("note", e.target.value)} rows={2}
              placeholder="조건부승인 이행조건·기한, 재심의 사유 등 자유 기록" className={inp} />
          </Field>
        </div>
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">취소</button>
          <button onClick={() => canSave && onSave(f)} disabled={!canSave}
            className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40">
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inp = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400";

function Field({ label, children, full }) {
  return (
    <div className={full ? "sm:col-span-2" : ""}>
      <label className="mb-1 block text-xs font-medium text-slate-500">{label}</label>
      {children}
    </div>
  );
}
