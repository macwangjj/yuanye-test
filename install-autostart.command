#!/bin/zsh
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.yuanye.seamless-studio"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/logs"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

PORT="${PORT:-4186}"
YUANYE_HOST="${YUANYE_HOST:-127.0.0.1}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://maimai.it.com/v1}"
OPENAI_IMAGE_MODEL="${OPENAI_IMAGE_MODEL:-gpt-image-2}"
OPENAI_CHAT_MODEL="${OPENAI_CHAT_MODEL:-gpt-5.5}"
OPENAI_IMAGE_TIMEOUT_MS="${OPENAI_IMAGE_TIMEOUT_MS:-300000}"
YUANYE_GENERATE_TIMEOUT_MS="${YUANYE_GENERATE_TIMEOUT_MS:-460000}"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "$PROJECT_DIR" &amp;&amp; export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\$PATH" &amp;&amp; export PORT="$PORT" &amp;&amp; export YUANYE_HOST="$YUANYE_HOST" &amp;&amp; export OPENAI_BASE_URL="$OPENAI_BASE_URL" &amp;&amp; export OPENAI_IMAGE_MODEL="$OPENAI_IMAGE_MODEL" &amp;&amp; export OPENAI_CHAT_MODEL="$OPENAI_CHAT_MODEL" &amp;&amp; export OPENAI_IMAGE_TIMEOUT_MS="$OPENAI_IMAGE_TIMEOUT_MS" &amp;&amp; export YUANYE_GENERATE_TIMEOUT_MS="$YUANYE_GENERATE_TIMEOUT_MS" &amp;&amp; exec node server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/yuanye-service.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/yuanye-service-error.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo ""
echo "YUANYE 后台服务已安装并启动。"
echo "本机访问：http://127.0.0.1:$PORT"
echo "同办公室网络访问：http://你的电脑局域网IP:$PORT"
echo ""
echo "这个窗口可以关闭，服务会在后台保持运行。"
