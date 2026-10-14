/** SQL parameters are used for every user-supplied value; sorting only uses this allowlist. */
export type HistoryMode = "all" | "real" | "simulation" | "practice" | "exam" | "issues";
export type HistorySort = "newest" | "oldest";
export type HistoryDays = "all" | "7" | "30" | "90";

export interface HistoryPageFilters {
  search: string;
  mode: HistoryMode;
  days: HistoryDays;
  driverId: number | null;
  routeId: number | null;
  sort: HistorySort;
}

export const HISTORY_PAGE_LIMITS = [10, 20, 50] as const;
export function readHistoryOptions(params: URLSearchParams, allowDriverFilter: boolean) {
  const modeValues: HistoryMode[] = ["all", "real", "simulation", "practice", "exam", "issues"];
  const daysValues: HistoryDays[] = ["all", "7", "30", "90"];
  const rawMode = params.get("mode") as HistoryMode;
  const rawDays = params.get("days") as HistoryDays;
  const rawSort = params.get("sort");
  const size = Number(params.get("size"));
  const page = Number(params.get("page"));
  const toId = (value: string | null) => value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  return {
    search: (params.get("search") ?? "").trim().slice(0, 120),
    mode: modeValues.includes(rawMode) ? rawMode : "all",
    days: daysValues.includes(rawDays) ? rawDays : "all",
    sort: rawSort === "oldest" ? "oldest" : "newest",
    driverId: allowDriverFilter ? toId(params.get("driver")) : null,
    routeId: toId(params.get("route")),
    size: HISTORY_PAGE_LIMITS.includes(size as 10 | 20 | 50) ? size : 10,
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(100_000, page) : 1,
  } as HistoryPageFilters & { size: number; page: number };
}

export const historyJoins = `
  FROM driving_sessions ds
  LEFT JOIN exam_routes er ON er.id=ds.route_id
  LEFT JOIN app_users u ON u.id=ds.user_id`;

export function historyWhere(filters: HistoryPageFilters, ownerId?: number) {
  const parts: string[] = [];
  const params: Array<number | string> = [];
  function add(sql: (placeholder: string) => string, value: number | string) {
    params.push(value);
    parts.push(sql(`$${params.length}`));
  }
  if (ownerId != null) add((p) => `ds.user_id = ${p}`, ownerId);
  if (filters.driverId != null) add((p) => `ds.user_id = ${p}`, filters.driverId);
  if (filters.routeId != null) add((p) => `COALESCE(ds.route_id_snapshot, ds.route_id) = ${p}`, filters.routeId);
  if (filters.search) add((p) => `STRPOS(LOWER(CONCAT_WS(' ', COALESCE(ds.route_name_snapshot, er.name), COALESCE(ds.route_city_snapshot, er.city), u.name)), LOWER(${p})) > 0`, filters.search);
  if (filters.days !== "all") add((p) => `ds.created_at >= NOW() - (${p}::integer * INTERVAL '1 day')`, Number(filters.days));
  if (filters.mode === "real" || filters.mode === "simulation") add((p) => `ds.drive_mode = ${p}`, filters.mode);
  if (filters.mode === "practice" || filters.mode === "exam") add((p) => `ds.assist_mode = ${p}`, filters.mode);
  if (filters.mode === "issues") {
    parts.push(`(ds.speeding_events > 0 OR ds.off_route_events > 0 OR ds.checkpoints_completed < ds.checkpoints_total OR COALESCE((ds.evaluation->>'wrongDirectionEvents')::integer,0) > 0 OR COALESCE((ds.evaluation->>'missedCheckpoints')::integer,0) > 0)`);
  }
  return { where: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", params };
}

export function historyOrder(sort: HistorySort) {
  return sort === "oldest" ? "ORDER BY ds.created_at ASC, ds.id ASC" : "ORDER BY ds.created_at DESC, ds.id DESC";
}

export function historyPageNumbers(current: number, total: number): number[] {
  if (total <= 0) return [];
  const start = Math.max(1, Math.min(current - 2, total - 4));
  return Array.from({ length: Math.min(5, total - start + 1) }, (_, i) => start + i);
}
