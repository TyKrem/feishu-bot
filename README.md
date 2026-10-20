# feishu-bot

把**飞书**和 **Codex CLI** 接起来的机器人：在飞书里发一句话，服务器上的 Codex
执行任务，结果回传到飞书。

用飞书自建应用的**长连接**接收事件，所以不需要公网回调地址、不用开放入站端口，
跑在内网或家宽机器上也能用。

## 特性

- **长连接收事件**：无需公网 IP、无需配置回调 URL、不用装协议端容器
- **在飞书里用 Codex**：可以执行命令、读写服务器文件
- **受限账号**：只允许纯聊天和内置指令，不启动 Codex 工具
- **白名单**：私聊按 `open_id` 放行；白名单为空时只回报身份，不执行任何操作
- **群聊**：需 @ 机器人 才响应，可再按 `chat_id` 加白名单
- **内置指令**：骰子、塔罗、每日运势、记账、待办（后四项依赖可选的 life-app）、
  任务（查看待执行的单次提醒，依赖可选的 scheduler-app）、状态 / 用量 / 定时器
  （服务器信息，走本地脚本与监控接口，不经过 Codex，也不给受限账号）
- **塔罗带牌面**：抽塔罗时自动附上对应牌面的图片，逆位会把图片倒过来
- **图片只登记不识别**：直接发图先落盘并按顺序编号，你明确说要看时才让 Codex 读
- **随机回复延迟**：避免"秒回"得像脚本
- **本地通知接口**：供 cron / 定时任务 / 监控告警推送消息到飞书
- **早报定位**：在机器人单聊中手动分享飞书位置即可更新，并持续沿用到下一次分享；首次分享前使用北京朝阳
- **优雅降级**：没装 life-app 也能正常运行，只是少几条生活指令

## 架构

```
server/
|-- server.js        长连接、消息分发、Codex 调度、发送队列（主流程）
|-- tarot-image.js   塔罗牌面图片合成
|-- lib/             解析与身份工具；internal-notify.js 处理本机通知接口
`-- test/            node:test 单测
```

`lib/` 的解析工具可单独测；本机通知接口由 `internal-notify.js` 接收配置、投递与日志函数，
`server.js` 只负责监听端口和连接业务依赖。

```bash
npm test          # 等价于 node --test server/test/*.test.js
npm run typecheck # 等价于 tsc -p tsconfig.json
```

## 类型检查

用 TypeScript 做类型检查，**源码仍是 JS，没有构建步骤**——服务跑在 Node 24 上，
部署又是直接拷 `server/` 目录，加一道编译不划算。类型靠 JSDoc 标注，
`allowJs` + `checkJs` 来检查，`strict` 全开。

改动代码时顺手跑一遍：

```bash
npm run typecheck   # tsc -p tsconfig.json，0 错误才算过
```

跨模块的形状定义在 `lib/` 里（比如 `identity.js` 的 `NotifyTarget`），
`server.js` 用 `@typedef {import('./lib/identity.js').NotifyTarget}` 引过来，
所以改一个形状两边都会报错。

```
飞书客户端
    │  长连接（WebSocket，由本服务主动连出）
    ▼
feishu-bot ── spawn ──> codex exec --json ──> 整理输出
    │
    └── 飞书 OpenAPI（发消息）──> 飞书客户端
