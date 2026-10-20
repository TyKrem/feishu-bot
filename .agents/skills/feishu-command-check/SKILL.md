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

## `.c` 执行失败的检查

- 核对实际 `FEISHU_CODEX_BIN` 的版本；终端中的 `codex` 可能来自另一套安装。
  同一模型在旧 CLI 返回“不支持 ChatGPT 账号”，在新 CLI 成功的情况已经实际出现。
  对比时沿用服务环境、账号和模型，先做最小请求，不要直接清会话或改登录方式。
- stdout 的 `error.message` 与 `turn.failed.error.message` 才是失败详情，后者还可能
  嵌套接口 JSON；stderr 为空不代表没有原因。`item.completed` 的 `error` 可能只是提示。
- `FEISHU_DRY_RUN` 只阻止机器人投递，**不会禁用 Codex hook**。真实模型探针可用
  `--disable hooks --ephemeral`，避免测试触发通知或保存探针会话；先核对 CLI 支持这些参数。
- 消息模拟另设临时 `FEISHU_DATA_DIR`、`FEISHU_CODEX_HOME`、`FEISHU_HEALTH_LOG`，
  避免启动清理图片、复制配置或保存 thread 时触及生产数据。

## 上线

```bash
bash /root/server-ops/bin/deploy-app.sh feishu-bot   # install.sh 同步源码 + 装依赖 + 重启
systemctl is-active feishu-bot && journalctl -u feishu-bot -n 20 --no-pager
```

装完按服务环境运行 `--check`，其中列出白名单、单次提醒目录、
生活键映射——路径写错在这一步就能看出来。

## 独立执行器的验证边界

- 消息入口使用专用账户；启用`FEISHU_EXECUTOR_SOCKET`时，`.c`及固定查询改走Unix socket。模型进程的原始正文由执行器向飞书回查，不能用伪造模拟事件证明真实运维调用通过；合成消息只能测试拒绝路径，正向链路用本人十分钟内的新私聊消息。
- 执行器状态及模型登录仍是root专用，不能为迁移给入口开放/root。初次迁移在入口停止写入后校正data属主；生活数据的root定时任务必须继承目录属主，防止后续原子替换生成600/root文件。
- 取消与断连必须终止执行器里的进程组，不能只杀消息入口的客户端；`server/test/executor.test.js`覆盖该边界。升级执行器等其空闲再重启，不能在飞书任务中重启自身。
- 原始消息核验用飞书应用凭据，模型子进程使用显式环境白名单；不要为了修复认证给子进程重新传入整个process.env。读取权限撤销时应拒绝执行。
- 依赖安装按锁文件走npm官方HTTPS，保留原integrity和版本。旧锁文件含HTTP镜像时会触发EALLOWREMOTE，不能通过关闭全局下载策略绕过。

- CLI模型探针必须关闭stdin（stdio ignore或显式stdin.end）；保留默认pipe会让CLI等待额外输入，不能误判网络失败。诊断进程也应单独进程组并在超时终止整组，避免只杀Node启动器而留下native CLI。
- runuser通常继承调用方/root工作目录，Node -e即使require绝对路径也可能因扫描/root/package.json失败；专用账户探针要显式使用/opt运行目录作为cwd。
