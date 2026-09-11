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
const { spawn } = require('child_process');
const { URL } = require('url');
const lark = require('@larksuiteoapi/node-sdk');

function requireLife(mod) {
  try { return require('/opt/life-app/lib/' + mod); } catch (e) {}
  return require('/root/life-app/lib/' + mod);
}
const LIFE_ACTIONS = requireLife('actions.js');
const LIFE_FORTUNE = requireLife('fortune.js');
const LIFE_PROFILE = requireLife('profile.js');

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

// 调试用：FEISHU_SIMULATE_EVENT 传入一条 im.message.receive_v1 事件 JSON，
// 启动时不建立长连接，直接按该事件跑一遍消息处理；FEISHU_DRY_RUN=1 时只打印不发送。
const SIMULATE_EVENT = String(ENV.FEISHU_SIMULATE_EVENT || '').trim();
const DRY_RUN = /^(1|true|yes)$/i.test(String(ENV.FEISHU_DRY_RUN || ''));

// 生活数据按“身份键”隔离。QQ 时代的数据以 QQ 号为主键，
// FEISHU_LIFE_KEY_MAP 可以把飞书身份映射回原来的键，免迁移数据。
// 格式：ou_xxx=10001,ou_yyy=2207536710
const LIFE_KEY_MAP = parseKeyMap(ENV.FEISHU_LIFE_KEY_MAP);
const LEGACY_TO_FEISHU = reverseMap(LIFE_KEY_MAP);

/* ---------------- 回复随机延迟 ---------------- */
function toDelaySeconds(v) {
  const n = parseFloat(v);
  return isFinite(n) && n >= 0 ? n : NaN;
}

function parseReplyDelay(rangeRaw, minRaw, maxRaw) {
  let min = 0.8;
  let max = 2.5;
  const parts = String(rangeRaw == null ? '' : rangeRaw)
    .split(/[^0-9.]+/)
    .map(toDelaySeconds)
    .filter(function (n) { return !isNaN(n); });
  if (parts.length >= 2) { min = parts[0]; max = parts[1]; }
  else if (parts.length === 1) { min = 0; max = parts[0]; }
  const lo = toDelaySeconds(minRaw);
  const hi = toDelaySeconds(maxRaw);
  if (!isNaN(lo)) min = lo;
  if (!isNaN(hi)) max = hi;
  if (max < min) { const t = min; min = max; max = t; }
  return { minMs: Math.round(min * 1000), maxMs: Math.round(max * 1000) };
}

const REPLY_DELAY = parseReplyDelay(ENV.FEISHU_REPLY_DELAY, ENV.FEISHU_REPLY_DELAY_MIN, ENV.FEISHU_REPLY_DELAY_MAX);

function replyDelayMs() {
  const lo = REPLY_DELAY.minMs;
  const hi = REPLY_DELAY.maxMs;
  if (hi <= 0) return 0;
  if (hi <= lo) return hi;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
/* ---------------- 回复随机延迟 end ---------------- */

function splitList(raw) {
  return String(raw || '')
    .split(',')
    .map(function (x) { return x.trim(); })
    .filter(Boolean);
}

function parseKeyMap(raw) {
  const out = {};
  splitList(raw).forEach(function (pair) {
    const i = pair.indexOf('=');
    if (i <= 0) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k && v) out[k] = v;
  });
  return out;
}

function reverseMap(map) {
  const out = {};
  Object.keys(map).forEach(function (k) { if (!out[map[k]]) out[map[k]] = k; });
  return out;
}

function tokenEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function errText(e) {
  if (!e) return '未知错误';
  const detail = (e.response && e.response.data && (e.response.data.msg || e.response.data.message)) || '';
  const code = e.code || (e.response && e.response.data && e.response.data.code) || '';
  const msg = e.message || String(e);
  return (code ? '[' + code + '] ' : '') + (detail || msg);
}

/* ---------------- 模型直连（受限账号纯聊天） ---------------- */
const GUEST_CONFIG_TEXT = readTextFile('/root/.codex/config.toml');

