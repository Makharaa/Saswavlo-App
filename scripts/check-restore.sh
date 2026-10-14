#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 ]] || { echo "Usage: RESTORE_TEST_DATABASE_URL=... bash scripts/check-restore.sh /absolute/path/backup.dump" >&2; exit 1; }
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BINARY="${NODE_BINARY:-node}"
FILE="$(realpath "$1")"
[[ -s "$FILE" ]] || { echo "Backup is missing or empty." >&2; exit 1; }
"$NODE_BINARY" "$ROOT_DIR/scripts/db-command.cjs" assert-test
"$NODE_BINARY" "$ROOT_DIR/scripts/db-command.cjs" pg_restore --list "$FILE" >/dev/null
"$NODE_BINARY" "$ROOT_DIR/scripts/db-command.cjs" --test pg_restore --clean --if-exists --no-owner --no-acl --single-transaction --exit-on-error "$FILE"
"$NODE_BINARY" "$ROOT_DIR/scripts/db-command.cjs" --test psql --set=ON_ERROR_STOP=1 --command="DO \$\$ BEGIN IF to_regclass('public.exam_routes') IS NULL OR to_regclass('public.driving_sessions') IS NULL OR to_regclass('public.route_versions') IS NULL THEN RAISE EXCEPTION 'DriveExam tables missing'; END IF; END \$\$; SELECT MAX(id) AS restored_schema_version FROM schema_migrations;"
echo "Backup restored successfully into the isolated test database."
