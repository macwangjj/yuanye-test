#!/bin/zsh
cd "$(dirname "$0")"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
mkdir -p logs
LOG_FILE="logs/start-latest.log"

{
  echo "====== YUANYE START $(date '+%Y-%m-%d %H:%M:%S') ======"
  echo "项目目录: $(pwd)"
  echo "PATH: $PATH"
} > "$LOG_FILE"

log() {
  echo "$1" | tee -a "$LOG_FILE"
}

if [ -f ".env" ]; then
  set -a
  source ".env"
  set +a
fi

log "YUANYE 元也 · 新版测试网站"
log "项目目录: $(pwd)"

if [ -z "$OPENAI_API_KEY" ] || [[ "$OPENAI_API_KEY" == *"这里粘贴"* ]] || [[ "$OPENAI_API_KEY" == *"你的"* ]] || [[ "$OPENAI_API_KEY" == *"dummy"* ]]; then
  log ""
  log "还没有配置有效的接口 Key。"
  log "请把书标标 / OpenAI 兼容接口 Key 粘贴到下面，然后按回车："
  log ""
  read "?API Key: " OPENAI_API_KEY
  OPENAI_API_KEY="$(echo "$OPENAI_API_KEY" | tr -d '[:space:]')"

  if [ -z "$OPENAI_API_KEY" ] || [[ "$OPENAI_API_KEY" == *"这里粘贴"* ]] || [[ "$OPENAI_API_KEY" == *"你的"* ]] || [[ "$OPENAI_API_KEY" == *"dummy"* ]]; then
    log ""
    log "没有收到有效 Key，已停止启动。"
    read -k 1 "?按任意键关闭..."
    exit 1
  fi

  cat > ".env" <<EOF
OPENAI_API_KEY="$OPENAI_API_KEY"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://maimai.it.com/v1}"
OPENAI_IMAGE_MODEL="${OPENAI_IMAGE_MODEL:-gpt-image-2}"
OPENAI_CHAT_MODEL="${OPENAI_CHAT_MODEL:-gpt-5.5}"
PORT="${PORT:-4185}"
EOF

  log ""
  log ".env 已保存。"
fi

PORT="${PORT:-4185}"
HEALTH_URL="http://127.0.0.1:$PORT/api/health"
APP_URL="http://127.0.0.1:$PORT"

if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
  log ""
  log "YUANYE 已经在运行。"
  log "打开地址: $APP_URL"
  open "$APP_URL" >/dev/null 2>&1 || true
  read -k 1 "?按任意键关闭..."
  exit 0
fi

PORT_PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PORT_PIDS" ]; then
  log ""
  log "端口 $PORT 被旧进程占用，正在检查是否可以清理。"
  for PID in ${(f)PORT_PIDS}; do
    CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"
    log "占用进程 $PID: $CMD"
    if [[ "$CMD" == *"node"* ]] || [[ "$CMD" == *"server.js"* ]] || [[ "$CMD" == *"seamless-pattern-2-3"* ]]; then
      log "关闭旧的 YUANYE/Node 进程 $PID。"
      kill "$PID" >/dev/null 2>&1 || true
      sleep 1
    else
      log "端口 $PORT 被其他程序占用，未自动关闭。请截图这个窗口发给我。"
      read -k 1 "?按任意键关闭..."
      exit 1
    fi
  done

  if lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    log "端口 $PORT 仍被占用，请截图这个窗口发给我。"
    read -k 1 "?按任意键关闭..."
    exit 1
  fi
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  log ""
  log "没有找到 Node.js。请先安装 Node.js，或把终端截图发给我。"
  read -k 1 "?按任意键关闭..."
  exit 1
fi

export OPENAI_API_KEY
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://maimai.it.com/v1}"
export OPENAI_IMAGE_MODEL="${OPENAI_IMAGE_MODEL:-gpt-image-2}"
export OPENAI_CHAT_MODEL="${OPENAI_CHAT_MODEL:-gpt-5.5}"
export OPENAI_IMAGE_TIMEOUT_MS="${OPENAI_IMAGE_TIMEOUT_MS:-300000}"
export YUANYE_GENERATE_TIMEOUT_MS="${YUANYE_GENERATE_TIMEOUT_MS:-460000}"
export PORT
if [ "$YUANYE_LAN" = "1" ]; then
  export YUANYE_HOST="0.0.0.0"
else
  export YUANYE_HOST="127.0.0.1"
fi

log ""
log "Node: $NODE_BIN"
log "Node 版本: $($NODE_BIN -v 2>&1)"
log "端口: $PORT"
log "监听: $YUANYE_HOST"
log "启动中..."
log "打开地址: $APP_URL"
log "如果只在这台电脑使用，请保持这个窗口不要关闭。"
log ""
"$NODE_BIN" server.js 2>&1 | tee -a "$LOG_FILE"

log ""
log "YUANYE 服务已停止。"
log "如果这里有报错，请把这个窗口截图发给我。"
log "日志位置: $(pwd)/$LOG_FILE"
read -k 1 "?按任意键关闭..."