function tomlValue(text, key) {
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*"([^"]*)"', 'm');
  const m = re.exec(text);
  return m ? m[1] : '';
}
const GUEST_API_BASE = String(ENV.FEISHU_CHAT_API_BASE_URL || ENV.CHAT_API_BASE_URL || tomlValue(GUEST_CONFIG_TEXT, 'base_url') || '').trim();
const GUEST_API_KEY = String(ENV.FEISHU_CHAT_API_KEY || ENV.CHAT_API_KEY || tomlValue(GUEST_CONFIG_TEXT, 'experimental_bearer_token') || '').trim();
const GUEST_MODEL = String(ENV.FEISHU_CHAT_API_MODEL || ENV.CHAT_API_MODEL || tomlValue(GUEST_CONFIG_TEXT, 'model') || '').trim();

const FULL_AUTO_ARG = '--dangerously-bypass-approvals-and-sandbox';
const PROMPT_TAIL =
  '（飞书机器人场景）请使用简体中文回复；回复要简洁，适合在飞书里阅读。' +
  '飞书文本消息不渲染 Markdown 语法，尽量避免使用 ** 加粗、# 标题、表格与代码块围栏，' +
  '需要分点时用「1. 2. 3.」或「- 」这样的纯文本。命令执行结果太长时先给摘要，需要时再贴关键内容。' +
  '如果用户要求执行有破坏性的操作，先说明风险再执行。';
const GUEST_PROMPT_TAIL =
  '（飞书机器人场景）请使用简体中文回复；回复要简洁，适合在飞书里阅读，避免 Markdown 语法。' +
  '你是纯文字聊天助手：不执行系统命令、不读取/修改服务器文件、不提供任何密钥或令牌。';

const BOT_HELP =
  '🔧 现成指令：\n' +
  '· .help 显示本帮助\n' +
  '· .codex 内容 / .c 内容 调用 Codex 处理\n' +
  '· .rand / .r 3d10 投骰子（支持 2d6+1、d20）\n' +
  '· .tarot / .t 抽一张塔罗牌并解读\n' +
  '· .fortune / .f 今日运势（每天仅计算一次，之后直接返回缓存）\n' +
  '· 所有指令开头的 . 都可以换成 。（如 。help、。rand 3d10）\n\n' +
  '📒 记账：\n' +
  '· 记：午饭 25 / 记账 打车 12\n' +
  '· 水费缴费50元（生活缴费也能识别）\n' +
  '· 查账 / 本月花了多少\n' +
  '· 预算 3000\n\n' +
  '📝 待办：\n' +
  '· 加待办：买牛奶\n' +
  '· 待办 / 完成待办 1 / 删除待办 2\n\n' +
  '⏰ 提醒 / 运势 / 查文件 / 服务器等需求，用：.c 内容\n' +
  '  例如：.c 十分钟后提醒我看锅、.c 今天运势\n' +
  '💬 其他未匹配消息会自动回复本帮助\n' +
  '👥 群聊里需要 @ 我 才会响应';
const BOT_HELP_RESTRICTED =
  '🔧 现成指令：\n' +
  '· .help 显示本帮助\n' +
  '· .c 内容 使用纯聊天助手（无系统权限）\n' +
  '· .rand / .r 3d10 投骰子\n' +
  '· .tarot / .t 抽塔罗\n' +
  '· 指令开头的 . 也可用。代替\n\n' +
  '📒 记账：\n' +
  '· 记：午饭 25 / 水费缴费50元\n' +
  '· 查账 / 本月花了多少\n\n' +
  '📝 待办：\n' +
  '· 加待办：买牛奶 / 待办 / 完成待办 1\n\n' +
  '⚠️ 当前账号为受限账号，仅可纯聊天与生活指令，不能操作服务器/文件';

/* ---------------- 文件与目录 ---------------- */
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
  } catch (e) {
    console.error('prepare codex home failed:', e.message);
  }
}

