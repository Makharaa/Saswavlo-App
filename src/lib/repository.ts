import { pool } from "./db";
import { historyJoins, historyWhere, historyOrder, type HistoryPageFilters } from "./history-page-query";
import { ensureDatabase } from "./migrations";
import { downsampleCoordinates } from "@/utils/geo";
import { normalizeSpeedZones } from "@/utils/route-engine";
import { carryFieldTest } from "@/utils/route-readiness";
import type {
  DrivingSessionResult,
  DrivingSessionSummary,
  ExamRoute,
  RouteCheckpoint,
  RouteDraft,
  RouteSpeedZone,
} from "@/types/domain";

function mapCheckpoint(row: Record<string, unknown>): RouteCheckpoint {
  return {
    id: Number(row.id),
    routeId: Number(row.route_id),
    orderIndex: Number(row.order_index),
    lng: Number(row.lng),
    lat: Number(row.lat),
    type: row.checkpoint_type as RouteCheckpoint["type"],
    title: String(row.title ?? ""),
    voice: String(row.voice ?? ""),
    ttsVoice: String(row.tts_voice ?? "ka-GE-EkaNeural") as RouteCheckpoint["ttsVoice"],
    speedLimit: row.speed_limit == null ? null : Number(row.speed_limit),
    triggerMeters: Number(row.trigger_meters),
    evaluation: row.evaluation_settings && typeof row.evaluation_settings === "object" ? row.evaluation_settings as RouteCheckpoint["evaluation"] : undefined,
    routeCoordinateIndex:
      row.route_coordinate_index == null
        ? null
        : Number(row.route_coordinate_index),
  };
}

async function hydrateRoute(row: Record<string, unknown>): Promise<ExamRoute> {
  const checkpoints = await pool.query(
    `SELECT * FROM route_checkpoints WHERE route_id=$1 ORDER BY order_index,id`,
    [row.id]
  );

  return {
    id: Number(row.id),
    name: String(row.name),
    city: String(row.city),
    description: String(row.description ?? ""),
    isPublished: Boolean(row.is_published),
    waypoints: Array.isArray(row.waypoints)
      ? (row.waypoints as [number, number][])
      : Array.isArray(row.coordinates)
        ? (row.coordinates as [number, number][])
        : [],
    coordinates: Array.isArray(row.coordinates)
      ? (row.coordinates as [number, number][])
      : [],
    waypointCoordinateIndices: Array.isArray(row.waypoint_coordinate_indices) && row.waypoint_coordinate_indices.length
      ? row.waypoint_coordinate_indices as number[]
      : undefined,
    speedZones: normalizeSpeedZones(
      Array.isArray(row.speed_zones) ? (row.speed_zones as RouteSpeedZone[]) : [],
      Array.isArray(row.coordinates) ? (row.coordinates as [number, number][]) : []
    ),
    checkpoints: checkpoints.rows.map(mapCheckpoint),
    version: Number(row.version ?? 1),
    fieldTestedAt: row.field_tested_at == null ? null : new Date(String(row.field_tested_at)).toISOString(),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at ?? ""),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at ?? ""),
  };
}

export class RouteVersionConflictError extends Error {
  currentVersion: number;

  constructor(currentVersion: number) {
    super("Route version conflict");
    this.name = "RouteVersionConflictError";
    this.currentVersion = currentVersion;
  }
}

export async function listRoutes(options?: {
  publishedOnly?: boolean;
  city?: string;
}) {
  await ensureDatabase();
  const values: unknown[] = [];
  const filters: string[] = [];

  if (options?.publishedOnly) filters.push("is_published=TRUE");
  if (options?.city) {
    values.push(options.city);
    filters.push(`city=$${values.length}`);
  }

  const result = await pool.query(
    `SELECT * FROM exam_routes ${
      filters.length ? `WHERE ${filters.join(" AND ")}` : ""
    } ORDER BY id DESC`,
    values
  );

  return Promise.all(result.rows.map(hydrateRoute));
}

export async function listRouteCities(publishedOnly: boolean) {
  await ensureDatabase();
  const result = await pool.query(
    `SELECT DISTINCT city
     FROM exam_routes
     ${publishedOnly ? "WHERE is_published=TRUE" : ""}
     ORDER BY city`
  );
  return result.rows.map((row) => String(row.city));
}

