#!/usr/bin/env node
'use strict';

/*
 * 飞书 → Codex 桥接服务
 *
 * 架构：飞书开放平台（自建应用，长连接 WebSocket）→ 本服务
 *       → Codex CLI（可执行命令 / 读写服务器）→ 飞书回复
 *
 * 与 qq-bot 的差异：
 *  - 接入方式：飞书长连接（无需公网回调地址、无需协议端容器）
 *  - 身份标识：open_id / user_id / union_id（不再有 QQ 号）
 *  - 保留内部通知接口 127.0.0.1:8796，供 scheduler-app 等复用
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { URL } = require('url');
const lark = require('@larksuiteoapi/node-sdk');
const TAROT_IMAGE = require('./tarot-image.js');
const CFG = require('./lib/config.js');
const TXT = require('./lib/text.js');
const IDENT = require('./lib/identity.js');
const IMGS = require('./lib/images.js');
const CMDS = require('./lib/commands.js');
const UTIL = require('./lib/util.js');

// 类型别名：跨模块的形状从 lib/ 引，本文件自己的状态在这里定义
/** @typedef {import('./lib/identity.js').NotifyTarget} NotifyTarget */
/** @typedef {{ threadId: string|null, updatedAt?: number }} ThreadRef */
/** @typedef {{ role: string, content: string }} ChatMessage */
/** @typedef {{ history: ChatMessage[] }} GuestChat */
/** @typedef {{ n: number, file: string, messageId: string, imageKey: string, openId: string, chatId: string, savedAt: number, bytes: number }} ImageItem */
/** @typedef {{ seq: Record<string, number>, items: Record<string, ImageItem[]> }} ImageIndex */

// 抽到 lib/ 的纯函数在这里起别名，调用点保持原样。
// 必须放在配置块之前——别名是 const，不像原来的函数声明会提升。
const splitList = CFG.splitList;
const parseKeyMap = CFG.parseKeyMap;
const reverseMap = CFG.reverseMap;
const tomlValue = CFG.tomlValue;
const chunkText = TXT.chunkText;
const stripMentionKeys = TXT.stripMentionKeys;
const extractText = TXT.extractText;
const extractImageKeys = TXT.extractImageKeys;
const extractCodexPrompt = TXT.extractCodexPrompt;
const extractGuestText = TXT.extractGuestText;
const senderIds = IDENT.senderIds;
const matches = IDENT.matches;
const imageKeySlug = IMGS.imageKeySlug;
const imageExtFromType = IMGS.imageExtFromType;
const imageStamp = IMGS.imageStamp;
const sleep = UTIL.sleep;
const errText = UTIL.errText;
const tokenEqual = UTIL.tokenEqual;
const rollDiceText = CMDS.rollDiceText;
const isOnceTasksCommand = CMDS.isOnceTasksCommand;
const onceTasksText = CMDS.onceTasksText;
const isStatusCommand = CMDS.isStatusCommand;
const isUsageCommand = CMDS.isUsageCommand;
const isTimersCommand = CMDS.isTimersCommand;
const healthText = CMDS.healthText;
const timerRows = CMDS.timerRows;
const parseShowResults = CMDS.parseShowResults;
const parseFailedUnits = CMDS.parseFailedUnits;
const timersText = CMDS.timersText;
const usageText = CMDS.usageText;

// 生活指令（记账 / 待办 / 塔罗 / 运势）由可选的 life-app 提供。
// 找不到就降级：机器人照常工作，只是少了这几条指令。
/**
 * @param {string} mod life-app 里的模块文件名，如 'actions.js'
 * @returns {any} 模块导出；没装 life-app 时返回 null
 */
function requireLife(mod) {
  const lifeDir = String(process.env.LIFE_APP_DIR || '').replace(/\/+$/, '');
  const dirs = [
    lifeDir ? lifeDir + '/lib/' : '',
    '/opt/life-app/lib/',
    '/root/life-app/lib/',
    path.join(__dirname, '..', 'vendor', 'life-app', 'lib/'),
  ].filter(Boolean);
  for (let i = 0; i < dirs.length; i++) {
    try { return require(dirs[i] + mod); } catch (e) {}
  }
  return null;
}
const LIFE_ACTIONS = requireLife('actions.js');
const LIFE_FORTUNE = requireLife('fortune.js');
const LIFE_PROFILE = requireLife('profile.js');
const LIFE_ENABLED = !!(LIFE_ACTIONS && LIFE_FORTUNE && LIFE_PROFILE);

// 单次提醒数据在 scheduler-app 那边（/opt/scheduler-app/data/once）。
// 同样按可选依赖处理：没装就只剩「任务」这一条指令不可用。
/**
 * @param {string} mod scheduler-app 里的模块文件名，如 'once.js'
 * @returns {any} 模块导出；没装 scheduler-app 时返回 null
 */
function requireScheduler(mod) {
  const schedDir = String(process.env.SCHEDULER_APP_DIR || '').replace(/\/+$/, '');
  const dirs = [
    schedDir ? schedDir + '/lib/' : '',
    '/opt/scheduler-app/lib/',
    '/root/scheduler-app/lib/',
  ].filter(Boolean);
  for (let i = 0; i < dirs.length; i++) {
    try { return require(dirs[i] + mod); } catch (e) {}
  }
  return null;
}
const SCHED_ONCE = requireScheduler('once.js');
const SCHED_ONCE_ENABLED = !!SCHED_ONCE;

const ENV = process.env;

/* ---------------- 配置 ---------------- */
const APP_ID = String(ENV.FEISHU_APP_ID || '').trim();
const APP_SECRET = String(ENV.FEISHU_APP_SECRET || '').trim();
const DOMAIN_NAME = String(ENV.FEISHU_DOMAIN || 'feishu').trim().toLowerCase();
const LARK_DOMAIN = DOMAIN_NAME === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

const CODEX_BIN = ENV.FEISHU_CODEX_BIN || '/opt/codex/bin/codex';
const WORKSPACE = ENV.FEISHU_WORKSPACE || '/root';
const CODEX_HOME = ENV.FEISHU_CODEX_HOME || '/root/.codex-feishu';
const DATA_DIR = ENV.FEISHU_DATA_DIR || '/opt/feishu-bot/data';
const THREAD_FILE = path.join(DATA_DIR, 'threads.json');
// 「任务」关键字读的一次性提醒目录（scheduler-app 的数据目录）
const ONCE_TASKS_DIR = String(ENV.FEISHU_ONCE_DIR || '/opt/scheduler-app/data/once');
const MAX_ACTIVE = Math.max(1, parseInt(ENV.FEISHU_MAX_ACTIVE || '2', 10) || 2);
const TURN_TIMEOUT = Math.max(60, parseInt(ENV.FEISHU_TURN_TIMEOUT || '900', 10) || 900);
const LOG_ENDPOINT = ENV.FEISHU_LOG_URL || 'http://127.0.0.1:8792/api/v1/logs';
const LOG_TOKEN = String(ENV.FEISHU_LOG_TOKEN || '').trim();
const ALLOW_USERS = splitList(ENV.FEISHU_ALLOW_USERS);
const ALLOW_CHATS = splitList(ENV.FEISHU_ALLOW_CHATS);
const RESTRICTED_USERS = splitList(ENV.FEISHU_RESTRICTED_USERS || ENV.FEISHU_CHAT_ONLY_USERS);
const NOTIFY_USER = String(ENV.FEISHU_NOTIFY_USER || '').trim();
const NOTIFY_TOKEN = String(ENV.FEISHU_NOTIFY_TOKEN || '').trim();
const INTERNAL_HOST = String(ENV.FEISHU_INTERNAL_HOST || '127.0.0.1');
const INTERNAL_PORT = parseInt(ENV.FEISHU_INTERNAL_PORT || '8796', 10);
const BOT_OPEN_ID = String(ENV.FEISHU_BOT_OPEN_ID || '').trim();
const BOT_NAME = String(ENV.FEISHU_BOT_NAME || '').trim();
// 塔罗牌面图片：默认开启，取不到图片时自动降级为纯文字
const TAROT_IMAGE_ENABLED = !/^(0|false|no)$/i.test(String(ENV.FEISHU_TAROT_IMAGE || '1').trim());
const TAROT_CACHE_DIR = path.join(DATA_DIR, 'tarot');

// 用户发来的图片只落盘登记，不主动识别；用户明确要求时才交给 Codex 读
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const IMAGE_INDEX_FILE = path.join(IMAGE_DIR, 'index.json');
// 保留周期：超过这个天数的图片在清理时删除，可用 FEISHU_IMAGE_RETENTION_DAYS 调整
const IMAGE_RETENTION_DAYS = Math.max(1, parseFloat(ENV.FEISHU_IMAGE_RETENTION_DAYS || '7') || 7);
const IMAGE_CLEAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
// 每个会话索引保留的条数上限，超出后从最旧的开始连同文件一起删
const IMAGE_PER_KEY_LIMIT = Math.max(10, parseInt(ENV.FEISHU_IMAGE_MAX_PER_KEY || '200', 10) || 200);

