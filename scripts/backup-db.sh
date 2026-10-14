#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${DRIVEEXAM_BACKUP_DIR:-$ROOT_DIR/backups}"
NODE_BINARY="${NODE_BINARY:-node}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +'%Y%m%d-%H%M%S')"
TEMP_FILE="$(mktemp "$BACKUP_DIR/.driveexam-${STAMP}.XXXXXX")"
trap 'rm -f "$TEMP_FILE"' EXIT
"$NODE_BINARY" "$ROOT_DIR/scripts/db-command.cjs" pg_dump --format=custom --no-owner --no-acl > "$TEMP_FILE"
test -s "$TEMP_FILE"
"$NODE_BINARY" "$ROOT_DIR/scripts/db-command.cjs" pg_restore --list "$TEMP_FILE" >/dev/null
TARGET="$BACKUP_DIR/driveexam-${STAMP}-$$.dump"
mv "$TEMP_FILE" "$TARGET"
(
  cd "$BACKUP_DIR"
  sha256sum "$(basename "$TARGET")" > "$(basename "$TARGET").sha256"
)
echo "Backup verified: $TARGET"
