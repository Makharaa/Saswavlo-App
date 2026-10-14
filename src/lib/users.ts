import "server-only";
import { randomBytes } from "crypto";

import { pool } from "@/lib/db";
import { ensureDatabase } from "@/lib/migrations";
import { hashPassword } from "@/lib/auth";
import type { AdminUser, UserRole } from "@/types/domain";

function mapUser(row: any): AdminUser {
  return {
    id: Number(row.id),
    name: String(row.name),
    email: String(row.email),
    role: row.role as UserRole,
    isActive: Boolean(row.is_active),
    canUseRoutes: row.can_use_routes == null ? true : Boolean(row.can_use_routes),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export async function findUserForLogin(email: string) {
  await ensureDatabase();
  const result = await pool.query(
    `SELECT * FROM app_users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
    [email]
  );
  return result.rows[0] ?? null;
}

export async function listUsers() {
  await ensureDatabase();
  const result = await pool.query(
    `SELECT id,name,email,role,is_active,can_use_routes,created_at,updated_at
     FROM app_users ORDER BY created_at DESC,id DESC`
  );
  return result.rows.map(mapUser);
}

export async function getAdminUserById(id: number) {
  await ensureDatabase();
  const result = await pool.query(
    `SELECT id,name,email,role,is_active,can_use_routes,created_at,updated_at
     FROM app_users WHERE id=$1`,
    [id]
  );
  return result.rowCount ? mapUser(result.rows[0]) : null;
}

export async function countActiveAdmins() {
  await ensureDatabase();
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM app_users WHERE role='admin' AND is_active=TRUE`
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
  role: UserRole;
}) {
  await ensureDatabase();

  const passwordHash = await hashPassword(input.password);
  const result = await pool.query(
    `INSERT INTO app_users(name,email,password_hash,role,is_active)
     VALUES($1,LOWER($2),$3,$4,TRUE)
     RETURNING id,name,email,role,is_active,can_use_routes,created_at,updated_at`,
    [input.name.trim(), input.email.trim(), passwordHash, input.role]
  );

  return mapUser(result.rows[0]);
}

export async function updateUser(
  id: number,
  input: {
    name?: string;
    email?: string;
    role?: UserRole;
    isActive?: boolean;
    canUseRoutes?: boolean;
    password?: string;
  }
) {
  await ensureDatabase();

  const assignments: string[] = [];
  const values: unknown[] = [];

  function addAssignment(sql: string, value: unknown) {
    values.push(value);
    assignments.push(sql.replace("$VALUE", `$${values.length}`));
  }

  if (input.name !== undefined) {
    addAssignment("name=$VALUE", input.name.trim());
  }

  if (input.email !== undefined) {
    addAssignment("email=LOWER($VALUE)", input.email.trim());
  }

  if (input.role !== undefined) {
    addAssignment("role=$VALUE", input.role);

    if (input.role === "admin") {
      assignments.push("can_use_routes=TRUE");
    }
  }

  if (input.isActive !== undefined) {
    addAssignment("is_active=$VALUE", input.isActive);
  }

  if (input.canUseRoutes !== undefined) {
    addAssignment("can_use_routes=$VALUE", input.canUseRoutes);
  }

  if (input.password) {
    const passwordHash = await hashPassword(input.password);
    addAssignment("password_hash=$VALUE", passwordHash);
    // Administrator-assisted recovery resets PIN and all trusted devices.
    // A new password must also invalidate any already-issued session cookie.
    assignments.push("pin_hash=NULL");
    addAssignment("active_session_id=$VALUE", randomBytes(32).toString("base64url"));
    assignments.push("active_session_ip_hash=NULL", "active_session_started_at=NULL");
  }

  if (!assignments.length) {
    return getAdminUserById(id);
  }

  assignments.push("updated_at=NOW()");
  values.push(id);

  const updateSql = `UPDATE app_users
     SET ${assignments.join(", ")}
     WHERE id=$${values.length}
     RETURNING id,name,email,role,is_active,can_use_routes,created_at,updated_at`;

  if (!input.password) {
    const result = await pool.query(updateSql, values);
    return result.rowCount ? mapUser(result.rows[0]) : null;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(updateSql, values);
    await client.query("DELETE FROM trusted_login_devices WHERE user_id=$1", [id]);
    await client.query("DELETE FROM pin_login_attempts WHERE user_id=$1", [id]);
    await client.query("COMMIT");
    return result.rowCount ? mapUser(result.rows[0]) : null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

