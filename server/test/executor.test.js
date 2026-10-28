'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { once } = require('events');
const { authorize, childEnvironment } = require('../executor/policy');
const { createExecutor } = require('../executor/server');

/** @param {string} id @param {string} text @returns {any} */
function message(id, text) {
  const created = String(Date.now());
  return { message_id: id, chat_id: 'oc_private', create_time: created, update_time: created, msg_type: 'text',
    sender: { id: 'ou_owner', id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text }) } };
}

test('原始消息授权拒绝伪造身份、群聊、过期消息和普通闲聊', () => {
  const configuration = { owner: 'ou_owner', chat: 'oc_private' };
  const original = message('om_test', '.c 只输出通过');
  assert.equal(authorize(original, configuration, Date.now()).prompt, '只输出通过');
  assert.equal(authorize({ ...original, updated: true }, configuration, Date.now()).prompt, '只输出通过');
  assert.equal(authorize({ ...original, updated: true, update_time: String(Number(original.create_time) + 200) },
    configuration, Date.now()).prompt, '只输出通过');
  for (const invalid of [{ ...original, chat_id: 'oc_group' }, { ...original, sender: { id: 'ou_other' } },
    { ...original, create_time: '0' }, { ...original, updated: true, update_time: String(Number(original.create_time) + 5000) },
    message('om_test', '普通闲聊')]) {
    assert.throws(() => authorize(invalid, configuration, Date.now()));
  }
  const environment = childEnvironment({ FEISHU_APP_SECRET: 'synthetic', FEISHU_NOTIFY_TOKEN: 'synthetic', NODE_OPTIONS: '--inspect', HOME: '/tmp' });
  assert.equal(environment.HOME, '/root');
  assert.equal(Object.keys(environment).some(key => key.startsWith('FEISHU_') || key === 'NODE_OPTIONS'), false);
});

/** @param {string} socket @param {string} route @param {any} payload @returns {Promise<{status: number|undefined, content: string}>} */
function request(socket, route, payload) {
  return new Promise((resolve, reject) => {
    const call = http.request({ socketPath: socket, method: 'POST', path: route }, response => {
      let content = '';
      response.on('data', chunk => { content += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, content }));
    });
    call.on('error', reject); call.end(JSON.stringify(payload));
  });
}

