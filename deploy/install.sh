#!/usr/bin/env bash
# 源码只读，数据保留；分阶段迁移时先启用执行器，再降权入口。
set -euo pipefail
source_directory=/root/feishu-bot
runtime_directory=/opt/feishu-bot
phase="${FEISHU_ISOLATION_PHASE:-isolated}"
case "$phase" in executor|isolated) ;; *) echo '未知迁移阶段' >&2; exit 2 ;; esac
[ -f /etc/feishu-bot.env ] || { echo '请先创建/etc/feishu-bot.env' >&2; exit 1; }
if ! getent passwd feishu-bot >/dev/null; then
  useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin feishu-bot
fi
[ "$(id -u feishu-bot)" -gt 0 ] && [ "$(id -u feishu-bot)" -lt 1000 ] || exit 1
[ "$(id -Gn feishu-bot)" = feishu-bot ] || { echo '服务账户存在额外组，拒绝继续' >&2; exit 1; }
usermod --lock --shell /usr/sbin/nologin feishu-bot
# 独立片段避免其他项目发布时重写四账户清单而漏掉飞书账户。
printf '%s\n' '# 飞书入口账户禁止SSH认证及转发。' 'DenyUsers feishu-bot' > /etc/ssh/sshd_config.d/01-feishu-bot.conf
chmod 644 /etc/ssh/sshd_config.d/01-feishu-bot.conf
/usr/sbin/sshd -t
systemctl reload ssh
install -d -m 700 /var/lib/feishu-executor
install -d -m 755 "$runtime_directory/server" "$runtime_directory/bin"
cp -a "$source_directory/server/." "$runtime_directory/server/"
cp -a "$source_directory/bin/." "$runtime_directory/bin/"
cp "$source_directory/package.json" "$source_directory/package-lock.json" "$runtime_directory/"
PATH=/opt/node/bin:$PATH /opt/node/bin/npm ci --prefix "$runtime_directory" --omit=dev --no-audit --no-fund >/dev/null
install -d -m 700 "$runtime_directory/data"
/opt/node/bin/node "$source_directory/deploy/prepare-executor.js"
install -m 644 "$source_directory/deploy/feishu-executor.service" /etc/systemd/system/feishu-executor.service
if [ "$phase" = isolated ]; then
  for directory in /opt/feishu-bot/data /opt/life-app/data; do
    [ ! -L "$directory" ] || { echo '数据目录不能是符号链接' >&2; exit 1; }
    [ -z "$(find "$directory" -xdev -type f -links +1 -print -quit)" ] || { echo '数据含硬链接，须先核对' >&2; exit 1; }
    find "$directory" -xdev -exec chown -h feishu-bot:feishu-bot {} +
    chmod 700 "$directory"
  done
  touch /var/log/feishu-bot-health.log
  chown feishu-bot:feishu-bot /var/log/feishu-bot-health.log
  chmod 600 /var/log/feishu-bot-health.log
  install -m 644 "$source_directory/deploy/feishu-bot.service" /etc/systemd/system/feishu-bot.service
else
  install -m 644 "$source_directory/deploy/feishu-bot-transition.service" /etc/systemd/system/feishu-bot.service
fi
systemctl daemon-reload
systemctl enable feishu-executor.service feishu-bot.service >/dev/null
# 正在执行的任务留待下次维护，不能在飞书自部署时杀掉执行器自身。
if systemctl is-active --quiet feishu-executor.service; then
  echo '执行器保持运行；若其源码改变，请待当前回合结束后单独重启验证。'
else
  systemctl start feishu-executor.service
fi
systemctl is-active --quiet feishu-executor.service
printf '飞书部署完成：阶段=%s；数据已保留。\n' "$phase"
