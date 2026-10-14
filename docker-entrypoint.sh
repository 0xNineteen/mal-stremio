#!/bin/sh
set -e

mkdir -p /app/data/user-lists

if [ ! -f /app/data/imdb-cache.json ] && [ -f /app/data-seed/imdb-cache.json ]; then
  cp -n /app/data-seed/*.json /app/data/ 2>/dev/null || true
fi

exec node index.js