export async function getRoute(id: number) {
  await ensureDatabase();
  const result = await pool.query("SELECT * FROM exam_routes WHERE id=$1", [id]);
  if (!result.rowCount) return null;
  return hydrateRoute(result.rows[0]);
}

function checkpointForWrite(checkpoint: RouteCheckpoint, index: number) {
  return {
    ...checkpoint,
    orderIndex: index,
    title: String(checkpoint.title ?? "").trim(),
    voice: String(checkpoint.voice ?? "").trim(),
    ttsVoice: checkpoint.ttsVoice || "ka-GE-EkaNeural",
    speedLimit: checkpoint.speedLimit == null ? null : Number(checkpoint.speedLimit),
    triggerMeters: Number.isFinite(checkpoint.triggerMeters)
      ? Math.max(10, Math.min(1000, Math.round(checkpoint.triggerMeters)))
      : 120,
    routeCoordinateIndex:
      checkpoint.routeCoordinateIndex == null ||
      !Number.isFinite(checkpoint.routeCoordinateIndex)
        ? null
        : Math.max(0, Math.round(checkpoint.routeCoordinateIndex)),
  };
}

async function createRouteWithImportSource(
  input: Partial<RouteDraft>,
  editedBy?: number | null,
  importSource?: string
) {
  await ensureDatabase();
  const client = await pool.connect();
  let released = false;

  const draft: RouteDraft = {
    name: input.name?.trim() || "გორი • ახალი მარშრუტი",
    city: input.city?.trim() || "გორი",
    description: input.description || "",
    isPublished: Boolean(input.isPublished),
    fieldTestedAt: null,
    waypoints:
      input.waypoints ||
      (input.coordinates ? downsampleCoordinates(input.coordinates, 500) : []),
    coordinates: input.coordinates || [],
    waypointCoordinateIndices: input.waypointCoordinateIndices,
    speedZones: normalizeSpeedZones(
      input.speedZones || [],
      input.coordinates || []
    ),
    checkpoints: input.checkpoints || [],
  };

  try {
    await client.query("BEGIN");

    if (importSource) {
      // Keep the source identity in immutable version 1 so later edits and
      // renames cannot make a retry create a second copy of the same import.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`driveexam-route-import:${importSource}`]);
      const existing = await client.query(
        `SELECT er.id FROM exam_routes er
         JOIN route_versions rv ON rv.route_id=er.id AND rv.version=1
         WHERE rv.snapshot->>'importSource'=$1 ORDER BY er.id LIMIT 1`,
        [importSource]
      );
      if (existing.rowCount) {
        const id = Number(existing.rows[0].id);
        await client.query("COMMIT");
        client.release();
        released = true;
        return { route: await getRoute(id), reused: true };
      }
    }

    const inserted = await client.query(
      `INSERT INTO exam_routes(
         name,city,description,is_published,waypoints,coordinates,speed_zones,waypoint_coordinate_indices,version
       )
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,1)
       RETURNING id`,
      [
        draft.name,
        draft.city,
        draft.description,
        draft.isPublished,
        JSON.stringify(draft.waypoints),
        JSON.stringify(draft.coordinates),
        JSON.stringify(draft.speedZones),
        JSON.stringify(draft.waypointCoordinateIndices ?? []),
      ]
    );

    const routeId = Number(inserted.rows[0].id);

    for (let index = 0; index < draft.checkpoints.length; index += 1) {
      const checkpoint = checkpointForWrite(draft.checkpoints[index], index);
      await client.query(
        `INSERT INTO route_checkpoints
          (route_id,order_index,lng,lat,checkpoint_type,title,voice,tts_voice,speed_limit,trigger_meters,route_coordinate_index,evaluation_settings)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          routeId,
          index,
          checkpoint.lng,
          checkpoint.lat,
          checkpoint.type,
          checkpoint.title,
          checkpoint.voice,
          checkpoint.ttsVoice,
          checkpoint.speedLimit,
          checkpoint.triggerMeters,
          checkpoint.routeCoordinateIndex,
          JSON.stringify(checkpoint.evaluation ?? {}),
        ]
      );
    }

    await client.query(
      `INSERT INTO route_versions(route_id,version,snapshot,edited_by)
       VALUES($1,1,$2::jsonb,$3)
       ON CONFLICT(route_id,version) DO NOTHING`,
      [routeId, JSON.stringify({ ...draft, version: 1, ...(importSource ? { importSource } : {}) }), editedBy ?? null]
    );

    await client.query("COMMIT");
    client.release();
    released = true;
    return { route: await getRoute(routeId), reused: false };
  } catch (error) {
    if (!released) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (!released) client.release();
  }
}

export async function createRoute(input: Partial<RouteDraft>, editedBy?: number | null) {
  return (await createRouteWithImportSource(input, editedBy)).route;
}

export async function importRouteDraft(source: string, input: Partial<RouteDraft>, editedBy?: number | null) {
  return createRouteWithImportSource({ ...input, isPublished: false, fieldTestedAt: null }, editedBy, source);
}

export async function saveRoute(
  id: number,
  input: RouteDraft,
  editedBy?: number | null,
  expectedVersion?: number | null
) {
  await ensureDatabase();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const original = await client.query("SELECT * FROM exam_routes WHERE id=$1 FOR UPDATE", [id]);
    if (!original.rowCount) throw new Error("Route not found");
    const oldPoints = await client.query("SELECT * FROM route_checkpoints WHERE route_id=$1 ORDER BY order_index,id", [id]);
    const row = original.rows[0];
    const fieldTestedAt = carryFieldTest({ ...input, coordinates: row.coordinates ?? [], speedZones: normalizeSpeedZones(row.speed_zones ?? [], row.coordinates ?? []),
      checkpoints: oldPoints.rows.map(mapCheckpoint), fieldTestedAt: row.field_tested_at == null ? null : new Date(String(row.field_tested_at)).toISOString() }, input);

    const values: unknown[] = [
      input.name,
      input.city,
      input.description,
      input.isPublished,
      JSON.stringify(input.waypoints),
      JSON.stringify(input.coordinates),
      JSON.stringify(normalizeSpeedZones(input.speedZones, input.coordinates)),
      JSON.stringify(input.waypointCoordinateIndices ?? []),
      fieldTestedAt,
      id,
    ];

    let where = "id=$10";
    if (expectedVersion != null) {
      values.push(expectedVersion);
      where += " AND version=$11";
    }

    const updated = await client.query(
      `UPDATE exam_routes
       SET name=$1,
           city=$2,
           description=$3,
           is_published=$4,
           waypoints=$5::jsonb,
           coordinates=$6::jsonb,
           speed_zones=$7::jsonb,
           waypoint_coordinate_indices=$8::jsonb,
           field_tested_at=$9,
           version=version+1,
           updated_at=NOW()
       WHERE ${where}
       RETURNING version`,
      values
    );

    if (!updated.rowCount) {
      const current = await client.query(
        "SELECT version FROM exam_routes WHERE id=$1",
        [id]
      );

      if (!current.rowCount) throw new Error("Route not found");
      throw new RouteVersionConflictError(Number(current.rows[0].version));
    }

    await client.query("DELETE FROM route_checkpoints WHERE route_id=$1", [id]);

    for (let index = 0; index < input.checkpoints.length; index += 1) {
      const checkpoint = checkpointForWrite(input.checkpoints[index], index);
      await client.query(
        `INSERT INTO route_checkpoints
          (route_id,order_index,lng,lat,checkpoint_type,title,voice,tts_voice,speed_limit,trigger_meters,route_coordinate_index,evaluation_settings)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          id,
          index,
          checkpoint.lng,
          checkpoint.lat,
          checkpoint.type,
          checkpoint.title,
          checkpoint.voice,
          checkpoint.ttsVoice,
          checkpoint.speedLimit,
          checkpoint.triggerMeters,
          checkpoint.routeCoordinateIndex,
          JSON.stringify(checkpoint.evaluation ?? {}),
        ]
      );
    }

    const version = Number(updated.rows[0].version);

    await client.query(
      `INSERT INTO route_versions(route_id,version,snapshot,edited_by)
       VALUES($1,$2,$3::jsonb,$4)
       ON CONFLICT(route_id,version) DO NOTHING`,
      [id, version, JSON.stringify({ ...input, fieldTestedAt, version }), editedBy ?? null]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getRoute(id);
}

export async function getRouteVersions(id: number, limit = 20) {
  await ensureDatabase();
  const result = await pool.query(
    `SELECT rv.id,rv.route_id,rv.version,rv.edited_by,rv.created_at,
            u.name AS edited_by_name
     FROM route_versions rv
     LEFT JOIN app_users u ON u.id=rv.edited_by
     WHERE rv.route_id=$1
     ORDER BY rv.version DESC
     LIMIT $2`,
    [id, Math.max(1, Math.min(limit, 500))]
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    routeId: Number(row.route_id),
    version: Number(row.version),
    editedBy: row.edited_by == null ? null : Number(row.edited_by),
    editedByName:
      row.edited_by_name == null ? null : String(row.edited_by_name),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  }));
}