// 调试用：FEISHU_SIMULATE_EVENT 传入一条 im.message.receive_v1 事件 JSON，
// 启动时不建立长连接，直接按该事件跑一遍消息处理；FEISHU_DRY_RUN=1 时只打印不发送。
const SIMULATE_EVENT = String(ENV.FEISHU_SIMULATE_EVENT || '').trim();
const DRY_RUN = /^(1|true|yes)$/i.test(String(ENV.FEISHU_DRY_RUN || ''));
// 连发多张图片时合并成一条回执，避免刷屏；调试模式下缩短等待
const IMAGE_ACK_DELAY_MS = DRY_RUN ? 200 : 2500;

// 生活数据按“身份键”隔离。QQ 时代的数据以 QQ 号为主键，
// FEISHU_LIFE_KEY_MAP 可以把飞书身份映射回原来的键，免迁移数据。
// 格式：ou_xxx=10001,ou_yyy=10002
const LIFE_KEY_MAP = parseKeyMap(ENV.FEISHU_LIFE_KEY_MAP);
const LEGACY_TO_FEISHU = reverseMap(LIFE_KEY_MAP);

/* ---------------- 模型直连（受限账号纯聊天） ---------------- */
const GUEST_CONFIG_TEXT = readTextFile('/root/.codex/config.toml');

const GUEST_API_BASE = String(ENV.FEISHU_CHAT_API_BASE_URL || ENV.CHAT_API_BASE_URL || tomlValue(GUEST_CONFIG_TEXT, 'base_url') || '').trim();
const GUEST_API_KEY = String(ENV.FEISHU_CHAT_API_KEY || ENV.CHAT_API_KEY || tomlValue(GUEST_CONFIG_TEXT, 'experimental_bearer_token') || '').trim();
const GUEST_MODEL = String(ENV.FEISHU_CHAT_API_MODEL || ENV.CHAT_API_MODEL || tomlValue(GUEST_CONFIG_TEXT, 'model') || '').trim();

const FULL_AUTO_ARG = '--dangerously-bypass-approvals-and-sandbox';
const PROMPT_TAIL =
  '（飞书机器人场景）请使用简体中文回复；回复要简洁，适合在飞书里阅读。' +
  '飞书文本消息不渲染 Markdown 语法，尽量避免使用 ** 加粗、# 标题、表格与代码块围栏，' +
  '需要分点时用「1. 2. 3.」或「- 」这样的纯文本。命令执行结果太长时先给摘要，需要时再贴关键内容。' +
  '如果用户要求执行有破坏性的操作，先说明风险再执行。' +
  '图片规则：用户发到飞书里的图片已存到本地并登记（目录 ' + IMAGE_DIR + '，索引 ' + IMAGE_INDEX_FILE + '）。' +
  '不要一上来就读图或描述图片内容——只有用户明确要求看某张图时才读对应文件，' +
  '需要多张时按登记编号（第几张）顺序处理。' +
  '清理磁盘时只清理超出保留周期（默认 ' + IMAGE_RETENTION_DAYS + ' 天）的图片，未过期的不要删。';
const GUEST_PROMPT_TAIL =
  '（飞书机器人场景）请使用简体中文回复；回复要简洁，适合在飞书里阅读，避免 Markdown 语法。' +
  '你是纯文字聊天助手：不执行系统命令、不读取/修改服务器文件、不提供任何密钥或令牌。';

/* ---------------- 帮助文本 ---------------- */
// 塔罗 / 运势 / 记账 / 待办 依赖可选的 life-app，没装就不列出来
const HELP_HEAD =
  '🔧 现成指令（前缀 . 可省略）：\n' +
  '· .help / 帮助\n' +
  '· .codex 内容 / .c 内容 —— 调用 Codex 处理\n' +
  '· .rand 3d10 / 骰子 3d10 —— 投骰子（支持 2d6+1、d20）\n' +
  (SCHED_ONCE_ENABLED ? '· 任务 / .tasks —— 查看待执行的单次提醒\n' : '') +
  '· 状态 / 巡检 —— 服务器巡检结果（服务 / 端口 / 站点 / 磁盘 / 证书）\n' +
  '· 用量 / 余额 —— API 余额与 Token 用量\n' +
  '· 定时器 —— 定时任务的下次运行与上次结果\n' +
  (LIFE_ENABLED ? '· .tarot / 塔罗牌 —— 抽一张塔罗并解读\n· .fortune / 今日运势 —— 每日运势（每天算一次，之后返回缓存）\n' : '') +
  '· 开头的 . 也可以写成 。（如 。help、。rand 3d10）';

const HELP_HEAD_RESTRICTED =
  '🔧 现成指令（前缀 . 可省略）：\n' +
  '· .help / 帮助\n' +
  '· .c 内容 —— 使用纯聊天助手（无系统权限）\n' +
  '· .rand 3d10 / 骰子 3d10 —— 投骰子\n' +
  (LIFE_ENABLED ? '· .tarot / 塔罗牌 —— 抽塔罗\n' : '') +
  '· 开头的 . 也可以写成 。';

const HELP_LIFE =
  '\n\n📒 记账：\n' +
  '· 记：午饭 25 / 记账 打车 12\n' +
  '· 水费缴费50元（生活缴费也能识别）\n' +
  '· 查账 / 本月花了多少\n' +
  '· 预算 3000\n\n' +
  '📝 待办：\n' +
  '· 加待办：买牛奶\n' +
  '· 待办 / 完成待办 1 / 删除待办 2';

const HELP_LIFE_RESTRICTED =
  '\n\n📒 记账：\n' +
  '· 记：午饭 25 / 水费缴费50元\n' +
  '· 查账 / 本月花了多少\n\n' +
  '📝 待办：\n' +
  '· 加待办：买牛奶 / 待办 / 完成待办 1';

const HELP_TAIL =
  '\n\n📷 直接发图片：我先存下来并按顺序编号，不主动识别；\n' +
  '  要看时再说一句，例如：.c 看下第 2 张图\n' +
  '⏰ 提醒 / 查文件 / 服务器等需求，用：.c 内容\n' +
  '  例如：.c 十分钟后提醒我看锅、.c 今天服务器状态\n' +
  '💬 其他未匹配消息会自动回复本帮助\n' +
  '👥 群聊里需要 @ 我 才会响应';

const HELP_TAIL_RESTRICTED =
  '\n\n⏰ 个性化提醒等需求，用：.c 内容\n' +
  '⚠️ 当前账号为受限账号，仅可纯聊天与生活指令，不能操作服务器/文件';

/**
 * @param {boolean} restricted 是否受限账号（只能纯聊天与生活指令）
 * @returns {string}
 */
function botHelp(restricted) {
  if (restricted) {
    return HELP_HEAD_RESTRICTED + (LIFE_ENABLED ? HELP_LIFE_RESTRICTED : '') + HELP_TAIL_RESTRICTED;
  }
  return HELP_HEAD + (LIFE_ENABLED ? HELP_LIFE : '') + HELP_TAIL;
}

const NEED_LIFE_APP =
  '这条指令依赖 life-app（记账 / 待办 / 塔罗 / 运势），当前未安装。\n' +
  '把 life-app 放到 /opt/life-app 或 /root/life-app，或用 LIFE_APP_DIR 指定路径后重启即可。';

const NEED_SCHEDULER_APP =
  '这条指令依赖 scheduler-app（单次提醒），当前未安装。\n' +
  '把 scheduler-app 放到 /opt/scheduler-app 或 /root/scheduler-app，或用 SCHEDULER_APP_DIR 指定路径后重启即可。';

/* -------- 服务器类指令（状态 / 用量 / 定时器）--------
 * 这几种信息要么涉及服务器内部结构（单元名、端口、crontab），要么是私事，
 * 都不适合放在公开的监控页上，所以在飞书里问。走本地脚本与本地接口，
 * 不经过 Codex——比 `.c 今天服务器状态` 快，也不烧 token。
 */
const MONITOR_API = String(process.env.FEISHU_MONITOR_API || 'http://127.0.0.1:8791').replace(/\/+$/, '');
const HEALTH_SCRIPT = String(process.env.FEISHU_HEALTH_SCRIPT || '/root/server-ops/bin/health-check.sh');

/**
 * 跑一条命令，stdout 与 stderr 合并返回，顺带给出退出码。
 * @param {string} file
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{ code: number, output: string }>}
 */
function runCommand(file, args, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, function (error, stdout, stderr) {
      const output = String(stdout || '') + String(stderr || '');
      let code = 0;
      if (error) code = typeof error.code === 'number' ? error.code : 1;
      resolve({ code: code, output: output });
    });
  });
}

/**
 * 取本机接口的 JSON（监控后端只监听 127.0.0.1，不走公网）。
 * @param {string} url
 * @returns {Promise<any>}
 */
