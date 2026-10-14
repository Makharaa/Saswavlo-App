import "server-only";

import { pool } from "@/lib/db";
import { ensureDatabase } from "@/lib/migrations";
import { createHash } from "crypto";

/** Fixed one-minute account quota persisted in PostgreSQL. */
export async function checkRouteReadQuota(userId: number, action: "list" | "detail") {
  await ensureDatabase();
  const key = createHash("sha256").update(`route-read:${action}:${userId}`).digest("hex");
  const maxRequests = action === "list" ? 40 : 90;
  const result = await pool.query<{ hits: number }>(`
    INSERT INTO api_access_windows(key,hits,window_started_at,updated_at)
    VALUES ($1,1,NOW(),NOW())
    ON CONFLICT(key) DO UPDATE SET
      hits=CASE WHEN api_access_windows.window_started_at < NOW() - INTERVAL '1 minute'
        THEN 1 ELSE api_access_windows.hits + 1 END,
      window_started_at=CASE WHEN api_access_windows.window_started_at < NOW() - INTERVAL '1 minute'
        THEN NOW() ELSE api_access_windows.window_started_at END,
      updated_at=NOW()
    RETURNING hits
  `, [key]);
  return Number(result.rows[0]?.hits ?? 1) <= maxRequests;
}
