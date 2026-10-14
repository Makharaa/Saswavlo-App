import "server-only";

import { pool } from "@/lib/db";
import { ensureDatabase } from "@/lib/migrations";
import type { AuditEntityType, AuditLogEntry } from "@/types/domain";

function mapAudit(row: any): AuditLogEntry {
  return {
    id: Number(row.id),
    actorUserId: row.actor_user_id == null ? null : Number(row.actor_user_id),
    actorName: row.actor_name == null ? null : String(row.actor_name),
    action: String(row.action),
    entityType: row.entity_type as AuditEntityType,
    entityId: row.entity_id == null ? null : String(row.entity_id),
    summary: String(row.summary ?? ""),
    metadata:
      row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  };
}

export async function writeAuditLog(input: {
  actorUserId?: number | null;
  action: string;
  entityType: AuditEntityType;
  entityId?: string | number | null;
  summary: string;
  metadata?: Record<string, unknown>;
}) {
  await ensureDatabase();

  await pool.query(
    `INSERT INTO audit_logs
      (actor_user_id, action, entity_type, entity_id, summary, metadata)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      input.actorUserId ?? null,
      input.action.slice(0, 80),
      input.entityType,
      input.entityId == null ? null : String(input.entityId).slice(0, 120),
      input.summary.slice(0, 2000),
      JSON.stringify(input.metadata ?? {}),
    ]
  );
}

export async function listAuditLogs(input: {
  limit?: number;
  action?: string;
  entityType?: AuditEntityType;
  query?: string;
} = {}) {
  await ensureDatabase();

  const values: unknown[] = [];
  const where: string[] = [];

  if (input.action) {
    values.push(input.action);
    where.push(`al.action=$${values.length}`);
  }

  if (input.entityType) {
    values.push(input.entityType);
    where.push(`al.entity_type=$${values.length}`);
  }

  const query = input.query?.trim();
  if (query) {
    values.push(`%${query}%`);
    where.push(
      `(al.summary ILIKE $${values.length} OR al.action ILIKE $${values.length} OR al.entity_id ILIKE $${values.length} OR u.name ILIKE $${values.length})`
    );
  }

  const limit = Math.max(1, Math.min(input.limit ?? 200, 500));
  values.push(limit);

  const result = await pool.query(
    `SELECT al.*,u.name AS actor_name
     FROM audit_logs al
     LEFT JOIN app_users u ON u.id=al.actor_user_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY al.created_at DESC, al.id DESC
     LIMIT $${values.length}`,
    values
  );

  return result.rows.map(mapAudit);
}