function getJson(url) {
  return new Promise(function (resolve, reject) {
    const mod = url.indexOf('https:') === 0 ? https : http;
    const req = mod.get(url, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(body)); } catch (/** @type {any} */ e) {
          reject(new Error('HTTP ' + res.statusCode + ' 返回的不是 JSON'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, function () { req.destroy(new Error('请求超时')); });
  });
}

/**
 * @param {NotifyTarget} replyTarget
 * @param {string[]} ids
 * @returns {Promise<void>}
 */
async function statusCommand(replyTarget, ids) {
  const result = await runCommand(HEALTH_SCRIPT, [], 60000);
  writeLog('info', '查询服务器状态', { openId: ids[0], exitCode: result.code });
  deliver(replyTarget, healthText(result.output, result.code, Date.now()));
}

/**
 * @param {NotifyTarget} replyTarget
 * @param {string[]} ids
 * @returns {Promise<void>}
 */
async function usageCommand(replyTarget, ids) {
  const payload = await getJson(MONITOR_API + '/api/balance');
  writeLog('info', '查询用量与余额', { openId: ids[0] });
  const text = usageText(payload.balance || null, payload.chat || null, Date.now());
  deliver(replyTarget, payload.error ? text + '\n⚠️ 余额接口：' + payload.error : text);
}

/**
 * @param {NotifyTarget} replyTarget
 * @param {string[]} ids
 * @returns {Promise<void>}
 */
async function timersCommand(replyTarget, ids) {
  const list = await runCommand('systemctl', ['list-timers', '--all', '--no-legend', '--plain'], 10000);
  const rows = timerRows(list.output);
  const active = rows.filter(function (row) { return !!row.nextText; }).map(function (row) { return row.activated; });
  /** @type {Record<string, string>} */
  let results = {};
  if (active.length) {
    // 一次 show 全问出来，别为每个单元起一个进程
    const show = await runCommand('systemctl', ['show'].concat(active, ['-p', 'Id', '-p', 'Result']), 10000);
    results = parseShowResults(show.output);
  }
  const failed = await runCommand('systemctl', ['--failed', '--no-legend', '--plain'], 10000);
  writeLog('info', '查询定时器', { openId: ids[0], count: rows.length });
  deliver(replyTarget, timersText(rows, results, parseFailedUnits(failed.output), Date.now()));
}

/* ---------------- 文件与目录 ---------------- */
/**
 * @param {string} p
 * @returns {string} 读不到返回空串
 */
function readTextFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

function ensureDirs() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  try {
    fs.mkdirSync(CODEX_HOME, { recursive: true });
    const src = readTextFile('/root/.codex/config.toml');
    if (src) {
      const cfg = src.replace(
        /^model_catalog_json\s*=.*$/m,
        'model_catalog_json = "' + CODEX_HOME + '/models.json"'
      );
      fs.writeFileSync(path.join(CODEX_HOME, 'config.toml'), cfg, { mode: 0o600 });
    }
    try { fs.copyFileSync('/root/.codex/models.json', path.join(CODEX_HOME, 'models.json')); } catch (e) {}
  } catch (/** @type {any} */ e) {
    console.error('prepare codex home failed:', e.message);
  }
}

/* ---------------- 线程存储 ---------------- */
/** @type {Record<string, ThreadRef>} */
let threads = {};
function loadThreads() {
  try { threads = JSON.parse(fs.readFileSync(THREAD_FILE, 'utf8')); } catch (e) { threads = {}; }
}
function saveThreads() {
  try {
    fs.writeFileSync(THREAD_FILE + '.tmp', JSON.stringify(threads, null, 2));
    fs.renameSync(THREAD_FILE + '.tmp', THREAD_FILE);
  } catch (e) {}
}

/* ---------------- 受限纯聊天存储 ---------------- */
const GUEST_CHAT_FILE = path.join(DATA_DIR, 'guest-chats.json');
/** @type {Record<string, GuestChat>} */
let guestChats = {};
function loadGuestChats() {
  try { guestChats = JSON.parse(fs.readFileSync(GUEST_CHAT_FILE, 'utf8')); } catch (e) { guestChats = {}; }
}
function saveGuestChats() {
  try {
    fs.writeFileSync(GUEST_CHAT_FILE + '.tmp', JSON.stringify(guestChats, null, 2));
    fs.renameSync(GUEST_CHAT_FILE + '.tmp', GUEST_CHAT_FILE);
  } catch (e) {}
}

/* ---------------- 今日运势缓存 ---------------- */
const FORTUNE_CACHE_FILE = path.join(DATA_DIR, 'fortune-cache.json');
/** @type {Record<string, Record<string, string>>} */
let fortuneCache = {};
function loadFortuneCache() {
  try { fortuneCache = JSON.parse(fs.readFileSync(FORTUNE_CACHE_FILE, 'utf8')); } catch (e) { fortuneCache = {}; }
}
function saveFortuneCache() {
  try {
    fs.writeFileSync(FORTUNE_CACHE_FILE + '.tmp', JSON.stringify(fortuneCache, null, 2));
    fs.renameSync(FORTUNE_CACHE_FILE + '.tmp', FORTUNE_CACHE_FILE);
  } catch (e) {}
}
// 实现在 lib/util.js（日期从外面传进去，便于测），这里保留原来的无参调用形式
function localDateKey() {
  return UTIL.localDateKey(new Date());
}

/* ---------------- 用户图片（只登记，不主动识别） ---------------- */
// 索引结构：{ seq: { 会话键: 已分配的最大编号 }, items: { 会话键: [条目] } }
/** @type {ImageIndex} */
let imageIndex = { seq: {}, items: {} };

function loadImageIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(IMAGE_INDEX_FILE, 'utf8'));
    imageIndex = {
      seq: (raw && raw.seq) || {},
      items: (raw && raw.items) || {},
    };
  } catch (e) {
    imageIndex = { seq: {}, items: {} };
  }
}

function saveImageIndex() {
  try {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    fs.writeFileSync(IMAGE_INDEX_FILE + '.tmp', JSON.stringify(imageIndex, null, 2));
    fs.renameSync(IMAGE_INDEX_FILE + '.tmp', IMAGE_INDEX_FILE);
  } catch (e) {
    writeLog('warn', '图片索引写入失败', { error: en(e) });
  }
}

// 下载单张图片到 .part，再按返回的 content-type 改名，避免扩展名写错
/**
 * @param {string} messageId
 * @param {string} imageKey
 * @param {string} partPath
 * @returns {Promise<string>} content-type
 */
function fetchImageToFile(messageId, imageKey, partPath) {
  return client.im.messageResource.get({
    params: { type: 'image' },
    path: { message_id: messageId, file_key: imageKey },
  }).then(function (res) {
    if (!res || typeof res.writeFile !== 'function') throw new Error('飞书未返回图片数据');
    return res.writeFile(partPath).then(function () {
      const headers = (res && res.headers) || {};
      return headers['content-type'] || headers['Content-Type'] || '';
    });
  });
}

/**
 * @param {string} key 会话键
 * @returns {void}
 */
function trimImageItems(key) {
  const list = imageIndex.items[key] || [];
  while (list.length > IMAGE_PER_KEY_LIMIT) {
    // 循环条件保证列非空，shift 不会返回 undefined
    const old = /** @type {ImageItem} */ (list.shift());
    try { fs.unlinkSync(path.join(IMAGE_DIR, old.file)); } catch (e) {}
  }
  imageIndex.items[key] = list;
}

// 连发图片时合并回执：同一会话 N 秒内的图片只回一条
/** @type {Record<string, { target: NotifyTarget, first: number, last: number, count: number }>} */
const pendingImageAck = {};
/** @type {Record<string, ReturnType<typeof setTimeout>>} */
const pendingImageAckTimer = {};

/**
 * @param {NotifyTarget} target
 * @param {string} key 会话键
 * @param {number} seq 本次分配的编号
 * @returns {void}
 */
function scheduleImageAck(target, key, seq) {
  const state = pendingImageAck[key] || { target: target, first: seq, last: seq, count: 0 };
  state.target = target;
  state.last = seq;
  state.count += 1;
  pendingImageAck[key] = state;
  if (pendingImageAckTimer[key]) return;
  pendingImageAckTimer[key] = setTimeout(function () {
    delete pendingImageAckTimer[key];
    const done = pendingImageAck[key];
    delete pendingImageAck[key];
    if (!done) return;
    const range = done.count > 1
      ? '第 ' + done.first + '-' + done.last + ' 张'
      : '第 ' + done.first + ' 张';
    deliver(done.target,
      '📷 已记录 ' + done.count + ' 张图片（' + range + '），暂不识别。\n'
      + '需要我看的时候说一声，例如：.c 看下第 ' + done.first + ' 张图');
  }, IMAGE_ACK_DELAY_MS);
}

// 登记一批图片：编号先按到达顺序分配，保证多张图序号稳定
/**
 * @param {any} message 飞书事件里的 message
 * @param {string[]} ids
 * @param {string} key 会话键
 * @param {NotifyTarget} target
 * @returns {void}
 */
