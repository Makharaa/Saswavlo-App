#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEDULE="${1:-0 3 * * *}"
[[ "$SCHEDULE" =~ ^[0-9\*\,\/\ -]+$ ]] || { echo "Use a numeric five-field cron schedule." >&2; exit 1; }
read -r -a FIELDS <<< "$SCHEDULE"
[[ ${#FIELDS[@]} -eq 5 ]] || { echo "Use a five-field cron schedule." >&2; exit 1; }
command -v crontab >/dev/null || { echo "Install cron before configuring daily backups." >&2; exit 1; }
NODE_BINARY="$(command -v node)"
mkdir -p "$ROOT_DIR/logs"
TEMP_FILE="$(mktemp)"
trap 'rm -f "$TEMP_FILE"' EXIT
crontab -l 2>/dev/null | awk '/# BEGIN DriveExam backup/{skip=1} !skip{print} /# END DriveExam backup/{skip=0}' > "$TEMP_FILE" || true
printf -v NODE_ESCAPED '%q' "$NODE_BINARY"
printf -v SCRIPT_ESCAPED '%q' "$ROOT_DIR/scripts/backup-db.sh"
printf -v LOG_ESCAPED '%q' "$ROOT_DIR/logs/backup.log"
NODE_ESCAPED="${NODE_ESCAPED//%/\\%}"
SCRIPT_ESCAPED="${SCRIPT_ESCAPED//%/\\%}"
LOG_ESCAPED="${LOG_ESCAPED//%/\\%}"
{
  echo '# BEGIN DriveExam backup'
  echo "$SCHEDULE NODE_BINARY=$NODE_ESCAPED /bin/bash $SCRIPT_ESCAPED >> $LOG_ESCAPED 2>&1"
  echo '# END DriveExam backup'
} >> "$TEMP_FILE"
crontab "$TEMP_FILE"
echo "Daily backups installed for the current account. Schedule: $SCHEDULE (server local time)."
