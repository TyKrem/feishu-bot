'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const lark = require('@larksuiteoapi/node-sdk');
const { authorize, childEnvironment, imageContext } = require('./policy');
const CMDS = require('../lib/commands');
const execute = promisify(execFile);
const POLICY = '（飞书机器人场景）请用简体中文简洁回复，飞书不渲染Markdown。你可按管理员指令执行运维操作。图片仅在用户明确要求时读取，保留原有编号，清理时不要删除未过保留期的图片。';

/** @param {any} options */
function createExecutor(options) {
  const environment = options.environment;
  const stateDirectory = options.stateDirectory;
  const active = new Map();
  const pending = new Set();
  const stateFile = path.join(stateDirectory, 'state.json');
  /** @type {any} */
  let state = { consumed: [], threads: {} };
  if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!Array.isArray(state.consumed) || !state.threads) throw new Error('执行器状态格式异常');
  const configuration = { owner: environment.FEISHU_EXECUTOR_OWNER, chat: environment.FEISHU_EXECUTOR_CHAT };
  if (!configuration.owner || !configuration.chat) throw new Error('缺少独立固定的管理员身份与私聊通道');
  const childEnv = childEnvironment(environment);
  const workspace = environment.FEISHU_WORKSPACE || '/root';
  const binary = environment.FEISHU_CODEX_BIN || '/opt/codex/bin/codex';
  const timeout = Math.max(60, Math.min(3600, Number(environment.FEISHU_TURN_TIMEOUT) || 900));
  const limit = Math.max(1, Math.min(4, Number(environment.FEISHU_MAX_ACTIVE) || 2));
  const maximumOutput = 32 * 1024 * 1024;
  let minute = 0;
  let requests = 0;
  function save() {
    const temporary = stateFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  }
  /** @param {string} message @param {any} [metadata] */
  function audit(message, metadata = {}) { console.log(JSON.stringify({ message, ...metadata })); }
  /** @param {any} response @param {number} status @param {any} payload */
  function reply(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(payload));
  }
  /** @param {any} data */
  async function verified(data) {
    if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(data.messageId || '') || data.chatId !== configuration.chat) throw new Error('消息标识或私聊通道无效');
    const original = await options.fetchMessage(data.messageId);
    if (original.message_id !== data.messageId) throw new Error('原始消息标识不匹配');
    return authorize(original, configuration, Date.now());
  }
  /** @param {any} command */
  async function query(command) {
    const now = Date.now();
    switch (command.action) {
      case 'status': {
        const result = await execute('/root/server-ops/bin/health-check.sh', [], { timeout: 60000, maxBuffer: 1024 * 1024 }).catch(error => ({ stdout: error.stdout || '', code: error.code || 1 }));
        return CMDS.healthText(result.stdout, 'code' in result ? Number(result.code) : 0, now);
      }
      case 'tasks': return CMDS.onceTasksText(require(path.join('/opt/scheduler-app', 'lib/once')).readOnceTasks('/opt/scheduler-app/data/once'), now);
      case 'balance': {
        const target = environment.FEISHU_MONITOR_API;
        if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(target || '')) throw new Error('未配置受信任的本机余额查询地址');
        const response = await (/** @type {any} */ (globalThis)).fetch(target + '/api/balance', { signal: AbortSignal.timeout(15000) });
        const payload = await response.json();
        return CMDS.balanceText(payload.balance || null, now) + (payload.error ? '\n⚠️ 余额接口：' + payload.error : '');
      }
      case 'kb': {
        const result = await execute('/bin/bash', ['/root/server-ops/bin/kb-search.sh', ...command.keyword.split(/\s+/)], { timeout: 20000, maxBuffer: 1024 * 1024 });
        return '📚 ' + command.keyword + '\n' + result.stdout;
      }
      case 'timers': {
        const result = await execute('systemctl', ['list-timers', '--all', '--no-legend', '--plain'], { timeout: 10000 });
        const rows = CMDS.timerRows(result.stdout);
        const units = rows.filter(row => !!row.nextText).map(row => row.activated);
        const shown = units.length ? await execute('systemctl', ['show', ...units, '-p', 'Id', '-p', 'Result'], { timeout: 10000 }) : { stdout: '' };
        const failed = await execute('systemctl', ['--failed', '--no-legend', '--plain'], { timeout: 10000 });
        return CMDS.timersText(rows, CMDS.parseShowResults(shown.stdout), CMDS.parseFailedUnits(failed.stdout), now);
      }
      default: throw new Error('不支持的固定查询');
    }
  }
  /** @param {any} child */
  function terminate(child) {
    try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch {}
    const timer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
    timer.unref();
  }
  const server = http.createServer(async (request, response) => {
    const currentMinute = Math.floor(Date.now() / 60000);
    if (minute !== currentMinute) { minute = currentMinute; requests = 0; }
    if (++requests > 32 || server.maxConnections && pending.size >= 4) { reply(response, 429, { error: '执行器请求过多' }); return; }
    if (request.method !== 'POST' || !['/codex', '/query', '/cancel', '/restart', '/health'].includes(request.url || '')) { reply(response, 404, { error: '接口不存在' }); return; }
    let body = '';
    request.setTimeout(10000, () => request.destroy());
    request.on('data', chunk => { body += chunk; if (body.length > 8192) request.destroy(); });
    request.on('error', () => {});
    request.on('end', async () => {
      request.setTimeout(0);
      let reserved = '';
      try {
        const data = JSON.parse(body || '{}');
        if (request.url === '/health') { reply(response, 200, { ok: true, active: active.size }); return; }
        if (request.url === '/restart') {
          const flag = '/run/feishu-bot.restart-requested';
          if (!fs.existsSync(flag) || active.size) { reply(response, 200, { restarted: false }); return; }
          const stat = fs.lstatSync(flag);
          if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022) throw new Error('重启标记权限异常');
          fs.unlinkSync(flag);
          reply(response, 200, { restarted: true });
          setTimeout(() => execute('systemctl', ['restart', 'feishu-bot'], { timeout: 30000 }).catch(() => audit('排队重启失败')), 1200);
          return;
        }
        if (pending.has(data.messageId)) throw new Error('消息正在核验');
        reserved = data.messageId; pending.add(reserved);
        /** @type {any} */
        const command = await verified(data);
        if (request.url === '/query') { reply(response, 200, { text: await query(command) }); return; }
        if (request.url === '/cancel') {
          if (command.action !== 'cancel') throw new Error('不是取消指令');
          for (const child of active.values()) terminate(child);
          reply(response, 200, { text: active.size ? '已请求停止当前运维任务。' : '当前没有运维任务。' }); return;
        }
        if (!['codex', 'fortune'].includes(command.action)) throw new Error('不是模型执行指令');
        if (active.size >= limit || active.has(command.key)) throw new Error('运维任务繁忙，请稍后再试');
        if (state.consumed.includes(data.messageId)) throw new Error('该消息已执行，请发送新消息');
        // 提示、二进制、工作目录与会话由执行器决定，不接受入口传来的任意命令或环境。
        let prompt = command.prompt;
        const thread = command.action === 'fortune' ? null : state.threads[command.key] || null;
        if (command.action === 'fortune') {
          const profile = require(path.join('/opt/life-app', 'lib/profile'));
          const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
          prompt = '今天是' + date + '。用户出生信息：' + profile.birthText(profile.getPersonalProfile()) + '。请计算今日运势，包含综合、事业学习、感情、健康、幸运色与数字，温和务实，不超过200字。';
        }
        const images = imageContext(environment.FEISHU_DATA_DIR || '/opt/feishu-bot/data', 'p:' + configuration.owner);
        prompt = POLICY + '\n' + images + '\n\n' + prompt;
        const argumentsList = ['--no-daemon', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-C', workspace];
        if (thread) argumentsList.push('resume', thread);
        argumentsList.push('--', prompt);
        state.consumed = [...state.consumed, data.messageId].slice(-4096); save();
        const child = spawn(binary, argumentsList, { cwd: workspace, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        active.set(command.key, child);
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
        let outputSize = 0;
        let lines = '';
        let closed = false;
        const timer = setTimeout(() => terminate(child), timeout * 1000);
        audit('开始运维任务', { action: command.action, resumed: !!thread });
        /** @param {string} stream @param {Buffer} chunk */
        function output(stream, chunk) {
          outputSize += chunk.length;
          if (outputSize > maximumOutput || response.writableLength > 1024 * 1024) { terminate(child); return; }
          response.write(JSON.stringify({ [stream]: chunk.toString('base64') }) + '\n');
        }
        child.stdout.on('data', chunk => {
          output('stdout', chunk);
          lines += chunk.toString();
          if (lines.length > 4 * 1024 * 1024) { terminate(child); lines = ''; return; }
          const complete = lines.split('\n'); lines = complete.pop() || '';
          for (const line of complete) {
            try {
              const event = JSON.parse(line);
              if (event.type === 'thread.started' && /^[a-f0-9-]{36}$/.test(event.thread_id)) { state.threads[command.key] = event.thread_id; save(); }
            } catch {}
          }
        });
        child.stderr.on('data', chunk => output('stderr', chunk));
        child.once('error', () => { if (!response.destroyed) response.write(JSON.stringify({ error: '模型进程启动失败' }) + '\n'); });
        child.once('close', code => {
          closed = true; clearTimeout(timer); active.delete(command.key);
          audit('运维任务结束', { action: command.action, code });
          if (!response.destroyed) response.end(JSON.stringify({ exit: code === null ? 1 : code }) + '\n');
        });
        response.once('close', () => { if (!closed) terminate(child); });
      } catch (error) {
        audit('拒绝或查询失败');
        reply(response, 403, { error: error instanceof Error && !('response' in error) ? error.message : '执行器核验或查询失败' });
      } finally { if (reserved) pending.delete(reserved); }
    });
  });
  server.maxConnections = 12;
  server.requestTimeout = 15000;
  server.on('close', () => { for (const child of active.values()) terminate(child); });
  return server;
}

if (require.main === module) {
  const environment = process.env;
  // 核验失败须及时拒绝，不能让飞书HTTP请求长期占住特权入口。
  const transport = /** @type {any} */ (lark.defaultHttpInstance);
  transport.defaults.timeout = 8000;
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  const client = new lark.Client({ appId: environment.FEISHU_APP_ID || '', appSecret: environment.FEISHU_APP_SECRET || '',
    domain: environment.FEISHU_DOMAIN === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu, logger });
  const socket = environment.FEISHU_EXECUTOR_SOCKET || '/run/feishu-executor/control.sock';
  const directory = '/var/lib/feishu-executor';
  const server = createExecutor({ environment, stateDirectory: directory, fetchMessage: async (/** @type {string} */ messageId) => {
    const result = await client.im.message.get({ path: { message_id: messageId }, params: { user_id_type: 'open_id' } });
    if (result.code !== 0 || !result.data?.items?.[0]) throw new Error('无法向飞书核验原始消息，请检查应用权限或重发');
    return result.data.items[0];
  } });
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  if (fs.existsSync(socket)) fs.unlinkSync(socket);
  server.listen(socket, () => { fs.chmodSync(socket, 0o660); console.log('运维执行器已就绪，仅监听本机Unix套接字'); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.close(); setTimeout(() => process.exit(0), 2500).unref(); });
}
module.exports = { createExecutor };