function registerImages(message, ids, key, target) {
  const imageKeys = extractImageKeys(message);
  if (!imageKeys.length) return;
  const messageId = String(message.message_id || '');
  const chatId = String(message.chat_id || '');
  const day = localDateKey();
  const dayDir = path.join(IMAGE_DIR, day);
  try { fs.mkdirSync(dayDir, { recursive: true }); } catch (e) {}

  imageKeys.forEach(function (imageKey) {
    // 索引里存的是数字，parseInt 要字符串，先转一下（容错行为不变）
    const seq = (parseInt(String(imageIndex.seq[key]), 10) || 0) + 1;
    imageIndex.seq[key] = seq;
    const base = path.join(dayDir, imageKeySlug(key) + '_' + seq);
    const partPath = base + '.part';
    fetchImageToFile(messageId, imageKey, partPath).then(function (contentType) {
      const filePath = base + imageExtFromType(contentType);
      fs.renameSync(partPath, filePath);
      const stat = fs.statSync(filePath);
      const item = {
        n: seq,
        file: path.relative(IMAGE_DIR, filePath),
        messageId: messageId,
        imageKey: imageKey,
        openId: ids[0] || '',
        chatId: chatId,
        savedAt: Date.now(),
        bytes: stat.size,
      };
      (imageIndex.items[key] || (imageIndex.items[key] = [])).push(item);
      trimImageItems(key);
      saveImageIndex();
      scheduleImageAck(target, key, seq);
      writeLog('info', '已登记飞书图片', {
        key: key,
        n: seq,
        file: item.file,
        bytes: item.bytes,
      });
    }).catch(function (e) {
      try { fs.unlinkSync(partPath); } catch (e2) {}
      const detail = errText(e);
      writeLog('warn', '图片登记失败', { key: key, n: seq, error: detail });
      deliver(target, '这张图片我没取到（' + detail + '），麻烦重发一次或改用文字描述。');
    });
  });
}

// 交给 Codex 的图片上下文：只有编号、时间、路径，不含图片内容
/**
 * @param {string} key 会话键
 * @returns {string} 拼好的提示文本，没有图片返回空串
 */
function imageContextText(key) {
  const list = imageIndex.items[key] || [];
  if (!list.length) return '';
  const recent = list.slice(-10).map(function (it) {
    return '第' + it.n + '张 ' + imageStamp(it.savedAt) + ' ' + path.join(IMAGE_DIR, it.file);
  });
  return '（本会话已登记但未识别的图片共 ' + list.length + ' 张，最近 '
    + recent.length + ' 张如下；除非用户明确要求，不要读取图片内容）\n'
    + recent.join('\n');
}

// 清理：只删超出保留周期的图片，未过期的一律保留
/** @returns {number} 清理掉的条目数 */
function cleanupImages() {
  const cutoff = Date.now() - IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  /** @type {Record<string, ImageItem[]>} */
  const keptItems = {};
  /** @type {Record<string, boolean>} */
  const keptFiles = {};

  Object.keys(imageIndex.items).forEach(function (key) {
    /** @type {ImageItem[]} */
    const kept = [];
    (imageIndex.items[key] || []).forEach(function (it) {
      const filePath = path.join(IMAGE_DIR, String(it.file || ''));
      if (Number(it.savedAt) >= cutoff && fs.existsSync(filePath)) {
        kept.push(it);
        keptFiles[path.relative(IMAGE_DIR, filePath)] = true;
      } else {
        try { fs.unlinkSync(filePath); } catch (e) {}
        removed++;
      }
    });
    if (kept.length) keptItems[key] = kept;
  });
  imageIndex.items = keptItems;

  // 兜底：清掉索引之外的历史文件（比如下载中断的 .part），未过期的跳过
  /** @type {string[]} */
  let dayDirs = [];
  try { dayDirs = fs.readdirSync(IMAGE_DIR); } catch (e) { dayDirs = []; }
  dayDirs.forEach(function (name) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return;
    const dirPath = path.join(IMAGE_DIR, name);
    let files = [];
    try { files = fs.readdirSync(dirPath); } catch (e) { return; }
    files.forEach(function (file) {
      const rel = name + '/' + file;
      if (keptFiles[rel]) return;
      const filePath = path.join(dirPath, file);
      let stat = null;
      try { stat = fs.statSync(filePath); } catch (e) { return; }
      if (!stat.isFile() || stat.mtimeMs >= cutoff) return;
      try { fs.unlinkSync(filePath); } catch (e) { return; }
      removed++;
    });
    try {
      if (!fs.readdirSync(dirPath).length) fs.rmdirSync(dirPath);
    } catch (e) {}
  });

  if (removed) {
    saveImageIndex();
    writeLog('info', '清理超期图片', { removed: removed, retentionDays: IMAGE_RETENTION_DAYS });
  }
  return removed;
}

/* ---------------- 日志上报 ---------------- */
/**
 * @param {string} level info / warn / error / debug
 * @param {string} message
 * @param {Record<string, any>} [meta]
 * @returns {void}
 */
function writeLog(level, message, meta) {
  const payload = JSON.stringify({
    source: 'feishu-bot',
    level: level,
    message: message,
    meta: meta || {},
  });
  try {
    const u = new URL(LOG_ENDPOINT);
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      }, LOG_TOKEN ? { 'X-Log-Token': LOG_TOKEN } : {}),
    }, function (res) { res.resume(); });
    req.on('error', function () {});
    req.end(payload);
  } catch (e) {}
}

/* ---------------- 健康时间线 ---------------- */
const HEALTH_LOG = ENV.FEISHU_HEALTH_LOG || '/var/log/feishu-bot-health.log';

/** @returns {string} 带时区偏移的本地时间戳 */
function healthTs() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  /** @param {number} n */
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    + (off >= 0 ? '+' : '-') + p(Math.floor(Math.abs(off) / 60)) + p(Math.abs(off) % 60);
}

/**
 * @param {string} message
 * @param {Record<string, any>} [meta]
 * @returns {void}
 */
function healthLog(message, meta) {
  try {
    const line = healthTs() + ' ' + message
      + (meta && Object.keys(meta).length ? ' | ' + JSON.stringify(meta) : '') + '\n';
    fs.appendFileSync(HEALTH_LOG, line);
  } catch (e) {}
}

/* ---------------- 飞书客户端 ---------------- */
// 凭据缺失时也要能启动（--check 模式 / 回报配置问题），因此这里用占位值，
// 真正缺凭据时会在启动流程里以 EX_CONFIG(78) 退出，不会真的去调飞书接口。
const client = new lark.Client({
  appId: APP_ID || 'cli_0000000000000000',
  appSecret: APP_SECRET || 'unconfigured',
  domain: LARK_DOMAIN,
  loggerLevel: lark.LoggerLevel.warn,
});

/* ---------------- 发送队列（串行 + 限速） ---------------- */
/** @type {Array<() => Promise<any>>} */
const sendQueue = [];
let sendPumping = false;

/**
 * @param {() => Promise<any>} job
 * @returns {void}
 */
function enqueueSend(job) {
  sendQueue.push(job);
  pumpSendQueue();
}

async function pumpSendQueue() {
  if (sendPumping) return;
  sendPumping = true;
  while (sendQueue.length) {
    // 循环条件保证队列非空
    const job = /** @type {() => Promise<any>} */ (sendQueue.shift());
    try { await job(); } catch (e) {}
    if (sendQueue.length) await sleep(300);
  }
  sendPumping = false;
}

/**
 * @param {string} chatId
 * @param {string} text
 * @returns {Promise<any>}
 */
async function sendTextToChat(chatId, text) {
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: String(text) }),
    },
  });
}

/**
 * @param {string} openId
 * @param {string} text
 * @returns {Promise<any>}
 */
async function sendTextToUser(openId, text) {
  await client.im.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text: String(text) }),
    },
  });
}

/**
 * @param {string} messageId
 * @param {string} text
 * @returns {Promise<any>}
 */
async function replyText(messageId, text) {
  await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'text',
      content: JSON.stringify({ text: String(text) }),
    },
  });
}

/* ---------------- 图片发送 ---------------- */
// 上传到飞书换取 image_key（需要 im:resource 权限）
/**
 * @param {string} filePath
 * @returns {Promise<string>} image_key
 */
async function uploadImage(filePath) {
  const res = await client.im.image.create({
    data: {
      image_type: 'message',
      image: fs.createReadStream(filePath),
    },
  });
  // 注意：上传图片接口的返回体是 { image_key }，不像其他接口包在 data 里
  // SDK 的类型声明只覆盖了 { image_key } 这一种，但线上见过别的形状，
  // 所以这里按 unknown 处理，几种都兜一下
  const raw = /** @type {any} */ (res);
  const key = (raw && (raw.image_key || (raw.data && raw.data.image_key))) || '';
  if (!key) throw new Error((raw && (raw.msg || raw.message)) || '上传图片未返回 image_key');
  return key;
}

/**
 * @param {NotifyTarget} target
 * @param {string} imageKey
 * @returns {Promise<void>}
 */
async function sendImageToTarget(target, imageKey) {
  const content = JSON.stringify({ image_key: imageKey });
  if (target.kind === 'reply') {
    await client.im.message.reply({
      path: { message_id: target.id },
      data: { msg_type: 'image', content: content },
    });
  } else if (target.kind === 'chat') {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: target.id, msg_type: 'image', content: content },
    });
  } else {
    await client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: target.id, msg_type: 'image', content: content },
    });
  }
}

