#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 1 ]] || { echo "Usage: bash scripts/restore-db.sh /absolute/path/backup.dump" >&2; exit 1; }
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BINARY="${NODE_BINARY:-node}"
FILE="$(realpath "$1")"
[[ -s "$FILE" ]] || { echo "Backup is missing or empty." >&2; exit 1; }
"$NODE_BINARY" "$ROOT_DIR/scripts/db-command.cjs" pg_restore --list "$FILE" >/dev/null
if [[ -f "$FILE.sha256" ]]; then
  (
    cd "$(dirname "$FILE")"
    sha256sum --check "$(basename "$FILE").sha256"
  )
fi
echo "Creating a rollback backup of the configured database..."
bash "$ROOT_DIR/scripts/backup-db.sh"
echo "Restoring the configured database in one transaction..."
"$NODE_BINARY" "$ROOT_DIR/scripts/db-command.cjs" pg_restore --clean --if-exists --no-owner --no-acl --single-transaction --exit-on-error "$FILE"
echo "Restore completed. Restart the app and check /api/health."
