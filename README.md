# feishu-bot（飞书 Codex 机器人）

架构：飞书自建应用（**长连接 / WebSocket 接收事件**）→ 本服务 → Codex CLI
（可执行命令 / 读写服务器）→ 飞书回复。

替换了原来的 `qq-bot + NapCat`：不需要协议端容器、不需要公网回调地址，
飞书侧用官方 SDK 的长连接模式收事件，出站走飞书 OpenAPI。

## 当前状态

- `/root/feishu-bot`：源码
- `/opt/feishu-bot`：运行目录（`server/` + `node_modules/` + `data/`）
- `/etc/feishu-bot.env`：配置
- `systemd` 服务名：`feishu-bot`
- 依赖：`@larksuiteoapi/node-sdk`（长连接 + OpenAPI）
- 内部通知接口：`127.0.0.1:8796`，`POST /internal/notify`，请求头 `X-Notify-Token`
  （沿用原 qq-bot 的端口与令牌，scheduler-app 等无需改动即可切换）

## 消息路由

| 输入 | 行为 |
| --- | --- |
| `.codex 内容` / `.c 内容` | 调用 Codex（有工具、可操作服务器） |
| `.help` | 帮助 |
| `.rand 3d10` / `.r 3d10` | 投骰子 |
| `.tarot` / `.t` | 抽塔罗 |
| `.fortune` / `.f` / 今日运势 | 今日运势（按日缓存） |
| 记账 / 待办类中文指令 | 直接处理，不启动 Codex |
| 其他文字 | 回复帮助（群聊需 @机器人） |

指令开头的 `.` 都可以写成 `。`。

## 首次接入（需要你在飞书开放平台操作）

1. 打开 https://open.feishu.cn/app ，创建「企业自建应用」。
2. 「凭证与基础信息」里拿到 **App ID / App Secret**，填入 `/etc/feishu-bot.env`。
3. 「添加应用能力」→ 启用 **机器人**。
4. 「权限管理」开通：
   - `im:message`（读取与发送消息）
   - `im:message:send_as_bot`（以应用身份发消息）
   - `im:chat:readonly`（可选，读群信息）
5. 「事件与回调」→ 订阅方式选 **使用长连接接收事件**（无需填回调地址），
   添加事件 **接收消息 `im.message.receive_v1`**。
6. 「版本管理与发布」创建版本并发布，等管理员审核通过。
7. 编辑 `/etc/feishu-bot.env`：
   ```ini
   FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
   FEISHU_APP_SECRET=xxxxxxxx
   FEISHU_ALLOW_USERS=            # 先留空
   FEISHU_NOTIFY_USER=            # 先留空
   ```
   然后 `systemctl restart feishu-bot`。
8. 在飞书里给机器人发一句话。因为白名单为空，它只会回复你的 `open_id`：
   ```
   你的 open_id：ou_xxxxxxxxxxxxxxxx
   ```
9. 用脚本写入白名单与默认收件人（一步到位）：
   ```bash
   /opt/feishu-bot/bin/setup-account.sh ou_xxxxxxxxxxxxxxxx                 # 不沿用旧数据
   /opt/feishu-bot/bin/setup-account.sh ou_xxxxxxxxxxxxxxxx 10001           # 沿用原 QQ 的记账/待办
   ```
   等价于手动编辑 `/etc/feishu-bot.env`：
   ```ini
   FEISHU_ALLOW_USERS=ou_xxxxxxxxxxxxxxxx
   FEISHU_NOTIFY_USER=ou_xxxxxxxxxxxxxxxx
   FEISHU_LIFE_KEY_MAP=ou_xxxxxxxxxxxxxxxx=10001        # 想沿用旧记账/待办数据时填
   ```

```bash
systemctl restart feishu-bot
systemctl status feishu-bot
journalctl -u feishu-bot -f
```

只想检查配置是否齐全、不启动服务：

```bash
/opt/node/bin/node /opt/feishu-bot/server/server.js --check
```

## 配置说明（`/etc/feishu-bot.env`）

| 变量 | 说明 |
| --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 自建应用凭据，必填 |
| `FEISHU_DOMAIN` | `feishu`（国内版，默认）或 `lark`（国际版） |
| `FEISHU_ALLOW_USERS` | 允许私聊的身份，逗号分隔，填 open_id / user_id / union_id |
| `FEISHU_ALLOW_CHATS` | 允许的群 chat_id，群聊需 @机器人 |
| `FEISHU_RESTRICTED_USERS` | 受限账号：只允许纯聊天 + 生活指令，不能执行系统命令 |
| `FEISHU_NOTIFY_USER` | 默认收件人 open_id（启动通知、定时推送） |
| `FEISHU_NOTIFY_TOKEN` | 内部通知接口令牌，默认沿用原 qq-bot 的值 |
| `FEISHU_BOT_OPEN_ID` / `FEISHU_BOT_NAME` | 群聊里判断“是否 @ 了机器人”，填了更准 |
| `FEISHU_LIFE_KEY_MAP` | `open_id=旧QQ号`，把生活数据主键映射回旧值，免迁移 |
| `FEISHU_REPLY_DELAY_MIN/MAX` | 被动回复的随机延迟（秒），默认 0.8~2.5 |
| `FEISHU_CODEX_HOME` | Codex 运行目录，默认 `/root/.codex-feishu`（与网页版互不干扰） |
| `FEISHU_TURN_TIMEOUT` | 单轮 Codex 超时（秒） |
| `FEISHU_LOG_URL` / `FEISHU_LOG_TOKEN` | 日志中心上报，来源名 `feishu-bot` |
| `FEISHU_HEALTH_LOG` | 健康时间线，默认 `/var/log/feishu-bot-health.log` |

## 内部通知接口（供定时任务使用）

```bash
curl -X POST http://127.0.0.1:8796/internal/notify \
  -H "Content-Type: application/json" \
  -H "X-Notify-Token: <FEISHU_NOTIFY_TOKEN>" \
  -d '{"text": "要推送的内容", "open_id": "ou_xxx"}'
```

`open_id` 省略时发给 `FEISHU_NOTIFY_USER`。为兼容旧的定时任务，也接受
`{"text": "...", "qq": "10001"}`，会按 `FEISHU_LIFE_KEY_MAP` 反查出对应 open_id。
也支持 `{"text": "...", "chat_id": "oc_xxx"}` 推送到群。

## 维护

```bash
# 检查配置（不启动服务）
/opt/node/bin/node /opt/feishu-bot/server/server.js --check

systemctl status feishu-bot
systemctl restart feishu-bot
journalctl -u feishu-bot -f

# 改完源码后重新部署
bash /root/feishu-bot/deploy/install.sh
systemctl restart feishu-bot
```

## 日志中心

收发消息、Codex 运行输出（命令 / 工具输出 / stderr）都会写入
https://log.tykrem.top/ ，来源 `feishu-bot`，保留 30 天。

## 风险提示

机器人以 root 运行，且对被允许的用户开放 Codex 全自动执行命令。
请只把可信的人加入 `FEISHU_ALLOW_USERS`；对外部人员用 `FEISHU_RESTRICTED_USERS`
（纯聊天，无本机权限）。