// 发送本地图片；失败只记日志，不影响已经发出的文字
/**
 * @param {NotifyTarget} target
 * @param {string} filePath
 * @returns {void}
 */
function deliverImage(target, filePath) {
  if (!filePath) return;
  enqueueSend(async function () {
    if (DRY_RUN) {
      console.log('[dry-run] → image ' + target.kind + ':' + target.id + ' ' + path.basename(filePath));
      return;
    }
    try {
      const key = await uploadImage(filePath);
      await sendImageToTarget(target, key);
      writeLog('info', '图片已发送', {
        kind: target.kind,
        id: target.id,
        file: path.basename(filePath),
      });
    } catch (e) {
      const detail = errText(e);
      console.error('发送图片失败：' + detail);
      writeLog('warn', '发送图片失败', { file: path.basename(filePath), error: detail });
    }
  });
}

// target: { kind: 'reply'|'chat'|'user', id }
/**
 * @param {NotifyTarget} target
 * @param {string} text
 * @returns {void}
 */
function deliver(target, text) {
  const chunks = chunkText(text, 3000).filter(function (c) { return c.length; });
  if (!chunks.length) return;
  enqueueSend(async function () {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (DRY_RUN) {
        console.log('[dry-run] → ' + target.kind + ':' + target.id + '\n' + chunk);
        continue;
      }
      try {
        if (target.kind === 'reply') await replyText(target.id, chunk);
        else if (target.kind === 'chat') await sendTextToChat(target.id, chunk);
        else await sendTextToUser(target.id, chunk);
      } catch (e) {
        const detail = errText(e);
        console.error('飞书发送失败（' + target.kind + ':' + target.id + '）：' + detail);
        writeLog('warn', '飞书发送失败', {
          kind: target.kind,
          id: target.id,
          error: detail,
          chunk: i + 1,
          total: chunks.length,
        });
        // 回复失败时退化为按会话直发，避免消息丢失
        if (target.kind === 'reply' && target.fallbackChatId) {
          try { await sendTextToChat(target.fallbackChatId, chunk); } catch (e2) {}
        } else {
          break;
        }
      }
      // 长消息分片之间留一点间隔，避免触发飞书发送频率限制
      if (i + 1 < chunks.length) await sleep(300);
    }
  });
}

/* ---------------- 身份与白名单 ---------------- */
// 生活数据主键：优先用映射（可继续沿用 QQ 时代的数据），否则用飞书 open_id。
// 纯逻辑在 lib/identity.js，这里把运行期的映射表传进去。
/**
 * @param {string[]} ids
 * @returns {string} 生活数据主键
 */
function lifeKey(ids) {
  return IDENT.lifeKey(ids, LIFE_KEY_MAP);
}

/**
 * @param {string[]} ids
 * @returns {string} 飞书身份
 */
function primaryId(ids) {
  return IDENT.primaryId(ids, LEGACY_TO_FEISHU);
}

/* ---------------- 消息解析 ---------------- */
const seenMessages = new Map();
/**
 * @param {unknown} messageId
 * @returns {boolean} 是否重复（首次见到会记录下来）
 */
function isDuplicate(messageId) {
  const id = String(messageId || '');
  if (!id) return false;
  const now = Date.now();
  if (seenMessages.has(id)) return true;
  seenMessages.set(id, now);
  if (seenMessages.size > 800) {
    seenMessages.forEach(function (ts, key) {
      if (now - ts > 10 * 60 * 1000) seenMessages.delete(key);
    });
  }
  return false;
}

const IMAGE_HINT = '我现在只能读文字和图片：图片会先存下来登记，等你说要看时我才读；'
  + '文件/语音这类消息麻烦改成文字描述一下。';

/**
 * @param {any} message
 * @returns {boolean}
 */
function mentionIsBot(message) {
  return IDENT.mentionIsBot(message, BOT_OPEN_ID, BOT_NAME);
}

/* ---------------- 消息处理 ---------------- */
/**
 * 处理一条飞书事件：去重 → 权限 → 指令分发 → Codex / 生活指令
 * @param {any} data 事件体（{ sender, message }）
 * @returns {void}
 */
function handleMessage(data) {
  const message = (data && data.message) || {};
  const sender = (data && data.sender) || {};
  const messageId = String(message.message_id || '');
  if (isDuplicate(messageId)) return;
  if (String(sender.sender_type || '') === 'app') return;

  const ids = senderIds(sender);
  if (!ids.length) return;
  const chatType = String(message.chat_type || 'p2p');
  const isGroup = chatType !== 'p2p';
  const chatId = String(message.chat_id || '');

  // 群聊：仅响应被 @ 的消息
  if (isGroup && !mentionIsBot(message)) return;

  // 白名单：未配置任何白名单时，不执行任何操作，只回报身份，方便首次接入
  const allowed = isGroup ? matches(ALLOW_CHATS, [chatId].concat(ids)) : matches(ALLOW_USERS, ids);
  if (!allowed) {
    if (!ALLOW_USERS.length && !ALLOW_CHATS.length) {
      console.log('白名单为空，回报身份供首次接入：open_id=' + (ids[0] || '')
        + ' user_id=' + (ids[1] || '') + (chatId ? ' chat_id=' + chatId : ''));
      const reply = '尚未配置飞书白名单，我不会执行任何操作。\n' +
        '你的 open_id：' + (ids[0] || '') + '\n' +
        (ids[1] ? '你的 user_id：' + ids[1] + '\n' : '') +
        (isGroup && chatId ? '当前 chat_id：' + chatId + '\n' : '') +
        '把这行填进 /etc/feishu-bot.env 的 FEISHU_ALLOW_USERS，然后 systemctl restart feishu-bot。';
      deliver({ kind: 'reply', id: messageId, fallbackChatId: chatId }, reply);
      writeLog('warn', '收到未授权消息（白名单为空）', { openId: ids[0], userId: ids[1] || '', chatId: chatId });
      return;
    }
    writeLog('warn', '忽略未授权消息', { openId: ids[0], userId: ids[1] || '', chatId: chatId, group: isGroup });
    return;
  }

  const rawText = extractText(message);
  const messageType = String(message.message_type || '');
  /** @type {NotifyTarget} */
  const replyTarget = { kind: 'reply', id: messageId, fallbackChatId: chatId };
  const restricted = matches(RESTRICTED_USERS, ids);
  const key = isGroup ? 'g:' + chatId + ':' + ids[0] : 'p:' + ids[0];
  const imageKeys = extractImageKeys(message);

  // 图片：先落盘登记，不识别；用户明确要求时才交给 Codex 读
  if (imageKeys.length) {
    if (restricted) {
      deliver(replyTarget, '图片需要 Codex 才能看，当前账号是受限账号，只能纯文字聊天。');
      return;
    }
    registerImages(message, ids, key, replyTarget);
    if (!rawText.trim()) return;
    // 图文混排（富文本）时继续按文字走，图片已在后台登记
  } else if (!rawText.trim() && messageType !== 'text' && messageType !== 'post') {
    deliver(replyTarget, IMAGE_HINT);
    return;
  }

  let text = stripMentionKeys(rawText, message.mentions).trim();
  if (!text) {
    deliver({ kind: 'reply', id: messageId, fallbackChatId: chatId }, botHelp(false));
    return;
  }
  if (text.length > 4000) {
    deliver({ kind: 'reply', id: messageId, fallbackChatId: chatId }, '消息太长，请控制在 4000 字以内。');
    return;
  }
  if (text.charAt(0) === '。') text = '.' + text.slice(1);

  const life = lifeKey(ids);

  const codexPrompt = extractCodexPrompt(text);
  if (codexPrompt !== null) {
    if (!codexPrompt) {
      deliver(replyTarget, '用法：.c 你的需求 / .codex 你的需求');
      return;
    }
    startCodexTask(replyTarget, ids, key, life, restricted, codexPrompt);
    return;
  }
  // 中文别名：帮助 / 塔罗牌 / 今日运势 / 骰子 不写前缀也能用
  if (/^(?:\.help|help|帮助|菜单|指令)$/i.test(text)) {
    deliver(replyTarget, botHelp(restricted));
    return;
  }
  if (/^(?:\.(?:rand|r)|骰子|掷骰子?|投骰子?)(?:\s|$)/i.test(text)) {
    deliver(replyTarget, rollDiceText(text));
    return;
  }
  if (/^(?:\.(?:tarot|t)|塔罗|塔罗牌|抽塔罗|抽牌)$/i.test(text)) {
    if (!LIFE_ENABLED) deliver(replyTarget, NEED_LIFE_APP);
    else sendTarot(replyTarget);
    return;
  }
  if (/^(?:\.fortune|\.f|运势|今日运势|今日运程|今日运气)$/i.test(text)) {
    if (!LIFE_ENABLED) deliver(replyTarget, NEED_LIFE_APP);
    else startFortuneCommand(replyTarget, ids, key, life, restricted);
    return;
  }
  // 单次提醒只在这里看：监控页已经不下发，避免任务内容（含卡号卡密这类）公开
  if (isOnceTasksCommand(text)) {
    if (restricted) {
      deliver(replyTarget, '⚠️ 受限账号不能查看任务。');
      return;
    }
    if (!SCHED_ONCE_ENABLED) {
      deliver(replyTarget, NEED_SCHEDULER_APP);
      return;
    }
    let tasks = [];
    try {
      tasks = SCHED_ONCE.readOnceTasks(ONCE_TASKS_DIR);
    } catch (/** @type {any} */ e) {
      deliver(replyTarget, '单次提醒读取失败：' + errText(e));
      writeLog('warn', '单次提醒读取失败', { openId: ids[0], error: errText(e) });
      return;
    }
    writeLog('info', '查询单次提醒', { openId: ids[0], group: isGroup, count: tasks.length });
    deliver(replyTarget, onceTasksText(tasks, Date.now()));
    return;
  }

  // 服务器类指令：状态 / 用量 / 定时器。走本地脚本与本地接口，不经过模型，
  // 也不给受限账号——服务器内部信息只给白名单账号看
  if (isStatusCommand(text) || isUsageCommand(text) || isTimersCommand(text)) {
    if (restricted) {
      deliver(replyTarget, '⚠️ 受限账号不能查看服务器信息。');
      return;
    }
    const onFail = function (/** @type {any} */ e) {
      writeLog('warn', '服务器指令执行失败', { openId: ids[0], error: errText(e) });
      deliver(replyTarget, '查询失败：' + errText(e));
    };
    if (isStatusCommand(text)) { statusCommand(replyTarget, ids).catch(onFail); return; }
    if (isUsageCommand(text)) { usageCommand(replyTarget, ids).catch(onFail); return; }
    timersCommand(replyTarget, ids).catch(onFail);
    return;
  }

  if (LIFE_ENABLED) {
    try {
      const lifeReply = LIFE_ACTIONS.handle(text, life);
      if (lifeReply) {
        writeLog('info', '生活指令已处理', {
          openId: ids[0],
          lifeKey: life,
          group: isGroup,
          action: text.slice(0, 60),
        });
        deliver(replyTarget, lifeReply);
        return;
      }
    } catch (/** @type {any} */ e) {
      deliver(replyTarget, '生活指令处理失败：' + (e && e.message ? e.message : String(e)));
      return;
    }
  }

  deliver(replyTarget, botHelp(restricted));
}

