import { pool } from "./db";
import { schemaMigrations } from "./database-schema";

let initialized = false;
let initializing: Promise<void> | null = null;

const migrations = schemaMigrations;

export async function ensureDatabase() {
  if (initialized) return;
  if (initializing) return initializing;

  initializing = (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Multiple app instances can start together; serialize schema changes.
      await client.query("SELECT pg_advisory_xact_lock($1)", [741_205_331]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const applied = await client.query<{ id: number }>("SELECT id FROM schema_migrations");
      const ids = new Set(applied.rows.map((row) => row.id));

      for (const migration of migrations) {
        if (ids.has(migration.id)) continue;
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations(id) VALUES($1)", [migration.id]);
      }

      await client.query("COMMIT");
      initialized = true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })().finally(() => { initializing = null; });

  return initializing;
}
