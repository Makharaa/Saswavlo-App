"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowRight, CalendarDays, ChevronLeft, ChevronRight, Clock3,
  Filter, Gauge, History, MapPinned, Navigation, RefreshCw, Route as RouteIcon,
  Search, ShieldCheck, TriangleAlert, UserRound, X,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { AppSelect } from "@/components/app-select";
import { LocalDateTime } from "@/components/local-date-time";
import { Surface } from "@/components/ui";
import { fetchHistoryFilters, fetchHistoryPage, type HistoryPageResponse, type HistoryFilterOptions } from "@/services/sessions";
import { historyPageNumbers, type HistoryDays, type HistoryMode, type HistorySort } from "@/lib/history-page-query";
import { PendingSessions } from "@/features/results/pending-sessions";
import { drivingProgress, sessionIssueCount } from "@/utils/session-insights";
import type { DrivingSessionSummary } from "@/types/domain";

const modes: Array<{ value: HistoryMode; label: string }> = [
  { value: "all", label: "ყველა ცდა" },
  { value: "real", label: "რეალური GPS" },
  { value: "simulation", label: "სიმულაცია" },
  { value: "practice", label: "ვარჯიში" },
  { value: "exam", label: "გამოცდა" },
  { value: "issues", label: "შეცდომებით" },
];

function formatDuration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function progressValue(item: DrivingSessionSummary) {
  return item.checkpointsTotal > 0
    ? Math.max(0, Math.min(100, Math.round(item.checkpointsCompleted / item.checkpointsTotal * 100))) : 0;
}

function HistoryPages({ page, pages, total, size, onChange, disabled }: {
  page: number; pages: number; total: number; size: number;
  onChange: (page: number) => void; disabled: boolean;
}) {
  if (total === 0) return null;
  const first = (page - 1) * size + 1;
  const last = Math.min(total, page * size);
  return <nav className="history27-pages" aria-label="ისტორიის გვერდებად დაყოფა">
    <span className="history27-pages-count">ნაჩვენებია <b>{first}–{last}</b> / <b>{total}</b></span>
    <div className="history27-page-buttons">
      <button type="button" aria-label="წინა გვერდი" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={17} /></button>
      {historyPageNumbers(page, pages).map((number) => <button type="button" key={number} aria-label={`გვერდი ${number}`} aria-current={page === number ? "page" : undefined} className={page === number ? "active" : ""} disabled={disabled} onClick={() => onChange(number)}>{number}</button>)}
      <button type="button" aria-label="შემდეგი გვერდი" disabled={disabled || page >= pages} onClick={() => onChange(page + 1)}><ChevronRight size={17} /></button>
    </div>
    <span className="history27-pages-hint">გვერდი {page} / {pages}</span>
  </nav>;
}