/**
 * @param {any} [card] 不传就现抽一张
 * @returns {string}
 */
function tarotText(card) {
  const c = card || LIFE_FORTUNE.pickTarot();
  const meaning = c.reversed ? c.rev : c.up;
  return '🃏 塔罗牌：' + c.display +
    '\n解读：' + meaning +
    '\n\n今天的建议：围绕“' + (c.reversed ? '先想清楚再行动' : '顺势推进') + '”，保持轻松心态。';
}

// 抽牌：先回文字（牌名 + 解读），再把牌面图片发过去
/**
 * @param {NotifyTarget} target
 * @returns {void}
 */
function sendTarot(target) {
  const card = LIFE_FORTUNE.pickTarot();
  deliver(target, tarotText(card));
  if (!TAROT_IMAGE_ENABLED) return;
  TAROT_IMAGE.getTarotImage({
    index: card.index,
    reversed: card.reversed,
    cacheDir: TAROT_CACHE_DIR,
    log: /** @param {string} msg */ function (msg) { writeLog('info', '塔罗牌面', { message: msg }); },
  }).then(function (file) {
    if (file) {
      deliverImage(target, file);
    } else {
      writeLog('warn', '本次未取到塔罗牌面，只回文字', { card: card.name });
    }
  }).catch(function (e) {
    writeLog('warn', '塔罗牌面异常', { error: e && e.message ? e.message : String(e) });
  });
}

/**
 * @param {NotifyTarget} target
 * @param {string[]} ids
 * @param {string} key 会话键
 * @param {string} life 生活数据主键
 * @param {boolean} restricted
 * @returns {void}
 */
function startFortuneCommand(target, ids, key, life, restricted) {
  const date = localDateKey();
  const cached = fortuneCache[date] && fortuneCache[date][life];
  if (cached) {
    deliver(target, '📅 ' + date + ' 今日运势（今日已算，直接返回）\n\n' + cached);
    return;
  }
  if (restricted) {
    deliver(target, '今日运势需要 Codex 计算，受限账号请使用 .c 今天运势。');
    return;
  }
  if (activeCount >= MAX_ACTIVE || active.has(key)) {
    deliver(target, '当前有任务处理中，请稍后再试。');
    return;
  }
  const fortuneKey = 'fortune:' + life;
  threads[fortuneKey] = { threadId: null };
  active.add(key);
  activeCount++;
  deliver(target, '正在用 Codex 计算今日运势，请稍候…');
  const profile = LIFE_PROFILE.getPersonalProfile();
  const birth = LIFE_PROFILE.birthText(profile);
  const prompt =
    '今天是 ' + date + '。' +
    (birth ? '用户出生信息：' + birth + '。' : '') +
    '请计算今日运势，输出简体中文，包含综合运势、事业/学习、感情、健康、幸运色与幸运数字，语气温和务实，不超过 200 字。';
  runCodex(target, fortuneKey, prompt, /** @param {string} text */ function (text) {
    if (text) {
      if (!fortuneCache[date]) fortuneCache[date] = {};
      fortuneCache[date][life] = text;
      saveFortuneCache();
      writeLog('info', '今日运势已缓存', { lifeKey: life, date: date });
    }
  }, true).finally(function () {
    active.delete(key);
    activeCount = Math.max(0, activeCount - 1);
  });
}

/**
 * @param {NotifyTarget} target
 * @param {string[]} ids
 * @param {string} key 会话键
 * @param {string} life 生活数据主键
 * @param {boolean} restricted
 * @param {string} prompt
 * @returns {void}
 */
function startCodexTask(target, ids, key, life, restricted, prompt) {
  writeLog('info', '收到飞书消息', {
    openId: ids[0],
    userId: ids[1] || '',
    lifeKey: life,
    restricted: restricted,
    text: prompt.slice(0, 1000),
  });
  if (activeCount >= MAX_ACTIVE) {
    deliver(target, '当前 Codex 任务较多，请稍后再发。');
    return;
  }
  if (active.has(key)) {
    deliver(target, '上一条还在处理中，请稍候。');
    return;
  }
  active.add(key);
  activeCount++;
  deliver(target, restricted ? '已收到，思考中…' : '已收到，Codex 处理中…');
  writeLog('info', restricted ? '开始受限纯聊天' : '开始调用 Codex', {
    key: key,
    thread: (threads[key] || {}).threadId || null,
    restricted: restricted,
  });
  // 图片只给编号与路径，读不读由用户指令决定（PROMPT_TAIL 里已固化该规则）
  const imageContext = restricted ? '' : imageContextText(key);
  const codexPrompt = imageContext ? imageContext + '\n\n' + prompt : prompt;
  const task = restricted ? runGuestChat(target, key, prompt) : runCodex(target, key, codexPrompt);
  task.finally(function () {
    active.delete(key);
    activeCount = Math.max(0, activeCount - 1);
  });
}

/* ---------------- 受限纯聊天（不执行系统命令） ---------------- */
/**
 * @param {ChatMessage[]} history
 * @returns {any} 发给模型接口的请求体
 */
function buildGuestPayload(history) {
  const sys = { role: 'system', content: [{ type: 'input_text', text: GUEST_PROMPT_TAIL }] };
  const mapped = history.map(/** @param {ChatMessage} m */ function (m) {
    const isAssistant = m.role === 'assistant';
    return {
      role: isAssistant ? 'assistant' : 'user',
      content: [{ type: isAssistant ? 'output_text' : 'input_text', text: String(m.content || '') }],
    };
  });
  return {
    model: GUEST_MODEL,
    input: [sys].concat(mapped),
    max_output_tokens: 4096,
    stream: false,
  };
}

/**
 * @param {any} payload
 * @returns {Promise<any>} 模型返回体
 */
function requestGuestCompletion(payload) {
  return new Promise(function (resolve, reject) {
    if (!GUEST_API_BASE || !GUEST_API_KEY || !GUEST_MODEL) {
      reject(new Error('受限聊天模型参数未配置'));
      return;
    }
    let u;
    try { u = new URL(GUEST_API_BASE); } catch (e) {
      reject(new Error('模型服务地址无效'));
      return;
    }
    const useTls = u.protocol === 'https:';
    const mod = useTls ? https : http;
    const reqPath = u.pathname.replace(/\/+$/, '') + '/responses';
    const body = JSON.stringify(payload);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (useTls ? 443 : 80),
      path: reqPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GUEST_API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 300000,
    }, function (resp) {
      let data = '';
      resp.setEncoding('utf8');
      resp.on('data', function (c) {
        data += c;
        if (data.length > 4194304) req.destroy(new Error('模型返回内容过大'));
      });
      resp.on('end', function () {
        // statusCode 在类型上是 number | undefined，这里取一次并给个兜底
        const status = resp.statusCode || 0;
        if (status < 200 || status >= 300) {
          let detail = data;
          try {
            const j = JSON.parse(data);
            if (j.error && j.error.message) detail = j.error.message;
          } catch (e) {}
          reject(new Error('模型服务错误（HTTP ' + status + '）：' + String(detail).slice(0, 300)));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('模型返回无法解析')); }
      });
    });
    req.on('timeout', function () { req.destroy(new Error('模型响应超时')); });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * @param {NotifyTarget} target
 * @param {string} key 会话键
 * @param {string} prompt
 * @returns {Promise<void>}
 */
