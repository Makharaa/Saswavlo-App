import "server-only";

import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "crypto";
import { promisify } from "util";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { pool } from "@/lib/db";
import { ensureDatabase } from "@/lib/migrations";
import type { AuthUser, UserRole } from "@/types/domain";

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = "driveexam_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

let sessionSecurityReady = false;
let sessionSecurityPreparing: Promise<void> | null = null;

type SessionPayload = {
  uid: number;
  role: UserRole;
  exp: number;
  /**
   * Added in R24. Optional so cookies issued before this release continue to
   * work until the account signs in again and establishes an active session.
   */
  sid?: string;
};

export type SessionInvalidReason =
  | "missing"
  | "invalid"
  | "account_disabled"
  | "session_replaced";

export type CurrentSessionState = {
  user: AuthUser | null;
  reason: SessionInvalidReason | null;
};

function secret() {
  const value = process.env.AUTH_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new Error("AUTH_SECRET must be configured with at least 32 characters.");
  }
  return value;
}

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signature(payloadPart: string) {
  return createHmac("sha256", secret()).update(payloadPart).digest("base64url");
}

function mapAuthUser(row: any): AuthUser {
  return {
    id: Number(row.id),
    name: String(row.name),
    email: String(row.email),
    role: row.role as UserRole,
    isActive: Boolean(row.is_active),
    canUseRoutes: row.can_use_routes == null ? true : Boolean(row.can_use_routes),
  };
}

