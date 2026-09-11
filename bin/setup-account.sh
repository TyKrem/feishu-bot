#!/usr/bin/env bash
# 首次接入：把飞书 open_id 写进白名单与默认收件人，并重启 feishu-bot
#
# 用法：
#   setup-account.sh ou_xxxxxxxx                 # 只设白名单
#   setup-account.sh ou_xxxxxxxx 10001      # 同时沿用旧 QQ 的生活数据
set -euo pipefail

OPEN_ID="${1:-}"
LEGACY_KEY="${2:-}"
ENV_FILE=/etc/feishu-bot.env

if [ -z "$OPEN_ID" ]; then
  echo "用法：$0 ou_xxxxxxxx [旧QQ号]"
  exit 2
fi
case "$OPEN_ID" in
  ou_*) ;;
  *) echo "open_id 应以 ou_ 开头，当前值：$OPEN_ID" >&2; exit 2 ;;
esac
if [ ! -f "$ENV_FILE" ]; then
  echo "缺少 $ENV_FILE，请先执行：bash /root/feishu-bot/deploy/install.sh" >&2
  exit 1
fi

BACKUP="${ENV_FILE}.bak.$(date +%s)"
cp -a "$ENV_FILE" "$BACKUP"
echo "已备份原配置：$BACKUP"

set_line() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

set_line FEISHU_ALLOW_USERS "$OPEN_ID"
set_line FEISHU_NOTIFY_USER "$OPEN_ID"
if [ -n "$LEGACY_KEY" ]; then
  set_line FEISHU_LIFE_KEY_MAP "${OPEN_ID}=${LEGACY_KEY}"
  echo "生活数据键映射：${OPEN_ID} → ${LEGACY_KEY}（沿用原有记账/待办）"
fi

echo "已写入 $ENV_FILE："
grep -E '^FEISHU_(ALLOW_USERS|NOTIFY_USER|LIFE_KEY_MAP)=' "$ENV_FILE"

echo
echo "重启服务…"
systemctl restart feishu-bot
sleep 2
systemctl is-active feishu-bot || {
  echo
  echo "服务未处于 active，查看日志：journalctl -u feishu-bot -n 30 --no-pager"
  exit 1
}
echo "feishu-bot 已启动。"
