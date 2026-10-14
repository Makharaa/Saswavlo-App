import "server-only";

import { createHash } from "crypto";
import { pool } from "@/lib/db";
import { ensureDatabase } from "@/lib/migrations";

const WINDOW_MINUTES = 15;
const MAX_FAILURES = 8;
const BLOCK_MINUTES = 10;

function identifier(email: string) {
  return createHash("sha256")
    .update(email.trim().toLowerCase(), "utf8")
    .digest("hex");
}

export async function checkLoginRateLimit(email: string) {
  await ensureDatabase();
  const key = identifier(email);
  const result = await pool.query(
    `SELECT blocked_until
     FROM login_attempts
     WHERE identifier=$1`,
    [key]
  );

  const blockedUntil = result.rows[0]?.blocked_until
    ? new Date(result.rows[0].blocked_until).getTime()
    : 0;
  const now = Date.now();

  if (blockedUntil > now) {
    return {
      blocked: true as const,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)),
    };
  }

  return { blocked: false as const, retryAfterSeconds: 0 };
}

export async function recordLoginFailure(email: string) {
  await ensureDatabase();
  const key = identifier(email);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialize failures for the same identifier, including the very first
    // failed attempt when no row exists yet.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);

    // Keep the throttle table bounded without requiring a separate cron job.
    await client.query(
      "DELETE FROM login_attempts WHERE updated_at < NOW() - INTERVAL '7 days'"
    );

    const existing = await client.query(
      `SELECT fail_count,window_started_at,blocked_until
       FROM login_attempts
       WHERE identifier=$1
       FOR UPDATE`,
      [key]
    );

    const now = Date.now();
    let failCount = 1;
    let windowStartedAt = new Date(now);

    if (existing.rowCount) {
      const oldWindow = new Date(existing.rows[0].window_started_at).getTime();
      if (now - oldWindow <= WINDOW_MINUTES * 60_000) {
        failCount = Number(existing.rows[0].fail_count ?? 0) + 1;
        windowStartedAt = new Date(oldWindow);
      }
    }

    const blockedUntil =
      failCount >= MAX_FAILURES
        ? new Date(now + BLOCK_MINUTES * 60_000)
        : null;

    await client.query(
      `INSERT INTO login_attempts
         (identifier,fail_count,window_started_at,blocked_until,updated_at)
       VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT(identifier) DO UPDATE SET
         fail_count=EXCLUDED.fail_count,
         window_started_at=EXCLUDED.window_started_at,
         blocked_until=EXCLUDED.blocked_until,
         updated_at=NOW()`,
      [key, failCount, windowStartedAt, blockedUntil]
    );

    await client.query("COMMIT");
    return {
      blocked: blockedUntil != null,
      retryAfterSeconds: blockedUntil ? BLOCK_MINUTES * 60 : 0,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function clearLoginFailures(email: string) {
  await ensureDatabase();
  await pool.query("DELETE FROM login_attempts WHERE identifier=$1", [
    identifier(email),
  ]);
}
