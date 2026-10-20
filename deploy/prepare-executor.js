'use strict';

const fs = require('fs');
const path = require('path');
const CFG = require('../server/lib/config');
const environment = {};
for (const line of fs.readFileSync('/etc/feishu-bot.env', 'utf8').split('\n')) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (match) environment[match[1]] = match[2];
}
if (!fs.existsSync('/etc/feishu-executor.env')) throw new Error('缺少独立管理员私聊配置，请先核实身份及通道，不能自动信任入口声明');
const home = environment.FEISHU_CODEX_HOME || '/root/.codex-feishu';
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const configuration = fs.readFileSync('/root/.codex/config.toml', 'utf8');
fs.writeFileSync(path.join(home, 'config.toml'), configuration.replace(/^model_catalog_json\s*=.*$/m, 'model_catalog_json = "' + home + '/models.json"'), { mode: 0o600 });
if (fs.existsSync('/root/.codex/models.json')) fs.copyFileSync('/root/.codex/models.json', path.join(home, 'models.json'));
// 受限纯聊天只沿用非秘密参数；API密钥须独立配置，不能复制运维模型的凭据。
const mappings = { FEISHU_CHAT_API_BASE_URL: 'base_url', FEISHU_CHAT_API_MODEL: 'model' };
let added = '';
for (const [key, field] of Object.entries(mappings)) {
  const value = CFG.tomlValue(configuration, field);
  if (!environment[key] && value) added += key + '=' + value + '\n';
}
if (!environment.FEISHU_EXECUTOR_SOCKET) added += 'FEISHU_EXECUTOR_SOCKET=/run/feishu-executor/control.sock\n';
if (added) fs.appendFileSync('/etc/feishu-bot.env', '\n' + added);
fs.chmodSync('/etc/feishu-bot.env', 0o600);
const stateFile = '/var/lib/feishu-executor/state.json';
if (!fs.existsSync(stateFile)) {
  const ownerText = fs.readFileSync('/etc/feishu-executor.env', 'utf8');
  const owner = /^FEISHU_EXECUTOR_OWNER=(.+)$/m.exec(ownerText)?.[1];
  const threads = {};
  if (owner) {
    try {
      const original = JSON.parse(fs.readFileSync('/opt/feishu-bot/data/threads.json', 'utf8'));
      const thread = original['p:' + owner]?.threadId;
      if (/^[a-f0-9-]{36}$/.test(thread || '')) threads['p:' + owner] = thread;
    } catch {}
  }
  fs.writeFileSync(stateFile, JSON.stringify({ consumed: [], threads }), { mode: 0o600 });
}
console.log('执行器配置已准备，保留模型凭据与已有管理员会话；未输出敏感值。');
