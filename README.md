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
- **内置指令**：骰子、塔罗、每日运势、记账、待办（后四项依赖可选的 life-app）
- **塔罗带牌面**：抽塔罗时自动附上对应牌面的图片，逆位会把图片倒过来
- **图片只登记不识别**：直接发图先落盘并按顺序编号，你明确说要看时才让 Codex 读
- **随机回复延迟**：避免"秒回"得像脚本
- **本地通知接口**：供 cron / 定时任务 / 监控告警推送消息到飞书
- **优雅降级**：没装 life-app 也能正常运行，只是少几条生活指令

## 架构

```
server/
|-- server.js        长连接、消息分发、Codex 调度、发送队列（主流程）
|-- tarot-image.js   塔罗牌面图片合成
|-- lib/             纯函数：配置解析、文本解析、身份白名单、文件名、小工具
`-- test/            node:test 单测（31 个用例）
```

`lib/` 下的都是不依赖运行期状态的纯函数，可以单独测；`server.js` 里对应位置保留
同名别名或薄包装（依赖配置的那些把配置当参数传给 `lib/`），所以调用点没变。

```bash
npm test          # 等价于 node --test server/test/
npm run typecheck # 等价于 tsc -p tsconfig.json && tsc -p tsconfig.strict.json
```

## 类型检查

用 TypeScript 做类型检查，**源码仍是 JS，没有构建步骤**——服务跑在 Node 16 上，
部署又是直接拷 `server/` 目录，加一道编译不划算。类型靠 JSDoc 标注，
`allowJs` + `checkJs` 来检查。

两份配置是有意分开的：

| 配置 | 覆盖范围 | 严格度 |
| --- | --- | --- |
| `tsconfig.json` | `server/**/*.js` | `strictNullChecks` 开，`noImplicitAny` 关 |
| `tsconfig.strict.json` | 只 `server/lib/**` | 额外开 `noImplicitAny` |

`lib/` 是拆分出来的模块、边界清楚，所以一次做到底；`server.js` 还留着约 125 处
隐式 any，先在宽松配置下慢慢补。这样两边互不阻塞，`lib/` 也不会退化。

想往上加严格度时，顺序建议是：先把 `server.js` 里的隐式 any 补成 JSDoc，
再把 `noImplicitAny` 提到第一份配置里。

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
| `LIFE_APP_DIR` | life-app 所在目录（默认依次找 `/opt/life-app`、`/root/life-app`） |
| `FEISHU_CODEX_BIN` | Codex 可执行文件路径 |
| `FEISHU_WORKSPACE` | Codex 工作目录，默认 `/root` |
| `FEISHU_CODEX_HOME` | Codex 运行目录（会话与配置隔离） |
| `FEISHU_MAX_ACTIVE` | 同时处理的任务数上限 |
| `FEISHU_TURN_TIMEOUT` | 单轮超时秒数 |
| `FEISHU_REPLY_DELAY_MIN` / `_MAX` | 被动回复随机延迟秒数，默认 0.8 ~ 2.5 |
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

安装方式：把 life-app 放到 `/opt/life-app` 或 `/root/life-app`，
或用 `LIFE_APP_DIR` 指定路径后重启。

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

机器人会以**运行它的系统用户**身份执行 Codex，默认是完全自动、无沙箱模式，
等同于把 shell 交给白名单里的人。

- 只把可信的人加入 `FEISHU_ALLOW_USERS`
- 对外部使用者用 `FEISHU_RESTRICTED_USERS`（纯聊天，无本机权限）
- 建议用独立系统账号运行，而不是 root
- 建议把 `FEISHU_CODEX_HOME` 指向独立目录，避免和交互式使用互相影响

## License

[MIT](LICENSE)
