---
name: feishu-command-check
description: 给 feishu-bot 加或改内置关键字指令时的写法与本地验证。改 server/lib/、server/server.js 的消息分发，或需要复现「某个关键字没反应 / 回错话」时使用。
---

# 改 feishu-bot 内置指令

## 怎么写

- 判断与格式化放 `server/lib/`（纯函数、可单测），`server/server.js`
  的 `handleMessage` 里只留一个薄分支，别把逻辑写进分发里。
- 关键字用整句锚定：`/^(?:\.tasks?|任务)$/i`。写成 `text.indexOf('任务') >= 0`
  会把「任务：写周报」这类正文一起吞掉，用户就再也没法让 Codex 处理这句话。
- 生活类指令还要错开 `life-app` 的关键字（`lib/actions.js` 里已占了
  记账 / 待办 / 推算等），否则会被 life-app 先截走。
- 数据源当**可选依赖**处理：`requireLife()` / `requireScheduler()` 那套按目录
  try-require，取不到就回一句「未安装」，主流程照跑。
- `JSDoc` 参数类型要写全（`@param {number} n`）。`npm run typecheck` 是
  `checkJs` + `strict`，漏一个就是 TS7006 报错。

## 怎么本地验证

不需要飞书客户端：server.js 自带两个调试开关——`FEISHU_SIMULATE_EVENT`
（喂一条 `im.message.receive_v1` 事件，不建长连接）和 `FEISHU_DRY_RUN=1`
（回执只打印不发送）。

```bash
cd /root/feishu-bot/server
# systemd 的 EnvironmentFile 不会自动生效，白名单要自己导出，否则走「未授权」分支
while IFS='=' read -r k v; do case "$k" in ''|'#'*) continue;; esac; export "$k=$v"; done < /etc/feishu-bot.env
EVENT=$(/opt/node/bin/node -e 'console.log(JSON.stringify({message:{message_id:"om-t1",chat_id:"oc-t",chat_type:"p2p",message_type:"text",content:JSON.stringify({text:"任务"})},sender:{sender_type:"user",sender_id:{open_id:process.argv[1]}}}))' "$(printf %s "$FEISHU_ALLOW_USERS" | cut -d, -f1)")
timeout 15 env FEISHU_DRY_RUN=1 FEISHU_INTERNAL_PORT=8798 \
  FEISHU_LOG_URL=http://127.0.0.1:9/api/v1/logs \
  FEISHU_SIMULATE_EVENT="$EVENT" /opt/node/bin/node server.js
```

三个必须错开/避开的点：

- `FEISHU_INTERNAL_PORT`：线上的 feishu-bot 正占着 8796，模拟进程不改端口会
  EADDRINUSE 直接崩。
- `FEISHU_LOG_URL`：不指到 127.0.0.1:9 这种黑洞端口，就会往真日志中心写一条
  「feishu-bot 已启动」的假记录，翻日志时会看懵。
- 进程不会自己退出（内部通知接口在监听），套 `timeout`。

`content` 要放**转义后的 JSON 字符串**（`JSON.stringify({text:"..."})`），
不能直接写 `{"text":"任务"}`。

断言挑确定性的：关键字能不能整句匹配、空数据/坏数据的回复、受限账号被拒。
时间相关的断言必须把 `now` 传进去，不然换个钟点跑就挂。

## 上线

```bash
bash /root/server-ops/bin/deploy-app.sh feishu-bot   # install.sh 同步源码 + 装依赖 + 重启
systemctl is-active feishu-bot && journalctl -u feishu-bot -n 20 --no-pager
```

装完先看 `--check` 输出（install.sh 会跑），里面列了白名单、单次提醒目录、
生活键映射——路径写错在这一步就能看出来。
