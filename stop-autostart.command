#!/bin/zsh
set -e

LABEL="com.yuanye.seamless-studio"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true

echo ""
echo "YUANYE 后台服务已停止。"
echo "如需重新常驻运行，请再次双击 install-autostart.command。"