export async function getRouteVersionSnapshot(id: number, version: number) {
  await ensureDatabase();
  const result = await pool.query(
    `SELECT snapshot FROM route_versions WHERE route_id=$1 AND version=$2`,
    [id, version]
  );
  if (!result.rowCount) return null;
  return result.rows[0].snapshot as RouteDraft & { version?: number };
}

export async function restoreRouteVersion(
  id: number,
  version: number,
  expectedVersion: number,
  editedBy?: number | null
) {
  const snapshot = await getRouteVersionSnapshot(id, version);
  if (!snapshot) return null;

  return saveRoute(
    id,
    {
      name: snapshot.name,
      city: snapshot.city,
      description: snapshot.description,
      isPublished: false,
      waypoints: snapshot.waypoints || snapshot.coordinates || [],
      coordinates: snapshot.coordinates || [],
      waypointCoordinateIndices: snapshot.waypointCoordinateIndices,
      speedZones: snapshot.speedZones || [],
      checkpoints: snapshot.checkpoints || [],
    },
    editedBy,
    expectedVersion
  );
}

export async function deleteRoute(id: number, expectedVersion?: number | null) {
  await ensureDatabase();

  if (expectedVersion == null) {
    const deleted = await pool.query(
      "DELETE FROM exam_routes WHERE id=$1 RETURNING id",
      [id]
    );
    return (deleted.rowCount ?? 0) > 0;
  }

  const deleted = await pool.query(
    "DELETE FROM exam_routes WHERE id=$1 AND version=$2 RETURNING id",
    [id, expectedVersion]
  );

  if (deleted.rowCount) return true;

  const current = await pool.query(
    "SELECT version FROM exam_routes WHERE id=$1",
    [id]
  );
  if (!current.rowCount) return false;
  throw new RouteVersionConflictError(Number(current.rows[0].version));
}

