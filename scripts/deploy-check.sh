#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[DriveExam] project: $ROOT_DIR"
echo "[1/6] Installing locked dependencies..."
npm ci

echo "[2/6] Regression tests..."
npm run test:core

echo "[3/6] Type check..."
npm run typecheck

echo "[4/6] Production build..."
npm run build

echo "[5/6] Map worker HTTP check..."
npm run test:map-worker

echo "[6/6] Build artifact..."
test -f .next/BUILD_ID
cat .next/BUILD_ID

echo
echo "Build is ready. Restart the website from FastPanel, then run:"
echo "curl http://127.0.0.1:3081/api/health"
