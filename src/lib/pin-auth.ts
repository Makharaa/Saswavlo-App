import "server-only";

import { createHmac, randomBytes } from "crypto";
import { cookies } from "next/headers";
import { pool } from "@/lib/db";
import { ensureDatabase } from "@/lib/migrations";
import { hashPassword, verifyPassword } from "@/lib/auth";

const DEVICE_MAX_AGE = 60 * 60 * 24 * 30;
const PIN_MAX_FAILURES = 5;
const PIN_BLOCK_MINUTES = 15;
const PIN_COOKIE = process.env.NODE_ENV === "production"
  ? "__Host-driveexam_trusted_device"
  : "driveexam_trusted_device";

function secret(): string {
  const secretValue = (process.env.PIN_PEPPER || process.env.AUTH_SECRET || "").trim();
  if (secretValue.length < 32) throw new Error("PIN_PEPPER or AUTH_SECRET must be at least 32 characters.");
  return secretValue;
}

function peppered(pin: string): string {
  return createHmac("sha256", secret()).update(`pin-v1:${pin}`).digest("hex");
}

function deviceHash(token: string): string {
  return createHmac("sha256", secret()).update(`device-v1:${token}`).digest("hex");
}

export function validPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^[0-9]{4}$/.test(pin);
}

export function weakPin(pin: string): boolean {
  if (!validPin(pin)) return true;
  if (/^(\d)\1{3}$/.test(pin)) return true;
  return ["1234", "4321", "0123", "9876", "2580", "0852", "1212", "1122", "0001", "1000"].includes(pin);
}

export async function hashPin(pin: string): Promise<string> {
  if (!validPin(pin) || weakPin(pin)) throw new Error("PIN must be four non-obvious digits.");
  return hashPassword(peppered(pin));
}

export async function verifyPin(pin: string, hash: string | null): Promise<boolean> {
  if (!validPin(pin) || !hash) return false;
  return verifyPassword(peppered(pin), hash);
}

export async function isTrustedDevice(userId: number): Promise<boolean> {
  const store = await cookies();
  const token = store.get(PIN_COOKIE)?.value;
  if (!token || !/^[a-zA-Z0-9_-]{40,90}$/.test(token)) return false;
  await ensureDatabase();
  const result = await pool.query(
    `SELECT 1 FROM trusted_login_devices
     WHERE user_id=$1 AND token_hash=$2 AND expires_at>NOW()`,
    [userId, deviceHash(token)]
  );
  return Boolean(result.rowCount);
}

export async function trustCurrentDevice(userId: number): Promise<void> {
  await ensureDatabase();
  const token = randomBytes(48).toString("base64url");
  await pool.query(
    `INSERT INTO trusted_login_devices (user_id,token_hash,expires_at,last_used_at)
     VALUES($1,$2,NOW() + INTERVAL '30 days',NOW())
     ON CONFLICT (user_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,
       expires_at=EXCLUDED.expires_at,last_used_at=NOW()`,
    [userId, deviceHash(token)]
  );
  const store = await cookies();
  store.set(PIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: DEVICE_MAX_AGE,
  });
}

export async function clearTrustedDeviceCookie(): Promise<void> {
  const store = await cookies();
  store.set(PIN_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}

export async function pinAttemptsBlocked(userId: number): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
  await ensureDatabase();
  const result = await pool.query("SELECT blocked_until FROM pin_login_attempts WHERE user_id=$1", [userId]);
  const time = result.rows[0]?.blocked_until ? new Date(result.rows[0].blocked_until).getTime() : 0;
  const seconds = Math.max(0, Math.ceil((time - Date.now()) / 1000));
  return { blocked: seconds > 0, retryAfterSeconds: seconds };
}

export async function recordPinFailure(userId: number): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
  await ensureDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO pin_login_attempts(user_id) VALUES($1) ON CONFLICT DO NOTHING", [userId]);
    const row = await client.query(
      "SELECT failures,window_started_at,blocked_until FROM pin_login_attempts WHERE user_id=$1 FOR UPDATE", [userId]
    );
    const now = Date.now();
    const item = row.rows[0];
    const existingBlock = item?.blocked_until ? new Date(item.blocked_until).getTime() : 0;
    if (existingBlock > now) {
      await client.query("COMMIT");
      return { blocked: true, retryAfterSeconds: Math.ceil((existingBlock - now) / 1000) };
    }
    const withinWindow = item?.window_started_at && now - new Date(item.window_started_at).getTime() < PIN_BLOCK_MINUTES * 60_000;
    const failures = (withinWindow ? Number(item.failures) : 0) + 1;
    const blocked = failures >= PIN_MAX_FAILURES;
    await client.query(
      `UPDATE pin_login_attempts SET failures=$2,
        window_started_at=CASE WHEN $3 THEN window_started_at ELSE NOW() END,
        blocked_until=CASE WHEN $4 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END
       WHERE user_id=$1`,
      [userId, failures, Boolean(withinWindow), blocked]
    );
    await client.query("COMMIT");
    return { blocked, retryAfterSeconds: blocked ? PIN_BLOCK_MINUTES * 60 : 0 };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function clearPinFailures(userId: number): Promise<void> {
  await ensureDatabase();
  await pool.query("DELETE FROM pin_login_attempts WHERE user_id=$1", [userId]);
}