export function extractClientIp(request: Request) {
  const headers = request.headers;
  const cloudflare = headers.get("cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare;

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwarded = headers.get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  return forwarded || null;
}

function hashClientIp(ip: string | null) {
  if (!ip) return null;
  return createHmac("sha256", secret())
    .update(`driveexam-ip:${ip}`)
    .digest("hex");
}

export function createSessionToken(
  user: Pick<AuthUser, "id" | "role">,
  sessionId?: string | null
) {
  const payload: SessionPayload = {
    uid: user.id,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    ...(sessionId ? { sid: sessionId } : {}),
  };

  const payloadPart = encode(JSON.stringify(payload));
  return `${payloadPart}.${signature(payloadPart)}`;
}

export function verifySessionToken(
  token: string | undefined | null
): SessionPayload | null {
  if (!token) return null;

  const [payloadPart, sig] = token.split(".");
  if (!payloadPart || !sig) return null;

  const expected = signature(payloadPart);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(decode(payloadPart)) as SessionPayload;

    if (
      !Number.isInteger(payload.uid) ||
      !["admin", "driver"].includes(payload.role) ||
      payload.exp <= Math.floor(Date.now() / 1000) ||
      (payload.sid !== undefined &&
        (typeof payload.sid !== "string" || payload.sid.length < 16))
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encodedHash: string) {
  const [algorithm, saltPart, hashPart] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !saltPart || !hashPart) return false;

  const salt = Buffer.from(saltPart, "base64url");
  const expected = Buffer.from(hashPart, "base64url");
  const derived = (await scrypt(password, salt, expected.length)) as Buffer;

  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export async function getUserById(id: number): Promise<AuthUser | null> {
  await ensureDatabase();

  const result = await pool.query(
    `SELECT id,name,email,role,is_active,can_use_routes
     FROM app_users
     WHERE id=$1`,
    [id]
  );

  if (!result.rowCount) return null;
  return mapAuthUser(result.rows[0]);
}

async function ensureSessionSecurityStorage() {
  if (sessionSecurityReady) return;
  if (sessionSecurityPreparing) return sessionSecurityPreparing;

  sessionSecurityPreparing = (async () => {
    await ensureDatabase();

    // Self-healing guard for deployments where an older build/process or a
    // partially applied migration left the session columns unavailable.
    // IF NOT EXISTS makes this safe and idempotent.
    await pool.query(`
      ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS can_use_routes BOOLEAN NOT NULL DEFAULT TRUE;

      ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS active_session_id VARCHAR(96) NULL;

      ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS active_session_ip_hash VARCHAR(64) NULL;

      ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS active_session_started_at TIMESTAMPTZ NULL;
    `);

    sessionSecurityReady = true;
  })();

  try {
    await sessionSecurityPreparing;
  } finally {
    sessionSecurityPreparing = null;
  }
}

/**
 * Establishes the authoritative account session for a successful login.
 *
 * Every successful sign-in rotates a random server-side session identifier,
 * regardless of the IP address. All earlier cookies for that account become
 * invalid on their next API call, even on the same Wi-Fi network.
 */
export async function beginUserSession(userId: number, clientIp: string | null) {
  await ensureSessionSecurityStorage();

  const client = await pool.connect();
  const ipHash = hashClientIp(clientIp);

  try {
    await client.query("BEGIN");

    const current = await client.query(
      `SELECT active_session_id,active_session_ip_hash
       FROM app_users
       WHERE id=$1
       FOR UPDATE`,
      [userId]
    );

    if (!current.rowCount) {
      throw new Error("User not found while creating session");
    }

    const existingSession = current.rows[0].active_session_id
      ? String(current.rows[0].active_session_id).trim()
      : null;

    // Always issue a new server-authoritative session. Two phones on the same
    // Wi-Fi must not share a session merely because their public IP matches.
    const sessionId = randomBytes(32).toString("base64url");
    const replacedOtherSession = Boolean(existingSession);

    // Keep this UPDATE intentionally simple. The previous CASE/COALESCE
    // expression made runtime failures harder to diagnose on existing DBs.
    await client.query(
      `UPDATE app_users
       SET active_session_id=$1,
           active_session_ip_hash=$2,
           active_session_started_at=NOW(),
           updated_at=NOW()
       WHERE id=$3`,
      [sessionId, ipHash, userId]
    );

    await client.query("COMMIT");
    return { sessionId, replacedOtherSession };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getCurrentSessionState(): Promise<CurrentSessionState> {
  const store = await cookies();
  const rawToken = store.get(COOKIE_NAME)?.value;
  if (!rawToken) return { user: null, reason: "missing" };

  const payload = verifySessionToken(rawToken);
  if (!payload) return { user: null, reason: "invalid" };

  await ensureSessionSecurityStorage();
  const result = await pool.query(
    `SELECT
       id,name,email,role,is_active,can_use_routes,
       active_session_id
     FROM app_users
     WHERE id=$1`,
    [payload.uid]
  );

  if (!result.rowCount) return { user: null, reason: "invalid" };

  const row = result.rows[0];
  if (!row.is_active) {
    return { user: null, reason: "account_disabled" };
  }
  if (row.role !== payload.role) {
    return { user: null, reason: "invalid" };
  }

  const activeSessionId = row.active_session_id
    ? String(row.active_session_id)
    : null;

  // Require a server-issued session ID; unsigned-to-session legacy cookies
  // cannot bypass exclusive login after this security release.
  if (!payload.sid || !activeSessionId || payload.sid !== activeSessionId) {
    return { user: null, reason: "session_replaced" };
  }

  return { user: mapAuthUser(row), reason: null };
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  return (await getCurrentSessionState()).user;
}

export async function requireUser() {
  const state = await getCurrentSessionState();
  if (!state.user) {
    if (state.reason === "session_replaced") {
      redirect("/login?reason=session-replaced");
    }
    redirect("/login");
  }
  return state.user;
}

export async function requireRouteAccess() {
  const user = await requireUser();
  if (user.role !== "admin" && !user.canUseRoutes) {
    redirect("/access-restricted");
  }
  return user;
}

export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/routes");
  return user;
}

export async function setSessionCookie(user: AuthUser, sessionId?: string | null) {
  const store = await cookies();

  store.set(COOKIE_NAME, createSessionToken(user, sessionId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function refreshCurrentSessionCookie(user: AuthUser) {
  const store = await cookies();
  const payload = verifySessionToken(store.get(COOKIE_NAME)?.value);
  await setSessionCookie(user, payload?.sid ?? null);
}

export async function invalidateCurrentSession() {
  const store = await cookies();
  const payload = verifySessionToken(store.get(COOKIE_NAME)?.value);
  if (!payload?.sid) return;

  await ensureDatabase();
  await pool.query(
    `UPDATE app_users
     SET active_session_id=NULL,
         active_session_ip_hash=NULL,
         active_session_started_at=NULL,
         updated_at=NOW()
     WHERE id=$1 AND active_session_id=$2`,
    [payload.uid, payload.sid]
  );
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function ensureBootstrapAdmin() {
  await ensureDatabase();

  const existing = await pool.query(`SELECT COUNT(*)::int AS count FROM app_users`);
  if (Number(existing.rows[0]?.count ?? 0) > 0) return;

  const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD?.trim();
  const name = process.env.INITIAL_ADMIN_NAME?.trim() || "Administrator";

  if (!email || !password) return;

  if (password.length < 10) {
    throw new Error("INITIAL_ADMIN_PASSWORD must contain at least 10 characters.");
  }

  const passwordHash = await hashPassword(password);

  await pool.query(
    `INSERT INTO app_users(name,email,password_hash,role,is_active)
     VALUES($1,$2,$3,'admin',TRUE)
     ON CONFLICT (LOWER(email)) DO NOTHING`,
    [name, email, passwordHash]
  );
}