test('执行器使用原始正文、隔离环境、保存会话并阻止重复执行', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-executor-'));
  const socket = path.join(directory, 'control.sock');
  const binary = path.join(directory, 'fake-cli');
  fs.writeFileSync(binary, '#!/usr/bin/python3\nimport json,sys,os\nprint(json.dumps({"type":"thread.started","thread_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}))\nprint(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":json.dumps({"original":sys.argv[-1],"resumed":"resume" in sys.argv,"secretInherited":"FEISHU_APP_SECRET" in os.environ})}}))\nprint(json.dumps({"type":"turn.completed"}))\n', { mode: 0o700 });
  const server = createExecutor({ environment: { FEISHU_EXECUTOR_OWNER: 'ou_owner', FEISHU_EXECUTOR_CHAT: 'oc_private',
    FEISHU_WORKSPACE: directory, FEISHU_CODEX_BIN: binary, FEISHU_DATA_DIR: directory, FEISHU_APP_SECRET: 'synthetic' }, stateDirectory: directory,
    fetchMessage: async (/** @type {string} */ id) => message(id, '.c 原始授权正文') });
  server.listen(socket); await once(server, 'listening');
  try {
    const first = await request(socket, '/codex', { messageId: 'om_one', chatId: 'oc_private', prompt: '伪造提示', workspace: '/' });
    assert.equal(first.status, 200);
    const output = first.content.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.stdout).map(event => Buffer.from(event.stdout, 'base64').toString()).join('');
    const answer = JSON.parse(JSON.parse(output.trim().split('\n')[1]).item.text);
    assert.match(answer.original, /原始授权正文/); assert.doesNotMatch(answer.original, /伪造提示/); assert.equal(answer.secretInherited, false);
    assert.equal((await request(socket, '/codex', { messageId: 'om_one', chatId: 'oc_private' })).status, 403);
    assert.equal((await request(socket, '/codex', { messageId: 'om_other', chatId: 'oc_group' })).status, 403);
    const next = await request(socket, '/codex', { messageId: 'om_two', chatId: 'oc_private' });
    const resumed = next.content.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.stdout).map(event => Buffer.from(event.stdout, 'base64').toString()).join('');
    assert.match(resumed, /resumed.*true/);
    assert.equal((await request(socket, '/arbitrary-shell', {})).status, 404);
  } finally { server.close(); await once(server, 'close'); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('取消指令终止独立模型进程，不能作为任意查询使用', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-cancel-'));
  const socket = path.join(directory, 'control.sock');
  const binary = path.join(directory, 'fake-cli');
  fs.writeFileSync(binary, '#!/usr/bin/python3\nimport time\ntime.sleep(20)\n', { mode: 0o700 });
  const server = createExecutor({ environment: { FEISHU_EXECUTOR_OWNER: 'ou_owner', FEISHU_EXECUTOR_CHAT: 'oc_private',
    FEISHU_WORKSPACE: directory, FEISHU_CODEX_BIN: binary, FEISHU_DATA_DIR: directory }, stateDirectory: directory,
    fetchMessage: async (/** @type {string} */ id) => message(id, id === 'om_stop' ? '.stop' : '.c 等待测试') });
  server.listen(socket); await once(server, 'listening');
  try {
    const task = request(socket, '/codex', { messageId: 'om_running', chatId: 'oc_private' });
    await new Promise(resolve => setTimeout(resolve, 100));
    const cancelled = await request(socket, '/cancel', { messageId: 'om_stop', chatId: 'oc_private' });
    assert.equal(cancelled.status, 200);
    assert.match((await task).content, /"exit":1/);
    assert.equal(JSON.parse((await request(socket, '/health', {})).content).active, 0);
    assert.equal((await request(socket, '/query', { messageId: 'om_unknown', chatId: 'oc_private' })).status, 403);
  } finally { server.close(); await once(server, 'close'); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('余额指令只返回 DeepSeek 官方余额，用量入口已取消', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-balance-'));
  const socket = path.join(directory, 'control.sock');
  const configuration = { owner: 'ou_owner', chat: 'oc_private' };
  const globals = /** @type {any} */ (globalThis);
  const originalFetch = globals.fetch;
  globals.fetch = async (/** @type {any} */ url) => {
    assert.equal(url, 'http://127.0.0.1:8791/api/balance');
    return { json: async () => ({ balance: { isAvailable: true, balances: [
      { currency: 'CNY', total: '80.49', granted: '0.00', toppedUp: '80.49' },
    ] } }) };
  };
  const server = createExecutor({ environment: {
    FEISHU_EXECUTOR_OWNER: configuration.owner,
    FEISHU_EXECUTOR_CHAT: configuration.chat,
    FEISHU_MONITOR_API: 'http://127.0.0.1:8791',
    FEISHU_WORKSPACE: directory,
    FEISHU_DATA_DIR: directory,
  }, stateDirectory: directory,
  fetchMessage: async (/** @type {string} */ id) => message(id, id === 'om_usage' ? '用量' : '余额') });
  server.listen(socket); await once(server, 'listening');
  try {
    const response = await request(socket, '/query', { messageId: 'om_balance', chatId: configuration.chat });
    assert.equal(response.status, 200);
    const text = JSON.parse(response.content).text;
    assert.match(text, /DeepSeek API 余额/);
    assert.match(text, /¥80\.49/);
    assert.doesNotMatch(text, /Token|用量/);
    const retired = await request(socket, '/query', { messageId: 'om_usage', chatId: configuration.chat });
    assert.equal(retired.status, 403);
  } finally {
    globals.fetch = originalFetch;
    server.close(); await once(server, 'close');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('执行器保留实际日期目录中的图片编号，拒绝越界和链接文件', () => {
  const { imageContext } = require('../executor/policy');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-images-'));
  const images = path.join(directory, 'images');
  const day = path.join(images, '2026-10-20');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'p_ou_owner_1.png'), 'synthetic-image');
  fs.writeFileSync(path.join(directory, 'outside.png'), 'synthetic-outside');
  fs.symlinkSync(path.join(directory, 'outside.png'), path.join(day, 'linked.png'));
  fs.writeFileSync(path.join(images, 'index.json'), JSON.stringify({ items: { 'p:ou_owner': [
    { n: 1, file: '2026-10-20/p_ou_owner_1.png' }, { n: 2, file: '../outside.png' }, { n: 3, file: '2026-10-20/linked.png' },
  ] } }));
  try {
    const context = imageContext(directory, 'p:ou_owner');
    assert.match(context, /第1张图片/); assert.match(context, /2026-10-20/);
    assert.doesNotMatch(context, /第2张|第3张/);
    fs.linkSync(path.join(day, 'p_ou_owner_1.png'), path.join(day, 'duplicate.png'));
    assert.equal(imageContext(directory, 'p:ou_owner'), '');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