export async function findDrivingSessionId(userId: number, clientSessionId: string): Promise<number | null> {
  await ensureDatabase();
  const existing = await pool.query("SELECT id FROM driving_sessions WHERE user_id=$1 AND client_session_id=$2 LIMIT 1", [userId, clientSessionId]);
  return existing.rowCount ? Number(existing.rows[0].id) : null;
}

export async function saveDrivingSession(
  input: DrivingSessionResult,
  userId: number
) {
  await ensureDatabase();
  const existingId = await findDrivingSessionId(userId, input.clientSessionId);
  if (existingId != null) return { id: existingId, duplicate: true as const };
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let routeVersion: number | null = null;
    let routeName: string | null = null;
    let routeCity: string | null = null;
    let routeSnapshot: RouteDraft | null = null;

    if (input.routeId != null) {
      if (input.routeVersion != null) {
        const version = await client.query(
          `SELECT version,snapshot FROM route_versions WHERE route_id=$1 AND version=$2`,
          [input.routeId, input.routeVersion]
        );
        if (!version.rowCount) {
          throw new Error("სესიის მარშრუტის ვერსია ვერ მოიძებნა.");
        }
        const snapshot = typeof version.rows[0].snapshot === "string"
          ? JSON.parse(version.rows[0].snapshot)
          : version.rows[0].snapshot;
        routeSnapshot = snapshot;
        routeVersion = Number(version.rows[0].version);
        routeName = typeof snapshot?.name === "string" ? snapshot.name : null;
        routeCity = typeof snapshot?.city === "string" ? snapshot.city : null;
      } else {
        // Compatibility for queued sessions created by older clients.
        const route = await client.query(
          `SELECT version,name,city FROM exam_routes WHERE id=$1`,
          [input.routeId]
        );
        if (route.rowCount) {
          routeVersion = Number(route.rows[0].version);
          routeName = String(route.rows[0].name);
          routeCity = String(route.rows[0].city);
        }
      }
    }

    const session = await client.query(
      `INSERT INTO driving_sessions
        (route_id,user_id,client_session_id,route_version,route_name_snapshot,route_city_snapshot,
         drive_mode,assist_mode,started_at,finished_at,duration_seconds,
         distance_meters,max_speed_kmh,speeding_events,off_route_events,
         checkpoints_completed,checkpoints_total,trace,evaluation,trace_complete,route_snapshot,route_id_snapshot)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9 / 1000.0),to_timestamp($10 / 1000.0),$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21::jsonb,$22)
       ON CONFLICT (user_id, client_session_id) DO NOTHING
       RETURNING id`,
      [
        input.routeId,
        userId,
        input.clientSessionId,
        routeVersion,
        routeName,
        routeCity,
        input.mode,
        input.assistMode,
        input.startedAt,
        input.finishedAt,
        input.durationSeconds,
        input.distanceMeters,
        input.maxSpeedKmh,
        input.speedingEvents,
        input.offRouteEvents,
        input.checkpointsCompleted,
        input.checkpointsTotal,
        JSON.stringify(input.trace ?? []),
        JSON.stringify(input.evaluation ?? null),
        input.traceComplete === true,
        JSON.stringify(routeSnapshot),
        input.routeId,
      ]
    );

    let sessionId: number;
    if (session.rowCount) {
      sessionId = Number(session.rows[0].id);
    } else {
      const existing = await client.query(
        `SELECT id FROM driving_sessions
         WHERE user_id=$1 AND client_session_id=$2
         LIMIT 1`,
        [userId, input.clientSessionId]
      );
      if (!existing.rowCount) {
        throw new Error("Idempotent session lookup failed");
      }
      sessionId = Number(existing.rows[0].id);
      await client.query("COMMIT");
      return { id: sessionId, duplicate: true as const };
    }

    if (input.events.length) await client.query(
      `INSERT INTO driving_events (session_id,event_type,event_time,lng,lat,value,limit_value,checkpoint_index,note)
       SELECT $1,e.event_type,to_timestamp(e.event_time / 1000.0),e.lng,e.lat,e.value,e.limit_value,e.checkpoint_index,COALESCE(e.note,'')
       FROM jsonb_to_recordset($2::jsonb) AS e(event_type text,event_time double precision,lng double precision,lat double precision,
         value double precision,limit_value double precision,checkpoint_index integer,note text)`,
      [sessionId, JSON.stringify(input.events.map((event) => ({ event_type: event.type, event_time: event.timestamp,
        lng: event.lng ?? null, lat: event.lat ?? null, value: event.value ?? null, limit_value: event.limitValue ?? null,
        checkpoint_index: event.checkpointIndex ?? null, note: event.note ?? "" })))],
    );

    await client.query("COMMIT");
    return { id: sessionId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function mapDrivingSessionSummary(row: Record<string, unknown>): DrivingSessionSummary {
  return {
    id: Number(row.id),
    clientSessionId: String(row.client_session_id ?? `legacy-${row.id}`),
    routeId: row.route_id == null ? null : Number(row.route_id),
    userId: row.user_id == null ? null : Number(row.user_id),
    userName: row.user_name == null ? null : String(row.user_name),
    routeName: row.route_name == null ? null : String(row.route_name),
    routeOriginId: row.route_id_snapshot == null ? null : Number(row.route_id_snapshot),
    city: row.route_city == null ? null : String(row.route_city),
    routeVersion: row.route_version == null ? null : Number(row.route_version),
    mode: row.drive_mode as DrivingSessionSummary["mode"],
    assistMode: row.assist_mode as DrivingSessionSummary["assistMode"],
    startedAt: new Date(String(row.started_at)).getTime(),
    finishedAt: new Date(String(row.finished_at)).getTime(),
    durationSeconds: Number(row.duration_seconds),
    distanceMeters: Number(row.distance_meters),
    maxSpeedKmh: Number(row.max_speed_kmh),
    speedingEvents: Number(row.speeding_events),
    offRouteEvents: Number(row.off_route_events),
    checkpointsCompleted: Number(row.checkpoints_completed),
    checkpointsTotal: Number(row.checkpoints_total),
    evaluation: row.evaluation as DrivingSessionSummary["evaluation"],
    traceComplete: Boolean(row.trace_complete),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/** Filters and totals are evaluated on the entire authorized history, not only the current page. */
export async function listDrivingSessionsPage(filters: HistoryPageFilters, size: number, page: number, userId?: number) {
  await ensureDatabase();
  const { where, params } = historyWhere(filters, userId);
  const summary = await pool.query(`
    SELECT COUNT(*)::integer AS total,
      COUNT(*) FILTER (WHERE ds.drive_mode='real')::integer AS real,
      COALESCE(SUM(ds.speeding_events + ds.off_route_events + COALESCE((ds.evaluation->>'wrongDirectionEvents')::integer,0) + COALESCE((ds.evaluation->>'missedCheckpoints')::integer,0)),0)::integer AS issues,
      COALESCE(AVG(CASE WHEN ds.checkpoints_total>0 THEN 100.0 * ds.checkpoints_completed / ds.checkpoints_total ELSE 0 END),0) AS completion
    ${historyJoins} ${where}`, params);
  const totals = summary.rows[0];
  const total = Number(totals.total);
  const pages = Math.max(1, Math.ceil(total / size));
  const actualPage = Math.min(page, pages);
  const result = await pool.query(`
    SELECT ds.*, COALESCE(ds.route_name_snapshot, er.name) AS route_name,
      COALESCE(ds.route_city_snapshot, er.city) AS route_city, u.name AS user_name
    ${historyJoins} ${where}
    ${historyOrder(filters.sort)} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, size, (actualPage - 1) * size]);
  return {
    items: result.rows.map(mapDrivingSessionSummary), page: actualPage, size, total, pages,
    stats: { real: Number(totals.real), issues: Number(totals.issues), completion: Number(totals.completion) },
  };
}

/** Filter menus list all recorded routes/drivers in the authorized scope. */
export async function listDrivingSessionFilterOptions(userId?: number) {
  await ensureDatabase();
  const { where, params } = historyWhere({search:'',mode:'all',days:'all',driverId:null,routeId:null,sort:'newest'}, userId);
  const result = await pool.query(`
    SELECT DISTINCT ds.user_id AS user_id, u.name AS user_name,
      COALESCE(ds.route_id_snapshot, ds.route_id) AS route_key,
      COALESCE(ds.route_name_snapshot, er.name) AS route_name
    ${historyJoins} ${where}`, params);
  const drivers = new Map<string,string>();
  const routes = new Map<string,string>();
  for (const row of result.rows) {
    if (row.user_id != null && row.user_name) drivers.set(String(row.user_id), String(row.user_name));
    if (row.route_key != null && row.route_name) routes.set(String(row.route_key), String(row.route_name));
  }
  return {
    drivers: [...drivers].map(([value,label])=>({value,label})).sort((a,b)=>a.label.localeCompare(b.label,'ka')),
    routes: [...routes].map(([value,label])=>({value,label})).sort((a,b)=>a.label.localeCompare(b.label,'ka')),
  };
}

export async function listDrivingSessions(limit = 50, userId?: number, offset = 0) {
  await ensureDatabase();
  const result = await pool.query(
    `SELECT ds.*,
            COALESCE(ds.route_name_snapshot,er.name) AS route_name,
            COALESCE(ds.route_city_snapshot,er.city) AS route_city,
            u.name AS user_name
     FROM driving_sessions ds
     LEFT JOIN exam_routes er ON er.id=ds.route_id
     LEFT JOIN app_users u ON u.id=ds.user_id
     ${userId == null ? "" : "WHERE ds.user_id=$2"}
     ORDER BY ds.created_at DESC, ds.id DESC
     LIMIT $1 OFFSET ${userId == null ? "$2" : "$3"}`,
    userId == null
      ? [Math.max(1, Math.min(limit, 500)), Math.max(0, Math.floor(offset))]
      : [Math.max(1, Math.min(limit, 500)), userId, Math.max(0, Math.floor(offset))]
  );

  return result.rows.map(mapDrivingSessionSummary);
}

export async function getDrivingSession(id: number) {
  await ensureDatabase();

  const session = await pool.query(
    `SELECT ds.*,
            COALESCE(ds.route_name_snapshot,er.name) AS route_name,
            COALESCE(ds.route_city_snapshot,er.city) AS route_city,
            u.name AS user_name
     FROM driving_sessions ds
     LEFT JOIN exam_routes er ON er.id=ds.route_id
     LEFT JOIN app_users u ON u.id=ds.user_id
     WHERE ds.id=$1`,
    [id]
  );

  if (!session.rowCount) return null;
  const row = session.rows[0];

  const events = await pool.query(
    `SELECT * FROM driving_events WHERE session_id=$1 ORDER BY event_time,id`,
    [id]
  );

  return {
    id: Number(row.id),
    clientSessionId: String(row.client_session_id ?? `legacy-${row.id}`),
    routeId: row.route_id == null ? null : Number(row.route_id),
    userId: row.user_id == null ? null : Number(row.user_id),
    userName: row.user_name == null ? null : String(row.user_name),
    routeName: row.route_name == null ? null : String(row.route_name),
    routeOriginId: row.route_id_snapshot == null ? null : Number(row.route_id_snapshot),
    city: row.route_city == null ? null : String(row.route_city),
    routeVersion:
      row.route_version == null ? null : Number(row.route_version),
    mode: row.drive_mode as DrivingSessionSummary["mode"],
    assistMode: row.assist_mode as DrivingSessionSummary["assistMode"],
    startedAt: new Date(row.started_at).getTime(),
    finishedAt: new Date(row.finished_at).getTime(),
    durationSeconds: Number(row.duration_seconds),
    distanceMeters: Number(row.distance_meters),
    maxSpeedKmh: Number(row.max_speed_kmh),
    speedingEvents: Number(row.speeding_events),
    offRouteEvents: Number(row.off_route_events),
    checkpointsCompleted: Number(row.checkpoints_completed),
    checkpointsTotal: Number(row.checkpoints_total),
    evaluation: row.evaluation as DrivingSessionSummary["evaluation"],
    traceComplete: Boolean(row.trace_complete),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    trace: Array.isArray(row.trace) ? row.trace : [],
    routeSnapshot: row.route_snapshot ?? (row.route_id != null && row.route_version != null ? await getRouteVersionSnapshot(Number(row.route_id), Number(row.route_version)) : null),
    events: events.rows.map((event) => ({
      id: Number(event.id),
      type: event.event_type,
      timestamp: new Date(event.event_time).getTime(),
      lng: event.lng == null ? null : Number(event.lng),
      lat: event.lat == null ? null : Number(event.lat),
      value: event.value == null ? null : Number(event.value),
      limitValue:
        event.limit_value == null ? null : Number(event.limit_value),
      checkpointIndex:
        event.checkpoint_index == null ? null : Number(event.checkpoint_index),
      note: String(event.note ?? ""),
    })),
  };
}

export async function getTtsAudioCache(cacheKey: string) {
  await ensureDatabase();

  const result = await pool.query(
    `SELECT content_type,audio_data
     FROM tts_audio_cache
     WHERE cache_key=$1`,
    [cacheKey]
  );

  if (!result.rowCount) return null;

  return {
    contentType: String(result.rows[0].content_type ?? "audio/mpeg"),
    audio: result.rows[0].audio_data as Buffer,
  };
}

export async function setTtsAudioCache(input: {
  cacheKey: string;
  voice: string;
  text: string;
  contentType: string;
  audio: Buffer;
}) {
  await ensureDatabase();

  await pool.query(
    `INSERT INTO tts_audio_cache
      (cache_key,voice,text_value,content_type,audio_data)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(cache_key) DO UPDATE SET
       content_type=EXCLUDED.content_type,
       audio_data=EXCLUDED.audio_data,
       created_at=NOW()`,
    [
      input.cacheKey,
      input.voice,
      input.text,
      input.contentType,
      input.audio,
    ]
  );
}
