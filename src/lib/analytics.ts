import "server-only";

import { pool } from "@/lib/db";
import { ensureDatabase } from "@/lib/migrations";
import { listDrivingSessions } from "@/lib/repository";
import type {
  AdminAnalyticsOverview,
  DriverAnalyticsRow,
  RouteAnalyticsRow,
} from "@/types/domain";

function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getAdminAnalytics(): Promise<AdminAnalyticsOverview> {
  await ensureDatabase();

  const [totalsResult, timelineResult, routeResult, driverResult, recentSessions] =
    await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM app_users) AS users,
          (SELECT COUNT(*)::int FROM app_users WHERE role='driver' AND is_active=TRUE) AS active_drivers,
          (SELECT COUNT(*)::int FROM exam_routes) AS routes,
          (SELECT COUNT(*)::int FROM exam_routes WHERE is_published=TRUE) AS published_routes,
          COUNT(*)::int AS sessions,
          COUNT(*) FILTER (WHERE drive_mode='real')::int AS real_sessions,
          COUNT(*) FILTER (WHERE drive_mode='simulation')::int AS simulation_sessions,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS sessions_last_7_days,
          COALESCE(AVG(
            CASE WHEN checkpoints_total > 0
              THEN LEAST(100.0, checkpoints_completed::numeric * 100.0 / checkpoints_total)
              ELSE 0
            END
          ),0)::float8 AS average_completion,
          COALESCE(SUM(speeding_events),0)::int AS speeding_events,
          COALESCE(SUM(off_route_events),0)::int AS off_route_events
        FROM driving_sessions
      `),
      pool.query(`
        WITH days AS (
          SELECT generate_series(
            CURRENT_DATE - INTERVAL '13 days',
            CURRENT_DATE,
            INTERVAL '1 day'
          )::date AS day
        )
        SELECT
          d.day::text AS date,
          COUNT(ds.id)::int AS sessions,
          COUNT(ds.id) FILTER (WHERE ds.drive_mode='real')::int AS real_sessions,
          COUNT(ds.id) FILTER (WHERE ds.drive_mode='simulation')::int AS simulation_sessions
        FROM days d
        LEFT JOIN driving_sessions ds
          ON ds.created_at >= d.day
         AND ds.created_at < d.day + INTERVAL '1 day'
        GROUP BY d.day
        ORDER BY d.day
      `),
      pool.query(`
        SELECT
          ds.route_id,
          COALESCE(ds.route_name_snapshot, er.name, 'წაშლილი მარშრუტი') AS route_name,
          COUNT(*)::int AS sessions,
          COALESCE(AVG(
            CASE WHEN ds.checkpoints_total > 0
              THEN LEAST(100.0, ds.checkpoints_completed::numeric * 100.0 / ds.checkpoints_total)
              ELSE 0
            END
          ),0)::float8 AS average_completion,
          COALESCE(SUM(ds.speeding_events),0)::int AS speeding_events,
          COALESCE(SUM(ds.off_route_events),0)::int AS off_route_events,
          MAX(ds.created_at) AS last_session_at
        FROM driving_sessions ds
        LEFT JOIN exam_routes er ON er.id=ds.route_id
        GROUP BY ds.route_id, COALESCE(ds.route_name_snapshot, er.name, 'წაშლილი მარშრუტი')
        ORDER BY COUNT(*) DESC, MAX(ds.created_at) DESC
        LIMIT 8
      `),
      pool.query(`
        SELECT
          ds.user_id,
          COALESCE(u.name,'წაშლილი მომხმარებელი') AS user_name,
          COUNT(*)::int AS sessions,
          COUNT(*) FILTER (WHERE ds.drive_mode='real')::int AS real_sessions,
          COALESCE(AVG(
            CASE WHEN ds.checkpoints_total > 0
              THEN LEAST(100.0, ds.checkpoints_completed::numeric * 100.0 / ds.checkpoints_total)
              ELSE 0
            END
          ),0)::float8 AS average_completion,
          COALESCE(SUM(ds.speeding_events),0)::int AS speeding_events,
          COALESCE(SUM(ds.off_route_events),0)::int AS off_route_events,
          MAX(ds.created_at) AS last_session_at
        FROM driving_sessions ds
        LEFT JOIN app_users u ON u.id=ds.user_id
        WHERE ds.user_id IS NOT NULL
        GROUP BY ds.user_id,u.name
        ORDER BY MAX(ds.created_at) DESC, COUNT(*) DESC
        LIMIT 8
      `),
      listDrivingSessions(8),
    ]);

  const totals = totalsResult.rows[0] ?? {};

  return {
    totals: {
      users: number(totals.users),
      activeDrivers: number(totals.active_drivers),
      routes: number(totals.routes),
      publishedRoutes: number(totals.published_routes),
      sessions: number(totals.sessions),
      realSessions: number(totals.real_sessions),
      simulationSessions: number(totals.simulation_sessions),
      sessionsLast7Days: number(totals.sessions_last_7_days),
      averageCompletion: number(totals.average_completion),
      speedingEvents: number(totals.speeding_events),
      offRouteEvents: number(totals.off_route_events),
    },
    timeline: timelineResult.rows.map((row) => ({
      date: String(row.date),
      sessions: number(row.sessions),
      realSessions: number(row.real_sessions),
      simulationSessions: number(row.simulation_sessions),
    })),
    routes: routeResult.rows.map(
      (row): RouteAnalyticsRow => ({
        routeId: row.route_id == null ? null : Number(row.route_id),
        routeName: String(row.route_name),
        sessions: number(row.sessions),
        averageCompletion: number(row.average_completion),
        speedingEvents: number(row.speeding_events),
        offRouteEvents: number(row.off_route_events),
        lastSessionAt:
          row.last_session_at == null
            ? null
            : row.last_session_at instanceof Date
              ? row.last_session_at.toISOString()
              : String(row.last_session_at),
      })
    ),
    drivers: driverResult.rows.map(
      (row): DriverAnalyticsRow => ({
        userId: Number(row.user_id),
        userName: String(row.user_name),
        sessions: number(row.sessions),
        realSessions: number(row.real_sessions),
        averageCompletion: number(row.average_completion),
        speedingEvents: number(row.speeding_events),
        offRouteEvents: number(row.off_route_events),
        lastSessionAt:
          row.last_session_at == null
            ? null
            : row.last_session_at instanceof Date
              ? row.last_session_at.toISOString()
              : String(row.last_session_at),
      })
    ),
    recentSessions,
  };
}