```

## 快速开始

### 1. 创建飞书自建应用

1. 打开[飞书开放平台](https://open.feishu.cn/app)，创建「企业自建应用」
2. 「凭证与基础信息」拿到 **App ID / App Secret**
3. 「添加应用能力」启用**机器人**
4. 「权限管理」开通 `im:message`、`im:message:send_as_bot`，
   以及收发图片需要的 `im:resource`
5. 「事件与回调」→ 订阅方式选**使用长连接接收事件**，添加事件 `im.message.receive_v1`
6. 「版本管理与发布」创建版本并发布（企业内可能需要管理员审核）

> 国际版 Lark 用 `open.larksuite.com`，并把 `FEISHU_DOMAIN` 设为 `lark`。

### 2. 安装

```bash
git clone git@github.com:TyKrem/feishu-bot.git
cd feishu-bot
npm install --omit=dev
```

还需要 [Codex CLI](https://github.com/openai/codex)（默认从 `/opt/codex/bin/codex`
调用，可用 `FEISHU_CODEX_BIN` 指定）。

排查 `.c` 的 `code=1` 时，先看日志中的具体错误。CLI 的接口失败可能只在
stdout JSON 的 `error` / `turn.failed` 中返回，stderr 为空；机器人会把这段详情
显示在失败回复并记录到日志。`item.completed` 中的 `error` 也可能只是模型切换提示，
不能仅凭它判断整个回合失败。

更新终端里的 Codex 不会自动更新机器人使用的独立安装目录。切换模型后异常时，
分别检查 `FEISHU_CODEX_BIN` 指定的程序与终端 `codex` 的版本，并在相同账号、模型
和服务环境下验证；不要仅凭旧 CLI 的“不支持该模型”错误更换模型或重新登录。

### 3. 配置

```bash
cp deploy/feishu-bot.env.example /etc/feishu-bot.env
chmod 600 /etc/feishu-bot.env
vi /etc/feishu-bot.env        # 至少填 FEISHU_APP_ID / FEISHU_APP_SECRET
```

### 4. 启动

```bash
node server/server.js                     # 前台运行
bash deploy/install.sh                    # 或安装成 systemd 服务并启用
journalctl -u feishu-bot -f
```

### 5. 把使用者加进白名单

白名单为空时机器人不执行任何操作，只会把你的 `open_id` 回给你。给机器人发一句话，然后：

```bash
/opt/feishu-bot/bin/setup-account.sh ou_你的openid
# 想沿用历史记账/待办数据时，再加一个旧主键：
# setup-account.sh ou_你的openid 10001
```

## 指令

| 输入 | 行为 |
| --- | --- |
| `.c 内容` / `.codex 内容` | 调用 Codex 处理 |
| `.help` / `帮助` | 帮助 |
| `.rand 3d10` / `骰子 3d10` | 投骰子（支持 `2d6+1`、`d20`） |
| `.tarot` / `塔罗牌` | 抽塔罗，附牌面图片 *（需 life-app）* |
| `.fortune` / `今日运势` | 每日运势，按天缓存 *（需 life-app）* |
| 记账 / 待办类中文 | 直接处理，不启动 Codex *（需 life-app）* |
| `任务` / `.tasks` | 列出待执行的单次提醒（到点、剩余时间、内容）*（需 scheduler-app）* |
| `状态` / `巡检` | 跑 server-ops 的巡检脚本，回服务 / 端口 / 站点 / 磁盘 / 证书 / 失败单元 |
| `用量` / `余额` | API 余额与 Token 用量（监控页已不展示，改在这里查） |
| `定时器` / `计时器` | 定时任务的下次运行、上次时间与上次结果（success / failed） |
| `知识库 关键词` | 查服务器知识库（项目 / 服务 / 端口 / 坑），例「知识库 飞书」；多个词要同时命中 |
| 直接发图片 | 先存盘登记（不识别），要看时说 `.c 看下第 2 张图` |

常用指令**不写前缀**也能用（`帮助`、`塔罗牌`、`今日运势`、`骰子 3d10`）；
带前缀时 `.` 也可以写成 `。`。

## 配置项

| 变量 | 说明 |
| --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 自建应用凭据，**必填** |
| `FEISHU_DOMAIN` | `feishu`（国内版，默认）或 `lark`（国际版） |
| `FEISHU_ALLOW_USERS` | 允许私聊的身份（`open_id` / `user_id` / `union_id`），逗号分隔 |
| `FEISHU_ALLOW_CHATS` | 允许的群 `chat_id`，群聊需 @ 机器人 |
| `FEISHU_RESTRICTED_USERS` | 受限账号：只能纯聊天与生活指令，不启动 Codex 工具 |
| `FEISHU_NOTIFY_USER` | 默认推送收件人 `open_id` |
| `FEISHU_NOTIFY_TOKEN` | 本地通知接口令牌 |
| `FEISHU_INTERNAL_HOST` / `FEISHU_INTERNAL_PORT` | 通知接口监听地址，默认 `127.0.0.1:8796` |
| `FEISHU_BOT_OPEN_ID` / `FEISHU_BOT_NAME` | 群聊里判断是否被 @，填了更准 |
| `FEISHU_LIFE_KEY_MAP` | `open_id=旧主键`，用于沿用历史记账 / 待办数据 |
| `FEISHU_TAROT_IMAGE` | 塔罗是否附牌面图片，`1` 开（默认）/ `0` 关 |
| `FEISHU_IMAGE_RETENTION_DAYS` | 收到的图片保留天数，默认 `7`，超期在清理时删除 |
| `FEISHU_IMAGE_MAX_PER_KEY` | 每个会话最多保留多少张图片的索引，默认 `200` |
| `LIFE_APP_DIR` | life-app 所在目录（默认 `/opt/life-app`） |
| `SCHEDULER_APP_DIR` / `FEISHU_ONCE_DIR` | scheduler-app 目录与一次性提醒数据目录（默认 `/opt/scheduler-app`、`/opt/scheduler-app/data/once`） |
| `FEISHU_MONITOR_API` | 监控后端地址，`用量 / 余额` 用（默认 `http://127.0.0.1:8791`） |
| `FEISHU_HEALTH_SCRIPT` | 巡检脚本路径，`状态 / 巡检` 用（默认 `/root/server-ops/bin/health-check.sh`） |
| `FEISHU_CODEX_BIN` | Codex 可执行文件路径 |
| `FEISHU_WORKSPACE` | Codex 工作目录，默认 `/root` |
| `FEISHU_CODEX_HOME` | Codex 运行目录（会话与配置隔离） |
| `FEISHU_MAX_ACTIVE` | 同时处理的任务数上限 |
| `FEISHU_TURN_TIMEOUT` | 单轮超时秒数 |
| `FEISHU_LOG_URL` / `FEISHU_LOG_TOKEN` | 可选，上报到自建日志中心 |
| `FEISHU_HEALTH_LOG` | 健康时间线文件 |

