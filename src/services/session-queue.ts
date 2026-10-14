import type { DrivingSessionResult, RouteDraft } from "../types/domain";
import type { PendingSession, SessionStore } from "./session-store";

export class SessionApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export interface SessionSaveOutcome { id: number | null; pending: boolean; error?: string; }

/** Queue first; only a confirmed, idempotent server save removes an item. */
export function createSessionQueue(
  store: SessionStore, currentUserId: () => number | null,
  saveRemote: (result: DrivingSessionResult) => Promise<{ id: number }>,
) {
  let flushing: Promise<{ saved: number; remaining: number; error?: string }> | null = null;
  const message = (error: unknown) => error instanceof Error ? error.message : "შენახვა ვერ მოხერხდა.";
  const failureStatus = (error: unknown): PendingSession["status"] => error instanceof SessionApiError
    ? error.status === 401 ? "auth_required" : error.status >= 400 && error.status < 500 && error.status !== 429 ? "blocked" : "pending"
    : "pending";
  return {
    async saveOrQueue(result: DrivingSessionResult, routeSnapshot?: RouteDraft | null): Promise<SessionSaveOutcome> {
      const userId = currentUserId();
      if (userId == null) return { id: null, pending: false, error: "შედეგის შესანახად ანგარიშში შესვლა საჭიროა. ჩამოტვირთე ჩანაწერი ან ხელახლა შედი." };
      const item: PendingSession = { key: `${userId}:${result.clientSessionId}`, userId, queuedAt: Date.now(), result, routeSnapshot, status: "pending" };
      let durable = false;
      let storageError = "";
      try { await store.put(item); durable = true; } catch (error) { storageError = message(error); }
      try {
        if (currentUserId() !== userId) throw new SessionApiError("ანგარიში შეიცვალა; შედეგი თავდაპირველ ანგარიშში გაგზავნას ელოდება.", 401);
        const saved = await saveRemote(result);
        if (!Number.isInteger(saved.id) || saved.id <= 0) throw new Error("სერვერმა შენახვა ვერ დაადასტურა.");
        if (durable) await store.remove(item.key).catch(() => undefined);
        return { id: saved.id, pending: false };
      } catch (error) {
        if (durable) await store.put({ ...item, status: failureStatus(error), lastError: message(error) }).catch(() => undefined);
        return { id: null, pending: durable, error: durable ? message(error) : `${message(error)} ${storageError}`.trim() };
      }
    },
    async listPending() {
      const userId = currentUserId();
      return (await store.list()).filter((item) => item.userId === userId).sort((a, b) => a.queuedAt - b.queuedAt);
    },
    flushPending(force = false) {
      if (flushing) return flushing;
      flushing = (async () => {
        let saved = 0;
        const userId = currentUserId();
        if (userId == null) return { saved, remaining: 0 };
        const items = (await store.list()).filter((item) => item.userId === userId);
        for (const item of items) {
          if (currentUserId() !== userId) break;
          if (item.status === "blocked" && !force) continue;
          try {
            const result = await saveRemote(item.result);
            if (!Number.isInteger(result.id) || result.id <= 0) throw new Error("სერვერმა შენახვა ვერ დაადასტურა.");
            await store.remove(item.key);
            saved += 1;
          } catch (error) {
            await store.put({ ...item, status: failureStatus(error), lastError: message(error) }).catch(() => undefined);
            if (error instanceof SessionApiError && (error.status === 401 || error.status === 429)) break;
          }
        }
        return { saved, remaining: (await store.list()).filter((item) => item.userId === userId).length };
      })().catch((error) => ({ saved: 0, remaining: 0, error: message(error) })).finally(() => { flushing = null; });
      return flushing;
    },
  };
}