/* ---------------- 线程存储 ---------------- */
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
function localDateKey() {
  const d = new Date();
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ---------------- 日志上报 ---------------- */
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

function healthTs() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    + (off >= 0 ? '+' : '-') + p(Math.floor(Math.abs(off) / 60)) + p(Math.abs(off) % 60);
}

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
const sendQueue = [];
let sendPumping = false;

function enqueueSend(job) {
  sendQueue.push(job);
  pumpSendQueue();
}

async function pumpSendQueue() {
  if (sendPumping) return;
  sendPumping = true;
  while (sendQueue.length) {
    const job = sendQueue.shift();
    try { await job(); } catch (e) {}
    if (sendQueue.length) await sleep(300);
  }
  sendPumping = false;
}

function chunkText(text, size) {
  const s = String(text == null ? '' : text);
  const limit = size || 3000;
  const chunks = [];
  for (let i = 0; i < s.length; i += limit) chunks.push(s.slice(i, i + limit));
  return chunks;
}

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

async function replyText(messageId, text) {
  await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'text',
      content: JSON.stringify({ text: String(text) }),
    },
  });
}

/*
 * target: { kind: 'reply'|'chat'|'user', id }
 * opts.immediate: 主动推送不走随机延迟
 */
function deliver(target, text, opts) {
  const chunks = chunkText(text, 3000).filter(function (c) { return c.length; });
  if (!chunks.length) return;
  const delay = (opts && opts.immediate) ? 0 : replyDelayMs();
  enqueueSend(function () {
    return sleep(delay).then(async function () {
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
        if (i + 1 < chunks.length) await sleep(300);
      }
    });
  });
}

/* ---------------- 身份与白名单 ---------------- */
function senderIds(sender) {
  const sid = (sender && sender.sender_id) || {};
  return [sid.open_id, sid.user_id, sid.union_id]
    .map(function (x) { return String(x || '').trim(); })
    .filter(Boolean);
}

function matches(list, ids) {
  if (!list.length) return false;
  return ids.some(function (id) { return list.indexOf(id) >= 0; });
}

// 生活数据主键：优先用映射（可继续沿用 QQ 时代的数据），否则用飞书 open_id
function lifeKey(ids) {
  for (let i = 0; i < ids.length; i++) {
    if (LIFE_KEY_MAP[ids[i]]) return LIFE_KEY_MAP[ids[i]];
  }
  return ids[0] || '';
}

function primaryId(ids) {
  for (let i = 0; i < ids.length; i++) {
    if (LEGACY_TO_FEISHU[ids[i]]) return LEGACY_TO_FEISHU[ids[i]];
  }
  return ids[0] || '';
}

/* ---------------- 消息解析 ---------------- */
function stripMentionKeys(text, mentions) {
  let out = String(text || '');
  (mentions || []).forEach(function (m) {
    if (m && m.key) out = out.split(m.key).join(' ');
  });
  return out.replace(/\s+/g, ' ').trim();
}

function extractText(message) {
  const type = String((message && message.message_type) || '');
  let content = {};
  try { content = JSON.parse((message && message.content) || '{}'); } catch (e) { content = {}; }
  if (type === 'text') return String(content.text || '');
  if (type === 'post') {
    const parts = [];
    if (content.title) parts.push(String(content.title));
    (content.content || []).forEach(function (line) {
      (line || []).forEach(function (node) {
        if (!node) return;
        if (node.tag === 'text' && node.text) parts.push(String(node.text));
        else if (node.tag === 'a' && node.text) parts.push(String(node.text));
        else if (node.tag === 'at' && node.user_id) parts.push(' ');
      });
      parts.push('\n');
    });
    return parts.join('');
  }
  return '';
}

const seenMessages = new Map();
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

const IMAGE_HINT = '我现在只能读文字消息，图片/文件麻烦改成文字描述一下。';