完整示例见 [deploy/feishu-bot.env.example](deploy/feishu-bot.env.example)。

## 本地通知接口

供定时任务、监控告警等本地程序推送消息：

```bash
curl -X POST http://127.0.0.1:8796/internal/notify \
  -H "Content-Type: application/json" \
  -H "X-Notify-Token: <FEISHU_NOTIFY_TOKEN>" \
  -d '{"text": "要推送的内容", "open_id": "ou_xxx"}'
```

- 省略 `open_id` 时发给 `FEISHU_NOTIFY_USER`
- 也支持 `{"text":"...","chat_id":"oc_xxx"}` 推送到群

## 调试

```bash
# 只检查配置，不启动
node server/server.js --check

# 不连飞书，模拟一条消息走完整流程（只打印，不真的发送）
FEISHU_SIMULATE_EVENT='{"sender":{"sender_id":{"open_id":"ou_test"},"sender_type":"user"},
  "message":{"message_id":"m1","chat_id":"c1","chat_type":"p2p","message_type":"text",
  "content":"{\"text\":\".help\"}"}}' \
FEISHU_DRY_RUN=1 node server/server.js
```

## 可选依赖 life-app

记账、待办、塔罗、运势由同作者的 life-app 提供。没有它机器人照常工作，
只是这几条指令会回复"未安装"。

安装方式：把 life-app 部署到 `/opt/life-app`，
或用 `LIFE_APP_DIR` 显式指定路径后重启。目标模块缺失时相关指令降级；模块内部加载报错会直接报告，避免误用源码目录。

## 可选依赖 scheduler-app

`任务` 关键字的数据来自同作者的 scheduler-app（`/opt/scheduler-app/data/once`
里的一次性提醒，只有 root 读得到）。没装就只少这一条指令，
监控页也不再展示单次提醒——要查就得在飞书里问。

安装方式：把 scheduler-app 部署到 `/opt/scheduler-app`，
或用 `SCHEDULER_APP_DIR` 显式指定路径后重启。

## 塔罗牌面图片

抽塔罗时，除了文字解读还会发一张对应牌面的图片：正位原图，逆位把图片旋转 180°。

