import { logOperationError } from "@/lib/logger";
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { ensureDatabase } from "@/lib/migrations";
import { APP_NAME, APP_VERSION, APP_RELEASE, DB_SCHEMA_VERSION } from "@/lib/app-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();

  try {
    // Health is also the deployment smoke test: all pending migrations must be
    // successfully applied before the endpoint reports the application healthy.
    await ensureDatabase();

    const schema = await pool.query<{ version: number }>(
      "SELECT COALESCE(MAX(id),0)::int AS version FROM schema_migrations"
    );
    const schemaVersion = Number(schema.rows[0]?.version ?? 0);
    const schemaHealthy = schemaVersion >= DB_SCHEMA_VERSION;

    return NextResponse.json(
      {
        ok: schemaHealthy,
        app: APP_NAME,
        version: APP_VERSION,
        release: APP_RELEASE,
        database: schemaHealthy ? "ok" : "migration_required",
        schemaVersion,
        expectedSchemaVersion: DB_SCHEMA_VERSION,
        responseMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      {
        status: schemaHealthy ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    logOperationError("health", error);

    return NextResponse.json(
      {
        ok: false,
        app: APP_NAME,
        version: APP_VERSION,
        release: APP_RELEASE,
        database: "error",
        schemaVersion: null,
        expectedSchemaVersion: DB_SCHEMA_VERSION,
        responseMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
