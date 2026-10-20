'use strict';

const fs = require('fs');
const path = require('path');
const TXT = require('../lib/text');
const CMDS = require('../lib/commands');

/** @param {any} message @param {any} configuration @param {number} now */
function authorize(message, configuration, now) {
  if (!message || message.sender?.sender_type !== 'user' || message.sender.id_type !== 'open_id' ||
      message.sender.id !== configuration.owner || message.chat_id !== configuration.chat || message.deleted || message.updated) {
    throw new Error('只允许管理员私聊中的原始消息');
  }
  const createdAt = Number(message.create_time);
  if (!Number.isFinite(createdAt) || now - createdAt > 10 * 60000 || createdAt > now + 30000) {
    throw new Error('消息已过期或时间异常，请重新发送');
  }
  let text = TXT.stripMentionKeys(TXT.extractText({ message_type: message.msg_type, content: message.body?.content }), message.mentions);
  if (text.startsWith('。')) text = '.' + text.slice(1);
  if (text.length > 4000) throw new Error('消息超过长度限制');
  const prompt = TXT.extractCodexPrompt(text);
  if (prompt) return { action: 'codex', prompt, key: 'p:' + configuration.owner };
  if (/^(?:\.fortune|\.f|运势|今日运势|今日运程|今日运气)$/i.test(text)) return { action: 'fortune', key: 'fortune:' + configuration.owner };
  if (/^(?:\.stop|\.cancel|停止任务|取消任务)$/i.test(text)) return { action: 'cancel' };
  if (CMDS.isStatusCommand(text)) return { action: 'status' };
  if (CMDS.isUsageCommand(text)) return { action: 'usage' };
  if (CMDS.isTimersCommand(text)) return { action: 'timers' };
  if (CMDS.isOnceTasksCommand(text)) return { action: 'tasks' };
  const keyword = CMDS.kbQuery(text);
  if (keyword) return { action: 'kb', keyword };
  throw new Error('该消息不是受支持的运维指令');
}

/** @param {NodeJS.ProcessEnv} environment */
function childEnvironment(environment) {
  // 不继承入口进程环境；模型认证沿用root专用CODEX_HOME中的既有文件。
  return { HOME: '/root', CODEX_HOME: environment.FEISHU_CODEX_HOME || '/root/.codex-feishu',
    PATH: '/opt/node/bin:/opt/codex/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8', TZ: 'Asia/Shanghai', NO_COLOR: '1' };
}

/** @param {string} directory @param {string} key */
function imageContext(directory, key) {
  const root = path.join(directory, 'images');
  let entries;
  try { entries = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')).items[key]; } catch { return ''; }
  if (!Array.isArray(entries)) return '';
  return entries.slice(-10).filter(item => Number.isSafeInteger(item.n) && /^[a-zA-Z0-9_.-]+$/.test(item.file) &&
    !item.file.startsWith('.') && fs.existsSync(path.join(root, item.file)) && !fs.lstatSync(path.join(root, item.file)).isSymbolicLink() && fs.lstatSync(path.join(root, item.file)).isFile() && fs.lstatSync(path.join(root, item.file)).nlink === 1).map(item => '第' + item.n + '张图片：' + path.join(root, item.file)).join('\n');
}

module.exports = { authorize, childEnvironment, imageContext };
