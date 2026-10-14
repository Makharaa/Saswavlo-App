import type {
  DrivingSessionDetail,
  DrivingSessionResult,
  DrivingSessionSummary,
  RouteDraft,
} from "@/types/domain";

import { browserSessionStore } from "./session-store";
import { createSessionQueue, SessionApiError } from "./session-queue";

const PENDING_KEY = "driveexam-pending-sessions-v1";
const USER_KEY = "driveexam-current-user-id";

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SessionApiError(
      body?.error || "მოთხოვნა ვერ შესრულდა.",
      response.status
    );
  }
  return body as T;
}

function createClientSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function currentUserId() {
  if (typeof window === "undefined") return null;
  try {
    const value = Number(window.localStorage.getItem(USER_KEY));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function saveRemote(result: DrivingSessionResult) {
  return json<{ id: number }>(
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    })
  );
}

const queue = createSessionQueue(browserSessionStore, currentUserId, saveRemote);
let migration: Promise<void> | null = null;
async function migrateLegacyQueue() {
  if (typeof window === "undefined") return;
  if (migration) return migration;
  migration = (async () => {
    const stored = window.localStorage.getItem(PENDING_KEY);
    if (!stored) return;
    const items = JSON.parse(stored);
    if (!Array.isArray(items)) throw new Error("ძველი შენახვის რიგი ვერ იკითხება. ჩანაწერი შენარჩუნებულია.");
    for (const item of items) {
      if (!item.result || !Number.isInteger(item.userId) || item.userId <= 0) throw new Error("ძველი რიგის ჩანაწერი დაზიანებულია; მონაცემი შენარჩუნებულია.");
      const result = { ...item.result, clientSessionId: item.result.clientSessionId || `legacy-${item.userId}-${item.result.startedAt}-${item.key || createClientSessionId()}` };
      await browserSessionStore.put({ ...item, result, key: `${item.userId}:${result.clientSessionId}`, status: "pending" });
    }
    window.localStorage.removeItem(PENDING_KEY);
  })().catch((error) => { migration = null; throw error; });
  return migration;
}
export function activeSessionKey(routeId: number | null) {
  const userId = currentUserId();
  return userId == null ? null : `active:${userId}:${routeId ?? "none"}`;
}
export const sessionService = {
  save: saveRemote,
  async saveOrQueue(result: DrivingSessionResult, routeSnapshot?: RouteDraft | null) {
    await migrateLegacyQueue().catch(() => undefined);
    return queue.saveOrQueue(result, routeSnapshot);
  },
  async listPending() { await migrateLegacyQueue(); return queue.listPending(); },
  async pendingCount() { return (await this.listPending()).length; },
  async flushPending(force = false) {
    try { await migrateLegacyQueue(); return await queue.flushPending(force); }
    catch (error) { return { saved: 0, remaining: 0, error: error instanceof Error ? error.message : "რიგი ვერ ჩაიტვირთა." }; }
  },

  async list(limit = 50, scope: "all" | "mine" = "all", offset = 0) {
    const params = new URLSearchParams({
      limit: String(Math.max(1, Math.min(500, limit))),
      offset: String(Math.max(0, Math.floor(offset))),
      ...(scope === "mine" ? { scope: "mine" } : {}),
    });
    return json<DrivingSessionSummary[]>(
      await fetch(`/api/sessions?${params.toString()}`, {
        credentials: "same-origin",
        cache: "no-store",
      })
    );
  },

  async get(id: number) {
    return json<DrivingSessionDetail>(
      await fetch(`/api/sessions/${id}`, { cache: "no-store" })
    );
  },
};

export type HistoryPageResponse = {
  items: DrivingSessionSummary[];
  total: number;
  page: number;
  pages: number;
  size: number;
  stats: { real: number; issues: number; completion: number };
};
export type HistoryFilterOptions = {
  drivers: Array<{ value: string; label: string }>;
  routes: Array<{ value: string; label: string }>;
};

/** The history API applies all filters before pagination, within the authenticated scope. */
export async function fetchHistoryPage(
  params: Record<string, string>, scope: "mine" | "all", signal?: AbortSignal
) {
  const query = new URLSearchParams({ view: "page", ...params, ...(scope === "mine" ? { scope: "mine" } : {}) });
  return json<HistoryPageResponse>(await fetch(`/api/sessions?${query}`, {
    credentials: "same-origin", cache: "no-store", signal,
  }));
}

export async function fetchHistoryFilters(scope: "mine" | "all", signal?: AbortSignal) {
  const query = new URLSearchParams({ view: "filters", ...(scope === "mine" ? { scope: "mine" } : {}) });
  return json<HistoryFilterOptions>(await fetch(`/api/sessions?${query}`, {
    credentials: "same-origin", cache: "no-store", signal,
  }));
}
