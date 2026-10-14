export const schemaMigrations = [
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS exam_routes (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(180) NOT NULL,
        city VARCHAR(120) NOT NULL DEFAULT 'გორი',
        description TEXT NOT NULL DEFAULT '',
        is_published BOOLEAN NOT NULL DEFAULT FALSE,
        coordinates JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE exam_routes ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

      CREATE TABLE IF NOT EXISTS route_checkpoints (
        id BIGSERIAL PRIMARY KEY,
        route_id BIGINT NOT NULL REFERENCES exam_routes(id) ON DELETE CASCADE,
        order_index INTEGER NOT NULL DEFAULT 0,
        lng DOUBLE PRECISION NOT NULL,
        lat DOUBLE PRECISION NOT NULL,
        checkpoint_type VARCHAR(32) NOT NULL DEFAULT 'straight',
        title TEXT NOT NULL DEFAULT '',
        voice TEXT NOT NULL DEFAULT '',
        speed_limit INTEGER NULL,
        trigger_meters INTEGER NOT NULL DEFAULT 120,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS route_checkpoints_route_idx
        ON route_checkpoints(route_id, order_index);

      DO $$
      BEGIN
        IF to_regclass('public.route_points') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM route_checkpoints) THEN
          INSERT INTO route_checkpoints
            (route_id, order_index, lng, lat, checkpoint_type, title, voice, speed_limit, trigger_meters)
          SELECT route_id, order_index, lng, lat, point_type, title, voice, speed_limit, trigger_meters
          FROM route_points
          ORDER BY route_id, order_index, id;
        END IF;
      END $$;
    `
  },
  {
    id: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS driving_sessions (
        id BIGSERIAL PRIMARY KEY,
        route_id BIGINT NULL REFERENCES exam_routes(id) ON DELETE SET NULL,
        drive_mode VARCHAR(20) NOT NULL,
        assist_mode VARCHAR(20) NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        distance_meters DOUBLE PRECISION NOT NULL DEFAULT 0,
        max_speed_kmh DOUBLE PRECISION NOT NULL DEFAULT 0,
        speeding_events INTEGER NOT NULL DEFAULT 0,
        off_route_events INTEGER NOT NULL DEFAULT 0,
        checkpoints_completed INTEGER NOT NULL DEFAULT 0,
        checkpoints_total INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS driving_events (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES driving_sessions(id) ON DELETE CASCADE,
        event_type VARCHAR(40) NOT NULL,
        event_time TIMESTAMPTZ NOT NULL,
        lng DOUBLE PRECISION NULL,
        lat DOUBLE PRECISION NULL,
        value DOUBLE PRECISION NULL,
        limit_value DOUBLE PRECISION NULL,
        checkpoint_index INTEGER NULL,
        note TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS driving_sessions_route_idx
        ON driving_sessions(route_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS driving_events_session_idx
        ON driving_events(session_id, event_time);
    `
  },
  {
    id: 3,
    sql: `
      ALTER TABLE route_checkpoints
        ADD COLUMN IF NOT EXISTS tts_voice VARCHAR(80) NOT NULL DEFAULT 'ka-GE-EkaNeural';

      CREATE TABLE IF NOT EXISTS tts_audio_cache (
        cache_key CHAR(64) PRIMARY KEY,
        voice VARCHAR(80) NOT NULL,
        text_value TEXT NOT NULL,
        content_type VARCHAR(80) NOT NULL DEFAULT 'audio/mpeg',
        audio_data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS tts_audio_cache_created_idx
        ON tts_audio_cache(created_at DESC);
    `
  },
  {
    id: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS app_users (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        email VARCHAR(220) NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'driver',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT app_users_role_check CHECK (role IN ('admin','driver'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_uq
        ON app_users(LOWER(email));

      ALTER TABLE driving_sessions
        ADD COLUMN IF NOT EXISTS user_id BIGINT NULL
        REFERENCES app_users(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS driving_sessions_user_idx
        ON driving_sessions(user_id, created_at DESC);
    `
  },
  {
    id: 5,
    sql: `
      ALTER TABLE exam_routes ADD COLUMN IF NOT EXISTS waypoints JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE exam_routes ADD COLUMN IF NOT EXISTS speed_zones JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE exam_routes ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
      UPDATE exam_routes SET waypoints=coordinates WHERE jsonb_array_length(waypoints)=0 AND jsonb_array_length(coordinates)>0;
      CREATE TABLE IF NOT EXISTS route_versions (
        id BIGSERIAL PRIMARY KEY,
        route_id BIGINT NOT NULL REFERENCES exam_routes(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        snapshot JSONB NOT NULL,
        edited_by BIGINT NULL REFERENCES app_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(route_id,version)
      );
      CREATE INDEX IF NOT EXISTS route_versions_route_idx ON route_versions(route_id,version DESC);
    `
  },
  {
    id: 6,
    sql: `
      ALTER TABLE driving_sessions ADD COLUMN IF NOT EXISTS route_version INTEGER NULL;
      ALTER TABLE driving_sessions ADD COLUMN IF NOT EXISTS route_name_snapshot VARCHAR(180) NULL;
      ALTER TABLE driving_sessions ADD COLUMN IF NOT EXISTS route_city_snapshot VARCHAR(120) NULL;

      UPDATE driving_sessions ds
      SET route_version = COALESCE(ds.route_version, er.version),
          route_name_snapshot = COALESCE(ds.route_name_snapshot, er.name),
          route_city_snapshot = COALESCE(ds.route_city_snapshot, er.city)
      FROM exam_routes er
      WHERE ds.route_id = er.id
        AND (
          ds.route_version IS NULL OR
          ds.route_name_snapshot IS NULL OR
          ds.route_city_snapshot IS NULL
        );

      CREATE INDEX IF NOT EXISTS driving_sessions_created_idx
        ON driving_sessions(created_at DESC);
    `
  },
  {
    id: 7,
    sql: `
      ALTER TABLE driving_sessions
        ADD COLUMN IF NOT EXISTS client_session_id VARCHAR(100) NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS driving_sessions_client_session_uq
        ON driving_sessions(user_id, client_session_id);

      CREATE TABLE IF NOT EXISTS login_attempts (
        identifier CHAR(64) PRIMARY KEY,
        fail_count INTEGER NOT NULL DEFAULT 0,
        window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        blocked_until TIMESTAMPTZ NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS login_attempts_updated_idx
        ON login_attempts(updated_at);
    `
  },
  {
    id: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,
        actor_user_id BIGINT NULL REFERENCES app_users(id) ON DELETE SET NULL,
        action VARCHAR(80) NOT NULL,
        entity_type VARCHAR(40) NOT NULL,
        entity_id VARCHAR(120) NULL,
        summary TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS audit_logs_created_idx
        ON audit_logs(created_at DESC);

      CREATE INDEX IF NOT EXISTS audit_logs_actor_idx
        ON audit_logs(actor_user_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS audit_logs_entity_idx
        ON audit_logs(entity_type, entity_id, created_at DESC);
    `
  },
  {
    id: 9,
    sql: `
      ALTER TABLE route_checkpoints
        ADD COLUMN IF NOT EXISTS route_coordinate_index INTEGER NULL;

      CREATE INDEX IF NOT EXISTS route_checkpoints_route_coordinate_idx
        ON route_checkpoints(route_id, route_coordinate_index);
    `
  },
  {
    id: 10,
    sql: `
      ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS can_use_routes BOOLEAN NOT NULL DEFAULT TRUE;

      ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS active_session_id VARCHAR(96) NULL;

      ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS active_session_ip_hash CHAR(64) NULL;

      ALTER TABLE app_users
        ADD COLUMN IF NOT EXISTS active_session_started_at TIMESTAMPTZ NULL;

      CREATE INDEX IF NOT EXISTS app_users_active_session_idx
        ON app_users(active_session_id);
    `
  },
  {
    id: 11,
    sql: `
      ALTER TABLE app_users
        ALTER COLUMN active_session_ip_hash TYPE VARCHAR(64)
        USING NULLIF(BTRIM(active_session_ip_hash), '');
    `
  },
  {
    id: 12,
    sql: `
      ALTER TABLE exam_routes
        ADD COLUMN IF NOT EXISTS waypoint_coordinate_indices JSONB NOT NULL DEFAULT '[]'::jsonb;
    `
  },
  {
    id: 13,
    sql: `
      ALTER TABLE route_checkpoints ADD COLUMN IF NOT EXISTS evaluation_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE exam_routes ADD COLUMN IF NOT EXISTS field_tested_at TIMESTAMPTZ NULL;
      ALTER TABLE driving_sessions ADD COLUMN IF NOT EXISTS trace JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE driving_sessions ADD COLUMN IF NOT EXISTS evaluation JSONB NULL;
      ALTER TABLE driving_sessions ADD COLUMN IF NOT EXISTS trace_complete BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE driving_sessions ADD COLUMN IF NOT EXISTS route_snapshot JSONB NULL;
      ALTER TABLE driving_sessions ADD COLUMN IF NOT EXISTS route_id_snapshot BIGINT NULL;
      UPDATE driving_sessions SET route_id_snapshot=route_id WHERE route_id_snapshot IS NULL;
    `
  },
  {
    id: 14,
    sql: `
      CREATE TABLE IF NOT EXISTS api_access_windows (
        key CHAR(64) PRIMARY KEY,
        hits INTEGER NOT NULL DEFAULT 0,
        window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS api_access_windows_updated_idx ON api_access_windows(updated_at);
    `,
  },
  {
    id: 15,
    sql: `
      ALTER TABLE app_users ADD COLUMN IF NOT EXISTS pin_hash TEXT NULL;
      CREATE TABLE IF NOT EXISTS trusted_login_devices (
        user_id BIGINT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
        token_hash CHAR(64) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pin_login_attempts (
        user_id BIGINT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
        failures INTEGER NOT NULL DEFAULT 0,
        window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        blocked_until TIMESTAMPTZ NULL
      );
    `,
  },
];

export const DB_SCHEMA_VERSION = schemaMigrations.at(-1)!.id;
