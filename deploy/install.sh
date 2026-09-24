#!/usr/bin/env bash
# 部署 / 更新 feishu-bot：同步源码 → 安装依赖 → 写入环境文件 → 安装 systemd 单元
set -euo pipefail

SRC_DIR=/root/feishu-bot
DEST_DIR=/opt/feishu-bot
ENV_FILE=/etc/feishu-bot.env
UNIT_FILE=/etc/systemd/system/feishu-bot.service

NODE_BIN=/opt/node/bin/node
if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$(command -v node)"; fi
NPM_BIN="$(command -v npm || true)"
if [ -z "$NPM_BIN" ] && [ -x /opt/node/bin/npm ]; then
  NPM_BIN=/opt/node/bin/npm
fi
if [ -z "$NPM_BIN" ]; then echo "找不到 npm，无法安装依赖" >&2; exit 1; fi

echo "==> 同步源码到 $DEST_DIR"
mkdir -p "$DEST_DIR/server" "$DEST_DIR/data"
cp -a "$SRC_DIR/server/." "$DEST_DIR/server/"
# bin/ 里是 setup-account.sh 这类运维工具，原先漏了同步，导致 /opt 里留着旧副本
mkdir -p "$DEST_DIR/bin"
cp -a "$SRC_DIR/bin/." "$DEST_DIR/bin/"
cp -a "$SRC_DIR/package.json" "$DEST_DIR/package.json"
chmod 700 "$DEST_DIR/data"

echo "==> 安装依赖（$NPM_BIN）"
( cd "$DEST_DIR" && "$NPM_BIN" install --omit=dev --no-audit --no-fund )

echo "==> 准备环境文件 $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  cp "$SRC_DIR/deploy/feishu-bot.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "注意：FEISHU_NOTIFY_TOKEN 供定时任务调用内部通知接口，FEISHU_LOG_TOKEN 供日志中心写入。" >&2
  echo "      两者留空会导致定时推送失败 / 日志不上报，请填写后再启动服务。" >&2
else
  echo "    已存在，保持不变（不会覆盖你填写的凭据）"
fi

echo "==> 安装 systemd 单元"
cp "$SRC_DIR/deploy/feishu-bot.service" "$UNIT_FILE"
systemctl daemon-reload
systemctl enable feishu-bot.service >/dev/null 2>&1 || true

echo
echo "==> 配置检查"
set +e
env -i $(grep -v '^#' "$ENV_FILE" | grep -v '^$' | xargs) \
  "$NODE_BIN" "$DEST_DIR/server/server.js" --check
check_rc=$?
set -e

echo
if [ $check_rc -eq 0 ]; then
  echo "配置完整，执行：systemctl restart feishu-bot"
else
  echo "配置尚未完成，请编辑 $ENV_FILE 后执行：systemctl restart feishu-bot"
fi