function mentionIsBot(message) {
  const mentions = (message && message.mentions) || [];
  if (!mentions.length) return false;
  if (!BOT_OPEN_ID && !BOT_NAME) return true; // 未配置机器人身份时，有 @ 即视为呼叫
  return mentions.some(function (m) {
    const id = (m && m.id) || {};
    if (BOT_OPEN_ID && (id.open_id === BOT_OPEN_ID || id.user_id === BOT_OPEN_ID)) return true;
    if (BOT_NAME && String((m && m.name) || '') === BOT_NAME) return true;
    return false;
  });
}

/* ---------------- 消息处理 ---------------- */
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
      deliver({ kind: 'reply', id: messageId, fallbackChatId: chatId }, reply, { immediate: true });
      writeLog('warn', '收到未授权消息（白名单为空）', { openId: ids[0], userId: ids[1] || '', chatId: chatId });
      return;
    }
    writeLog('warn', '忽略未授权消息', { openId: ids[0], userId: ids[1] || '', chatId: chatId, group: isGroup });
    return;
  }

  const rawText = extractText(message);
  const messageType = String(message.message_type || '');
  if (!rawText.trim() && messageType !== 'text' && messageType !== 'post') {
    deliver({ kind: 'reply', id: messageId, fallbackChatId: chatId }, IMAGE_HINT);
    return;
  }

  let text = stripMentionKeys(rawText, message.mentions).trim();
  if (!text) {
    deliver({ kind: 'reply', id: messageId, fallbackChatId: chatId }, BOT_HELP);
    return;
  }
  if (text.length > 4000) {
    deliver({ kind: 'reply', id: messageId, fallbackChatId: chatId }, '消息太长，请控制在 4000 字以内。');
    return;
  }
  if (text.charAt(0) === '。') text = '.' + text.slice(1);

  const replyTarget = { kind: 'reply', id: messageId, fallbackChatId: chatId };
  const restricted = matches(RESTRICTED_USERS, ids);
  const key = isGroup ? 'g:' + chatId + ':' + ids[0] : 'p:' + ids[0];
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
  if (/^\.help$/i.test(text)) {
    deliver(replyTarget, restricted ? BOT_HELP_RESTRICTED : BOT_HELP);
    return;
  }
  if (/^\.(?:rand|r)(?:\s|$)/i.test(text)) {
    deliver(replyTarget, rollDiceText(text));
    return;
  }
  if (/^\.(?:tarot|t)$/i.test(text)) {
    deliver(replyTarget, tarotText());
    return;
  }
  if (/^(?:\.fortune|\.f|今日运势)$/i.test(text)) {
    startFortuneCommand(replyTarget, ids, key, life, restricted);
    return;
  }

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
  } catch (e) {
    deliver(replyTarget, '生活指令处理失败：' + (e && e.message ? e.message : String(e)));
    return;
  }

  deliver(replyTarget, restricted ? BOT_HELP_RESTRICTED : BOT_HELP);
}

function extractCodexPrompt(text) {
  const m = /^\.(?:codex|c)(?:\s+|$)/i.exec(text);
  return m ? text.slice(m[0].length).trim() : null;
}

function rollDiceText(text) {
  const body = String(text).replace(/^\.(?:rand|r)/i, '').trim();
  const re = /(\d+)?d(\d+)([+-]\d+)?/gi;
  const lines = [];
  let grandTotal = 0;
  let found = false;
  let m;
  while ((m = re.exec(body)) !== null) {
    found = true;
    const count = Math.max(1, parseInt(m[1] || '1', 10) || 1);
    const sides = parseInt(m[2], 10);
    const bonus = parseInt(m[3] || '0', 10) || 0;
    if (!sides || sides < 2 || count > 1000 || sides > 100000) {
      return '.rand 参数无效，请使用例如：3d10、2d6+1、d20';
    }
    const rolls = [];
    for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
    const sum = rolls.reduce(function (a, b) { return a + b; }, 0) + bonus;
    grandTotal += sum;
    lines.push(m[0].toLowerCase() + ' → ' + rolls.join(' + ') + ' = ' + sum +
      (bonus ? '（含调整 ' + (bonus > 0 ? '+' : '') + bonus + '）' : ''));
  }
  if (!found) return '🎲 用法：.rand 3d10，也支持 2d6+1、d20';
  if (lines.length === 1) return '🎲 ' + lines[0];
  return '🎲 ' + lines.join('\n') + '\n总计 ' + grandTotal;
}

