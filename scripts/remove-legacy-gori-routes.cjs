#!/usr/bin/env node
// Explicit, admin-only deployment maintenance. Does not touch hand-created
// routes or licensed Simulatori.ge routes. Session history is retained by DB
// FK ON DELETE SET NULL and route_snapshot.
const fs = require('node:fs');
const { Pool } = require('pg');
const SOURCES = [
  'gori-route-1', 'gori-route-2', 'gori-route-3-lower',
  'gori-route-3-upper', 'gori-route-4-lower', 'gori-route-4-upper'
];
const apply = process.argv.includes('--apply');
const backupIndex = process.argv.indexOf('--backup-file');
const backupPath = backupIndex > 0 ? process.argv[backupIndex + 1] : null;
if (apply && (!backupPath || !fs.existsSync(backupPath) || fs.statSync(backupPath).size < 1024)) {
  console.error('Deletion refused: supply --backup-file /path/to/verified/pg_dump.backup (>=1 KiB).');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Default action is dry-run.');
  process.exit(2);
}
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Do not match route names: renamed and manually added routes are different.
    const legacy = await db.query(`
      SELECT er.id, er.name, er.city,
             (SELECT COUNT(*)::int FROM driving_sessions ds WHERE ds.route_id=er.id) AS linked_sessions
      FROM exam_routes er
      JOIN route_versions v ON v.route_id=er.id AND v.version=1
      WHERE v.snapshot->>'importSource' = ANY($1::text[])
      FOR UPDATE OF er`, [SOURCES]);
    const verified = await db.query(`
      SELECT count(DISTINCT v.snapshot->>'importSource')::int AS count
      FROM route_versions v WHERE v.version=1
        AND v.snapshot->>'importSource' = ANY($1::text[])`, [[1,2,3,4].map(n=>`simulatori-gori-route-${n}`)]);
    console.log(JSON.stringify({mode:apply?'apply':'dry-run', licensedImported:verified.rows[0].count,
      oldRoutes:legacy.rows, note:'Manual routes are not touched. Session history is retained.'},null,2));
    if (!apply) { await db.query('ROLLBACK'); return; }
    if (verified.rows[0].count !== 4) throw new Error('Import the four new Simulatori.ge routes before deleting old imports.');
    const ids = legacy.rows.map(r=>r.id);
    if (ids.length) {
      const result=await db.query('DELETE FROM exam_routes WHERE id = ANY($1::bigint[]) RETURNING id',[ids]);
      if (result.rowCount !== ids.length) throw new Error('Unexpected concurrent change; rolling back.');
    }
    await db.query('COMMIT');
    console.log(`Deleted ${ids.length} explicitly identified legacy imports. Backup kept at ${backupPath}.`);
  } catch (e) { await db.query('ROLLBACK').catch(()=>{}); console.error(e.message); process.exitCode=1; }
  finally { db.release(); await pool.end(); }
})().catch(err=>{ console.error(err.message); process.exitCode=1; });
