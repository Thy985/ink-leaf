#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"
npm run sync:android