- 牌面取自 [Wikimedia Commons](https://commons.wikimedia.org/) 上的
  Rider-Waite-Smith 牌组（1909 年出版，**公有领域**），只涵盖 22 张大阿卡纳
- 首次使用时按需下载并缓存在 `FEISHU_DATA_DIR/tarot/`，之后直接读本地文件
- 取不到图片时自动降级为纯文字，不影响指令本身
- 发图片需要飞书 **`im:resource`** 权限（上传图片用），记得在权限管理里开通并发布版本

关闭图片：把 `FEISHU_TAROT_IMAGE` 设为 `0`。

## 收到的图片

直接发到飞书里的图片（含富文本消息里内嵌的图）不会立刻识别，先落盘登记：

- 存放：`FEISHU_DATA_DIR/images/<日期>/`，文件名里带会话与编号
- 索引：`FEISHU_DATA_DIR/images/index.json`，记录编号、时间、路径、发送人
- 回执：连发多张只回一条，比如「已记录 2 张图片（第 1-2 张），暂不识别」
- 读图：只有你明确要求时才读，比如 `.c 看下第 2 张图`；要多张时按编号顺序处理
- 清理：超过 `FEISHU_IMAGE_RETENTION_DAYS`（默认 7 天）的图片会被删掉，
  进程启动时清一次，之后每 6 小时一次，未过期的一张都不动
- 每次调用 Codex 只带上「编号 + 时间 + 路径」的登记清单，不带图片内容，
  「不主动读图」也写进了系统提示词

收图和读图都需要飞书 **`im:resource`** 权限。

## 安全提示

旧版机器人以运行它的系统用户直接执行Codex。当前使用独立运维执行器，Codex仍是完全自动、无沙箱模式，
等同于把 shell 交给白名单里的人。

- 只把可信的人加入 `FEISHU_ALLOW_USERS`
- 对外部使用者用 `FEISHU_RESTRICTED_USERS`（纯聊天，无本机权限）
- 建议用独立系统账号运行，而不是 root
- 建议把 `FEISHU_CODEX_HOME` 指向独立目录，避免和交互式使用互相影响

## License

[MIT](LICENSE)

## 消息入口与运维执行器分离

消息入口使用专用无登录账户，只能写自身data、共享生活data及健康日志；代码由root持有。执行器是独立root服务，仅提供Unix socket，不监听公网端口。普通账户无sudo且禁止SSH。

`.c`仅管理员私聊可用；管理员以执行器独立配置为准，与默认推送收件人解耦。执行器从飞书重新读取原始消息，核对独立配置的管理员open_id、固定私聊chat_id、消息ID、十分钟有效期及删除/编辑状态；提示从原始正文重建，不接受入口传来的命令、环境、工作目录或会话ID。模型子进程仅使用固定环境和既有专用模型登录目录，不继承飞书应用密钥或通知令牌。原有管理员会话首次迁移并由root私有状态继续管理，模型JSON输出流仍由入口整理回复。

状态、余额、定时器、任务与知识库通过固定查询接口读取，不向入口开放root目录。`.stop`／`.cancel`／停止任务／取消任务取消当前运维执行；连接中断和超时也终止执行进程组。请求限额、并发、响应大小均有上限。排队重启只消费root创建的安全标记，并等待执行器空闲；回复发送后再延迟重启。执行器仍是高权限信任边界，并不构成对任意管理员运维命令的沙箱。

部署前须独立确认管理员身份与私聊通道，写入root专用`/etc/feishu-executor.env`（600），字段`FEISHU_EXECUTOR_OWNER`、`FEISHU_EXECUTOR_CHAT`；不提供默认身份，不信任入口自动上报。入口环境另设`FEISHU_EXECUTOR_SOCKET`。原始消息核验使用应用已有的消息读取授权；授权撤销或飞书接口不可达时拒绝运维请求，通知推送和普通生活功能不依赖该核验。执行器需要飞书应用凭据完成核验，但不会把它传给模型子进程。

先以`FEISHU_ISOLATION_PHASE=executor`发布，保持入口原运行身份验证；再部署生活共享数据属主兼容，最后正常发布切换专用账户。更新执行器代码时，安装器不会直接重启正在执行任务的执行器；需等待任务结束后单独重启并验证。回退时恢复上一版代码、环境与两个服务单元，root可读取专用账户的数据，不覆盖业务data。
