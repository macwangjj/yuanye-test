#!/bin/zsh
cd "$(dirname "$0")"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export YUANYE_HOST="${YUANYE_HOST:-0.0.0.0}"

exec node server.js