function runGuestChat(target, key, prompt) {
  return new Promise(function (resolve) {
    const chat = guestChats[key] || { history: [] };
    chat.history.push({ role: 'user', content: prompt });
    if (chat.history.length > 40) chat.history = chat.history.slice(-40);
    requestGuestCompletion(buildGuestPayload(chat.history)).then(function (data) {
      const text = extractGuestText(data);
      if (!text) throw new Error('模型没有返回文字内容');
      chat.history.push({ role: 'assistant', content: text });
      if (chat.history.length > 40) chat.history = chat.history.slice(-40);
      guestChats[key] = chat;
      saveGuestChats();
      deliver(target, text);
      writeLog('info', '受限聊天完成', { key: key, textLength: text.length });
    }).catch(function (err) {
      if (chat.history.length && chat.history[chat.history.length - 1].role === 'user') chat.history.pop();
      const reason = err && err.message ? err.message : '未知错误';
      deliver(target, '抱歉，回复失败：' + reason);
      writeLog('warn', '受限聊天失败', { key: key, error: reason });
    }).then(function () { resolve(); });
  });
}

/* ---------------- Codex ---------------- */
const active = new Set();
let activeCount = 0;

/**
 * @param {NotifyTarget} target
 * @param {string} key 会话键
 * @param {string} prompt
 * @param {(text: string) => void} [onText] 拿到本轮文本时的回调（用于缓存运势）
 * @param {boolean} [fresh] 为真时开新会话，不续用已有 thread
 * @returns {Promise<void>}
 */
function runCodex(target, key, prompt, onText, fresh) {
  return new Promise(function (resolve) {
    const threadId = fresh ? null : (threads[key] || {}).threadId || null;
    const codexPrompt = PROMPT_TAIL + '\n\n' + prompt;
    const args = [];
    if (threadId) {
      args.push('exec', '--json', '--skip-git-repo-check', FULL_AUTO_ARG, '-C', WORKSPACE, 'resume', threadId, '--', codexPrompt);
    } else {
      args.push('exec', '--json', '--skip-git-repo-check', FULL_AUTO_ARG, '-C', WORKSPACE, '--', codexPrompt);
    }

    /** @type {import('child_process').ChildProcess} */
    let child;
    try {
      child = spawn(CODEX_BIN, args, {
        cwd: WORKSPACE,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, {
          CODEX_HOME: CODEX_HOME,
          HOME: ENV.HOME || '/root',
          NO_COLOR: '1',
        }),
      });
    } catch (/** @type {any} */ e) {
      deliver(target, '无法启动 Codex：' + e.message);
      writeLog('error', 'Codex 启动失败', { error: e.message });
      resolve();
      return;
    }

    let buf = '';
    let stderrBuf = '';
    let stderrTail = '';
    /** @type {string[]} */
    let agentParts = [];
    let done = false;
    let finished = false;
    let currentThread = threadId;
    const timer = setTimeout(function () { killChild('处理超时'); }, TURN_TIMEOUT * 1000);

    /** @param {string} [reason] */
    function killChild(reason) {
      if (finished) return;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch (e) {}
      try { child.kill('SIGKILL'); } catch (e) {}
      if (!done) {
        deliver(target, reason || 'Codex 处理超时，已停止。');
        writeLog('warn', 'Codex 被终止', { reason: reason || 'timeout' });
      }
      done = true;
      agentParts = [];
      finish();
    }

    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (done && agentParts.length) {
        const text = agentParts.join('\n\n').trim();
        if (typeof onText === 'function') onText(text);
        deliver(target, text || '（本轮没有文本回复）');
        writeLog('info', '回复飞书消息', { textLength: text.length });
      } else if (done && !agentParts.length) {
        deliver(target, '（本轮没有文本回复）');
      }
      resolve();
    }

    /** @param {string} line */
    function handleLine(line) {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch (e) {
        writeLog('debug', 'Codex stdout', {
          key: key,
          thread: currentThread || threadId || null,
          stream: 'stdout',
          text: line,
        });
        return;
      }
      switch (ev.type) {
        case 'thread.started':
          if (ev.thread_id) {
            currentThread = ev.thread_id;
            threads[key] = { threadId: ev.thread_id, updatedAt: Date.now() };
            saveThreads();
          }
          break;
        case 'item.completed': {
          const item = ev.item || {};
          if (item.type === 'agent_message' && item.text) agentParts.push(item.text);
          break;
        }
        case 'turn.completed':
          done = true;
          writeLog('info', 'Codex 回合完成', {
            key: key,
            usage: ev.usage || {},
            textLength: agentParts.join('\n\n').length,
          });
          finish();
          break;
        default:
          break;
      }
      /** @type {Record<string, any>} */
      const logMeta = { key: key, thread: currentThread || threadId || null, type: ev.type };
      if (ev.item && typeof ev.item === 'object') {
        logMeta.itemType = ev.item.type || '';
        logMeta.item = ev.item;
      }
      if (ev.usage) logMeta.usage = ev.usage;
      writeLog('debug', 'Codex 输出', logMeta);
    }

    /** @param {string} text */
    function logStderrLine(text) {
      const t = String(text || '').trim();
      if (!t) return;
      writeLog('debug', 'Codex stderr', {
        key: key,
        thread: currentThread || threadId || null,
        stream: 'stderr',
        text: t,
      });
    }

    // stdio 里 stdout/stderr 都指定了 pipe，不会是 null，标注一下
    const childStdout = /** @type {import('stream').Readable} */ (child.stdout);
    const childStderr = /** @type {import('stream').Readable} */ (child.stderr);
    childStdout.on('data', function (chunk) {
      buf += String(chunk);
      const lines = buf.split('\n');
      // split 至少返回一个元素，pop 不会是 undefined，类型上标一下
      buf = /** @type {string} */ (lines.pop());
      lines.forEach(handleLine);
    });
    childStderr.on('data', function (chunk) {
      const text = String(chunk);
      stderrTail = (stderrTail + text).slice(-600);
      stderrBuf += text;
      const lines = stderrBuf.split('\n');
      stderrBuf = /** @type {string} */ (lines.pop());
      lines.forEach(logStderrLine);
    });
    child.on('error', function (err) {
      if (!done) {
        deliver(target, 'Codex 进程异常：' + err.message);
        writeLog('error', 'Codex 进程错误', { error: err.message });
      }
      finish();
    });
    child.on('close', function (code, signal) {
      if (buf.trim()) {
        const last = buf;
        buf = '';
        handleLine(last);
      }
      if (stderrBuf.trim()) {
        logStderrLine(stderrBuf);
        stderrBuf = '';
      }
      if (done || finished) return;
      if (code === 0 && agentParts.length) {
        done = true;
        finish();
        return;
      }
      const detail = stderrTail.trim().slice(-300);
      deliver(target, 'Codex 未正常完成（code=' + code + (signal ? ', signal=' + signal : '') + '）：' + detail);
      writeLog('error', 'Codex 退出异常', { code: code, signal: signal || '', stderr: detail });
      finish();
    });
  });
}

/* ---------------- 内部通知接口（供定时任务使用） ---------------- */
let lastEventInfo = null;

/**
 * @param {any} body 通知请求体
 * @returns {NotifyTarget|null}
 */
function resolveNotifyTarget(body) {
  return IDENT.resolveNotifyTarget(body, LEGACY_TO_FEISHU, NOTIFY_USER);
}

function startInternalNotifyServer() {
  const server = http.createServer(function (req, res) {
    /**
     * @param {number} status
     * @param {any} obj
     * @returns {void}
     */
    function reply(status, obj) {
      const body = JSON.stringify(obj);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    }
    const u = new URL(req.url || '/', 'http://localhost');
    if (req.method !== 'POST' || u.pathname !== '/internal/notify') {
      reply(404, { error: '接口不存在' });
      return;
    }
    if (NOTIFY_TOKEN && !tokenEqual(String(req.headers['x-notify-token'] || ''), NOTIFY_TOKEN)) {
      reply(401, { error: '通知令牌无效' });
      return;
    }
    let data = '';
    req.on('data', function (c) {
      data += String(c);
      if (data.length > 256 * 1024) req.destroy();
    });
    req.on('end', function () {
      /** @type {any} */
      let body = {};
      try { body = JSON.parse(data || '{}'); } catch (e) {}
      const text = String(body.text || '').trim();
      if (!text) {
        reply(400, { error: '缺少 text' });
        return;
      }
      const target = resolveNotifyTarget(body);
      if (!target) {
        reply(503, { error: '没有可用的飞书接收人（请配置 FEISHU_NOTIFY_USER）' });
        return;
      }
      deliver(target, text);
      writeLog('info', '内部通知已发送', { length: text.length, target: target.label, kind: target.kind });
      reply(200, { ok: true });
    });
    req.on('error', function () {});
  });
  server.listen(INTERNAL_PORT, INTERNAL_HOST, function () {
    console.log('internal notify listening on http://' + INTERNAL_HOST + ':' + INTERNAL_PORT);
  });
  server.on('error', function (e) {
    console.error('内部通知接口启动失败：' + e.message);
    writeLog('error', '内部通知接口启动失败', { error: e.message, port: INTERNAL_PORT });
  });
}