export default function HistoryPage({ mineOnly = false }: { mineOnly?: boolean }) {
  const scope = mineOnly ? "mine" : "all";
  const [data, setData] = useState<HistoryPageResponse | null>(null);
  const [choices, setChoices] = useState<HistoryFilterOptions>({ drivers: [], routes: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [mode, setMode] = useState<HistoryMode>("all");
  const [days, setDays] = useState<HistoryDays>("all");
  const [driver, setDriver] = useState("all");
  const [route, setRoute] = useState("all");
  const [sort, setSort] = useState<HistorySort>("newest");
  const [size, setSize] = useState("10");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    fetchHistoryFilters(scope, controller.signal).then(setChoices).catch(() => undefined);
    return () => controller.abort();
  }, [scope, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetchHistoryPage({
      page: String(page), size,
      search: debouncedQuery, mode, days, sort,
      ...(driver !== "all" && !mineOnly ? { driver } : {}),
      ...(route !== "all" ? { route } : {}),
    }, scope, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { setData(result); if (result.page !== page) setPage(result.page); } })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "ისტორიის ჩატვირთვა ვერ მოხერხდა."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [scope, page, size, debouncedQuery, mode, days, driver, route, sort, refresh, mineOnly]);

  const items = data?.items ?? [];
  const stats = data?.stats;
  const total = data?.total ?? 0;
  const pages = data?.pages ?? 1;
  const progress = useMemo(() => drivingProgress(items).slice(0, 4), [items]);
  const filtersActive = query.trim() !== "" || mode !== "all" || days !== "all" || driver !== "all" || route !== "all" || sort !== "newest";
  const update = useCallback(<T,>(setter: (value: T) => void, value: T) => { setter(value); setPage(1); }, []);
  const refreshList = useCallback(() => setRefresh((v) => v + 1), []);

  const reset = () => { setQuery(""); setDebouncedQuery(""); setMode("all"); setDays("all"); setDriver("all"); setRoute("all"); setSort("newest"); setPage(1); };

  return <main className="page-shell">
    <AppHeader />
    <section className="history-page history-v18 history-pro-v27">
      <div className="history27-hero">
        <div className="history27-heading">
          <span className="history27-eyebrow"><History size={15} /> {mineOnly ? "პირადი კაბინეტი / ისტორია" : "ადმინისტრირება / საერთო ისტორია"}</span>
          <h1>{mineOnly ? "ჩემი მართვის ისტორია" : "მართვის ისტორია"}</h1>
          <p>{mineOnly ? "შენი გავლილი მარშრუტები, შენახული ცდები და შედეგები ერთ სივრცეში." : "ყველა მძღოლის შედეგების, მარშრუტებისა და ცდების მართვა ერთ სივრცეში."}</p>
        </div>
        <button className="history27-refresh" type="button" onClick={refreshList} disabled={loading}><RefreshCw size={16} /> განახლება</button>
      </div>

      <PendingSessions onSaved={refreshList} />

      <div className="history27-stats" aria-label="გაფილტრული ისტორიის სტატისტიკა">
        <Surface className="history27-stat"><span className="history27-stat-icon"><History size={18} /></span><small>სულ ცდები</small><strong>{loading && !data ? "—" : total}</strong><span>არჩეული ფილტრების მიხედვით</span></Surface>
        <Surface className="history27-stat"><span className="history27-stat-icon mint"><MapPinned size={18} /></span><small>რეალური GPS</small><strong>{stats?.real ?? "—"}</strong><span>რეალურ რეჟიმში</span></Surface>
        <Surface className="history27-stat"><span className="history27-stat-icon violet"><Navigation size={18} /></span><small>საშუალო შესრულება</small><strong>{stats ? `${Math.round(stats.completion)}%` : "—"}</strong><span>ჩექფოინთების შესრულება</span></Surface>
        <Surface className="history27-stat"><span className="history27-stat-icon amber"><TriangleAlert size={18} /></span><small>დაფიქსირებული შეცდომები</small><strong>{stats?.issues ?? "—"}</strong><span>ყველა ნაპოვნ ცდაში</span></Surface>
      </div>

      <Surface className="history27-panel">
        <div className="history27-panel-title"><div><span>ჩანაწერების ძებნა</span><p>გაფილტრე სესიები მძღოლით, მარშრუტით, თარიღითა და რეჟიმით.</p></div>{filtersActive && <button type="button" className="history27-clear" onClick={reset}><X size={14} /> ფილტრების გასუფთავება</button>}</div>
        <div className="history27-inputs">
          <label className="history27-search"><Search size={18} /><input aria-label="ისტორიაში ძებნა" placeholder={mineOnly ? "მარშრუტის ან ქალაქის ძებნა..." : "მარშრუტი, მძღოლი ან ქალაქი..."} value={query} onChange={(event) => update(setQuery, event.target.value)} />{query && <button aria-label="ძებნის გასუფთავება" type="button" onClick={() => update(setQuery, "")}><X size={15} /></button>}</label>
          {!mineOnly && <AppSelect value={driver} onChange={(value) => update(setDriver, value)} ariaLabel="მძღოლის არჩევა" startIcon={<UserRound size={15} />} options={[{ value: "all", label: "ყველა მძღოლი" }, ...choices.drivers]} compact />}
          <AppSelect value={route} onChange={(value) => update(setRoute, value)} ariaLabel="მარშრუტის არჩევა" startIcon={<RouteIcon size={15} />} options={[{ value: "all", label: "ყველა მარშრუტი" }, ...choices.routes]} compact />
          <AppSelect value={days} onChange={(value) => update(setDays, value as HistoryDays)} ariaLabel="თარიღის დიაპაზონი" startIcon={<CalendarDays size={15} />} options={[{value:"all",label:"ყველა თარიღი"},{value:"7",label:"ბოლო 7 დღე"},{value:"30",label:"ბოლო 30 დღე"},{value:"90",label:"ბოლო 90 დღე"}]} compact />
        </div>
        <div className="history27-mode-tabs" aria-label="ისტორიის რეჟიმის ფილტრი">
          <Filter size={15} />
          {modes.map((option) => <button type="button" key={option.value} aria-pressed={mode === option.value} onClick={() => update(setMode, option.value)} className={mode === option.value ? "active" : ""}>{option.label}</button>)}
        </div>
      </Surface>

      <div className="history27-list-heading">
        <div><h2>ცდების სია</h2><p>{loading ? "მონაცემები იტვირთება..." : `${total} ჩანაწერი მოიძებნა`}</p></div>
        <div className="history27-list-actions">
          <AppSelect value={sort} onChange={(value) => update(setSort, value as HistorySort)} ariaLabel="ისტორიის დალაგება" startIcon={<CalendarDays size={14} />} options={[{value:"newest",label:"უახლესი პირველად"},{value:"oldest",label:"უძველესი პირველად"}]} compact />
          <AppSelect value={size} onChange={(value) => update(setSize, value)} ariaLabel="გვერდზე ჩანაწერების რაოდენობა" options={[{value:"10",label:"10 ჩანაწერი"},{value:"20",label:"20 ჩანაწერი"},{value:"50",label:"50 ჩანაწერი"}]} compact />
        </div>
      </div>

      {error && <Surface className="history27-message history27-error" role="alert">{error} <button type="button" onClick={refreshList}>ხელახლა ცდა</button></Surface>}
      {!error && loading && <Surface className="history27-message" aria-live="polite">ისტორიის ჩანაწერები იტვირთება...</Surface>}
      {!loading && !error && items.length === 0 && <Surface className="history27-message"><RouteIcon size={28} /><h3>ჩანაწერები ვერ მოიძებნა</h3><p>შეცვალე ფილტრები ან გაასუფთავე ძებნა.</p>{filtersActive && <button type="button" className="button button-secondary" onClick={reset}>ფილტრების გასუფთავება</button>}</Surface>}

      {!loading && !error && items.length > 0 && <>
        <div className="history27-list" aria-label="მართვის ცდები">
          {items.map((item) => {
            const completion = progressValue(item);
            const issueCount = sessionIssueCount(item);
            return <Link href={`/results/${item.id}`} key={item.id} className="history27-row">
              <span className="history27-route-icon"><RouteIcon size={20}/></span>
              <span className="history27-route">
                <strong>{item.routeName || "წაშლილი მარშრუტი"}</strong>
                <small><MapPinned size={12}/>{item.city || "—"}{item.routeVersion ? ` · v${item.routeVersion}` : ""}{!mineOnly && item.userName ? ` · ${item.userName}` : ""}</small>
              </span>
              <span className="history27-flags"><em className={item.mode === "real" ? "real" : ""}>{item.mode === "real" ? "რეალური GPS" : "სიმულაცია"}</em><em>{item.assistMode === "exam" ? "გამოცდა" : "ვარჯიში"}</em></span>
              <span className="history27-progress-cell"><span className="history27-progress-label"><b>{completion}%</b><small>{item.checkpointsCompleted}/{item.checkpointsTotal} ჩექფოინთი</small></span><span className="history27-progress-track"><span style={{width:`${completion}%`}} /></span></span>
              <span className="history27-record-meta"><small><LocalDateTime value={item.createdAt}/></small><span><Clock3 size={13}/>{formatDuration(item.durationSeconds)} <i>·</i> {(item.distanceMeters/1000).toFixed(2)} კმ</span></span>
              <span className={`history27-issue-badge ${issueCount > 0 ? "has-issues" : ""}`}>{issueCount ? <><TriangleAlert size={14}/>{issueCount} შეცდომა</> : <><ShieldCheck size={14}/>0 შეცდომა</>}</span>
              <span className="history27-open" title="დეტალური შედეგის ნახვა"><ArrowRight size={17}/></span>
            </Link>;
          })}
        </div>
        <HistoryPages page={data?.page ?? page} pages={pages} total={total} size={Number(size)} onChange={setPage} disabled={loading} />
      </>}

      {!loading && !error && progress.length > 0 && <details className="history27-trends">
        <summary><Activity size={17}/> <span>პროგრესის შედარება <small>ამ გვერდზე ნაჩვენები, გადამოწმებული რეალური ცდები</small></span><ChevronRight size={17}/></summary>
        <div className="history27-trend-grid">
          {progress.map((item) => <div key={item.key}><b>{item.latest.routeName}</b><small>{item.latest.userName || "მძღოლი"} · {item.attempts} ცდა</small><strong>{Math.round(item.completion)}% შესრულება</strong><span>{item.completionChange == null ? "შედარებისთვის მეტი ცდაა საჭირო" : `ცვლილება: ${item.completionChange > 0 ? "+" : ""}${Math.round(item.completionChange)} პპ`}</span></div>)}
        </div>
      </details>}
    </section>
  </main>;
}