function tarotText() {
  const card = LIFE_FORTUNE.pickTarot();
  const meaning = card.reversed ? card.rev : card.up;
  return '🃏 塔罗牌：' + card.display +
    '\n解读：' + meaning +
    '\n\n今天的建议：围绕“' + (card.reversed ? '先想清楚再行动' : '顺势推进') + '”，保持轻松心态。';
}

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
  runCodex(target, fortuneKey, prompt, function (text) {
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
  const task = restricted ? runGuestChat(target, key, prompt) : runCodex(target, key, prompt);
  task.finally(function () {
    active.delete(key);
    activeCount = Math.max(0, activeCount - 1);
  });
}

/* ---------------- 受限纯聊天（不执行系统命令） ---------------- */
function buildGuestPayload(history) {
  const sys = { role: 'system', content: [{ type: 'input_text', text: GUEST_PROMPT_TAIL }] };
  const mapped = history.map(function (m) {
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
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          let detail = data;
          try {
            const j = JSON.parse(data);
            if (j.error && j.error.message) detail = j.error.message;
          } catch (e) {}
          reject(new Error('模型服务错误（HTTP ' + resp.statusCode + '）：' + String(detail).slice(0, 300)));
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

function extractGuestText(data) {
  const out = (data && data.output) || [];
  const parts = [];
  out.forEach(function (item) {
    if (item && item.type === 'message' && Array.isArray(item.content)) {
      item.content.forEach(function (c) {
        if (c && c.type === 'output_text' && c.text) parts.push(c.text);
      });
    }
  });
  return parts.join('\n').trim();
}

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
    } catch (e) {
      deliver(target, '无法启动 Codex：' + e.message);
      writeLog('error', 'Codex 启动失败', { error: e.message });
      resolve();
      return;
    }

    let buf = '';
    let stderrBuf = '';
    let stderrTail = '';
    let agentParts = [];
    let done = false;
    let finished = false;
    let currentThread = threadId;
    const timer = setTimeout(function () { killChild('处理超时'); }, TURN_TIMEOUT * 1000);

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
      const logMeta = { key: key, thread: currentThread || threadId || null, type: ev.type };
      if (ev.item && typeof ev.item === 'object') {
        logMeta.itemType = ev.item.type || '';
        logMeta.item = ev.item;
      }
      if (ev.usage) logMeta.usage = ev.usage;
      writeLog('debug', 'Codex 输出', logMeta);
    }

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

    child.stdout.on('data', function (chunk) {
      buf += String(chunk);
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.on('data', function (chunk) {
      const text = String(chunk);
      stderrTail = (stderrTail + text).slice(-600);
      stderrBuf += text;
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop();
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

function resolveNotifyTarget(body) {
  const openId = String(body.open_id || body.openId || body.user || '').trim();
  const chatId = String(body.chat_id || body.chatId || '').trim();
  const legacy = String(body.qq || '').trim();
  if (openId) return { kind: 'user', id: openId, label: openId };
  if (chatId) return { kind: 'chat', id: chatId, label: chatId };
  if (legacy) {
    const mapped = LEGACY_TO_FEISHU[legacy];
    if (mapped) return { kind: 'user', id: mapped, label: mapped };
    if (/^ou_/.test(legacy)) return { kind: 'user', id: legacy, label: legacy };
  }
  if (NOTIFY_USER) return { kind: 'user', id: NOTIFY_USER, label: NOTIFY_USER };
  return null;
}

function startInternalNotifyServer() {
  const server = http.createServer(function (req, res) {
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
      deliver(target, text, { immediate: true });
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
      } catch (e) {
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
          deliver({ kind: 'user', id: NOTIFY_USER }, '✅ feishu-bot 启动完成，已上线。', { immediate: true });
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
  try { simEvent = JSON.parse(SIMULATE_EVENT); } catch (e) {
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