/* ---------------- 长连接 ---------------- */
let wsClient = null;
let readyNotified = false;

function startLongConnection() {
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': function (data) {
      try {
        handleMessage(data);
      } catch (/** @type {any} */ e) {
        writeLog('error', '消息处理异常', { error: e && e.message ? e.message : String(e) });
        healthLog('feishu-bot: 消息处理异常', { error: en(e) });
      }
      return Promise.resolve();
    },
  });

  wsClient = new lark.WSClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    domain: LARK_DOMAIN,
    loggerLevel: lark.LoggerLevel.warn,
    autoReconnect: true,
    onReady: function () {
      console.log('飞书长连接已就绪');
      lastEventInfo = { type: 'ready', at: Date.now() };
      healthLog('feishu-bot: 长连接就绪', { appId: APP_ID });
      writeLog('info', '飞书长连接已就绪', { appId: APP_ID });
      if (!readyNotified && NOTIFY_USER) {
        readyNotified = true;
        setTimeout(function () {
          deliver({ kind: 'user', id: NOTIFY_USER }, '✅ feishu-bot 启动完成，已上线。');
        }, 1000);
      }
    },
    onReconnecting: function () {
      healthLog('feishu-bot: 长连接重连中', {});
      writeLog('warn', '飞书长连接重连中', {});
    },
    onReconnected: function () {
      healthLog('feishu-bot: 长连接已重连', {});
      writeLog('info', '飞书长连接已重连', {});
    },
    onError: function (err) {
      const msg = errText(err);
      lastEventInfo = { type: 'error', reason: msg, at: Date.now() };
      healthLog('feishu-bot: 长连接错误', { error: msg });
      writeLog('error', '飞书长连接错误', { error: msg });
    },
  });

  wsClient.start({ eventDispatcher: dispatcher }).catch(function (e) {
    const msg = errText(e);
    healthLog('feishu-bot: 长连接启动失败', { error: msg });
    writeLog('error', '飞书长连接启动失败', { error: msg });
  });
}

/**
 * @param {any} e
 * @returns {string}
 */
function en(e) {
  return (e && e.message) ? e.message : String(e);
}

/* ---------------- 启动 ---------------- */
const CHECK_ONLY = process.argv.indexOf('--check') >= 0;

function configProblems() {
  const problems = [];
  if (!APP_ID) problems.push('缺少 FEISHU_APP_ID');
  if (!APP_SECRET) problems.push('缺少 FEISHU_APP_SECRET');
  if (!NOTIFY_USER) problems.push('未配置 FEISHU_NOTIFY_USER（启动通知与默认推送收件人）');
  if (!ALLOW_USERS.length && !ALLOW_CHATS.length) problems.push('未配置 FEISHU_ALLOW_USERS / FEISHU_ALLOW_CHATS（当前不会响应任何消息）');
  return problems;
}

if (CHECK_ONLY) {
  const problems = configProblems();
  console.log('feishu-bot 配置检查');
  console.log('  appId      : ' + (APP_ID ? APP_ID : '（缺失）'));
  console.log('  appSecret  : ' + (APP_SECRET ? '已配置' : '（缺失）'));
  console.log('  域名       : ' + DOMAIN_NAME);
  console.log('  白名单用户 : ' + (ALLOW_USERS.join(', ') || '（空）'));
  console.log('  白名单群聊 : ' + (ALLOW_CHATS.join(', ') || '（空）'));
  console.log('  受限用户   : ' + (RESTRICTED_USERS.join(', ') || '（空）'));
  console.log('  默认收件人 : ' + (NOTIFY_USER || '（空）'));
  console.log('  Codex HOME : ' + CODEX_HOME);
  console.log('  数据目录   : ' + DATA_DIR);
  console.log('  图片目录   : ' + IMAGE_DIR + '（保留 ' + IMAGE_RETENTION_DAYS + ' 天）');
  console.log('  单次提醒   : ' + (SCHED_ONCE_ENABLED ? ONCE_TASKS_DIR : '未找到 scheduler-app（「任务」查询停用）'));
  console.log('  内部通知   : http://' + INTERNAL_HOST + ':' + INTERNAL_PORT + '/internal/notify');
  console.log('  生活键映射 : ' + (Object.keys(LIFE_KEY_MAP).length ? JSON.stringify(LIFE_KEY_MAP) : '（空）'));
  if (problems.length) {
    console.log('\n待处理：');
    problems.forEach(function (p) { console.log('  - ' + p); });
    process.exit(1);
  }
  console.log('\n配置完整。');
  process.exit(0);
}

ensureDirs();
loadThreads();
loadGuestChats();
loadFortuneCache();
loadImageIndex();
// 超期图片清理：启动时清一次，之后每 6 小时一次
cleanupImages();
setInterval(cleanupImages, IMAGE_CLEAN_INTERVAL_MS).unref();
startInternalNotifyServer();

if (!SIMULATE_EVENT && (!APP_ID || !APP_SECRET)) {
  const msg = '未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，服务不会启动。'
    + '请在飞书开放平台创建自建应用后填入 /etc/feishu-bot.env，再执行 systemctl restart feishu-bot。';
  console.error(msg);
  writeLog('error', 'feishu-bot 缺少应用凭据', {});
  healthLog('feishu-bot: 缺少应用凭据，启动中止', {});
  // 78 = EX_CONFIG，配合 systemd RestartPreventExitStatus 避免无意义的疯狂重启
  process.exit(78);
}

if (!ALLOW_USERS.length && !ALLOW_CHATS.length) {
  console.error('警告：FEISHU_ALLOW_USERS / FEISHU_ALLOW_CHATS 未配置，机器人只会回报发送者身份，不会执行任何操作。');
}
if (!LIFE_ENABLED) {
  console.warn('提示：未找到 life-app，记账 / 待办 / 塔罗 / 运势 指令已停用。');
}
if (!SCHED_ONCE_ENABLED) {
  console.warn('提示：未找到 scheduler-app，单次提醒查询（任务）已停用。');
}

writeLog('info', 'feishu-bot 已启动', {
  appId: APP_ID,
  domain: DOMAIN_NAME,
  workspace: WORKSPACE,
  allowUsers: ALLOW_USERS.length ? ALLOW_USERS : '(空)',
  allowChats: ALLOW_CHATS.length ? ALLOW_CHATS : '(空)',
});
healthLog('feishu-bot: 进程启动', {
  pid: process.pid,
  appId: APP_ID,
  notifyUser: NOTIFY_USER || '',
});

if (SIMULATE_EVENT) {
  let simEvent = null;
  try { simEvent = JSON.parse(SIMULATE_EVENT); } catch (/** @type {any} */ e) {
    console.error('FEISHU_SIMULATE_EVENT 不是合法 JSON：' + e.message);
  }
  if (simEvent) {
    console.log('模拟事件模式：不建立长连接，仅处理一条事件');
    setTimeout(function () { handleMessage(simEvent); }, 300);
  }
} else {
  startLongConnection();
  console.log('feishu-codex-bridge started (appId=' + APP_ID + ', domain=' + DOMAIN_NAME + ')');
}

/* ---------------- 退出与崩溃记录 ---------------- */
let exiting = false;
/**
 * @param {string} reason
 * @param {Record<string, any>} [extra]
 * @returns {void}
 */
function recordExit(reason, extra) {
  if (exiting) return;
  exiting = true;
  const meta = Object.assign({
    reason: reason,
    uptimeSeconds: Math.round(process.uptime()),
    activeTasks: activeCount,
    queuedSends: sendQueue.length,
  }, extra || {});
  healthLog('feishu-bot: 进程退出', meta);
  writeLog('warn', 'feishu-bot 退出', meta);
}

process.on('exit', function () { recordExit('exit'); });
['SIGTERM', 'SIGINT', 'SIGHUP'].forEach(function (sig) {
  process.on(sig, function () {
    recordExit(sig);
    process.exit(0);
  });
});
process.on('uncaughtException', function (err) {
  recordExit('uncaughtException: ' + en(err));
  healthLog('feishu-bot: 未捕获异常', { stack: String((err && err.stack) || '').split('\n').slice(0, 5).join(' | ') });
  process.exit(1);
});
process.on('unhandledRejection', function (reason) {
  recordExit('unhandledRejection: ' + en(reason));
  process.exit(1);
});
