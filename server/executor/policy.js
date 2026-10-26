'use strict';

const fs = require('fs');
const path = require('path');
const TXT = require('../lib/text');
const CMDS = require('../lib/commands');

/** @param {any} message @param {any} configuration @param {number} now */
function authorize(message, configuration, now) {
  if (!message || message.sender?.sender_type !== 'user' || message.sender.id_type !== 'open_id' ||
      message.sender.id !== configuration.owner || message.chat_id !== configuration.chat || message.deleted) {
    throw new Error('只允许管理员私聊中的原始消息');
  }
  const createdAt = Number(message.create_time);
  const updatedAt = Number(message.update_time || message.create_time);
  if (!Number.isFinite(createdAt) || now - createdAt > 10 * 60000 || createdAt > now + 30000) {
    throw new Error('消息已过期或时间异常，请重新发送');
  }
  // 飞书偶发把新建消息标成 updated=true，但真实编辑会推进 update_time。
  if (!Number.isFinite(updatedAt) || updatedAt > createdAt) throw new Error('消息已被编辑，请重新发送');
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
  let descriptor;
  try {
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) return '';
    descriptor = fs.openSync(path.join(root, 'index.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) return '';
    entries = JSON.parse(fs.readFileSync(descriptor, 'utf8')).items[key];
  } catch { return ''; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  if (!Array.isArray(entries)) return '';
  const lines = [];
  for (const item of entries.slice(-10)) {
    // 现有图片按日期分目录；接受该布局，同时拒绝越界路径和目录/文件链接。
    if (!item || !Number.isSafeInteger(item.n) || item.n < 1 ||
        !/^(?:\d{4}-\d{2}-\d{2}\/)?[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|gif|webp|bmp|heic)$/.test(item.file)) continue;
    const filename = path.join(root, item.file);
    try {
      const parent = fs.lstatSync(path.dirname(filename));
      const stat = fs.lstatSync(filename);
      if (!parent.isDirectory() || parent.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
      lines.push('第' + item.n + '张图片：' + filename);
    } catch { /* 图片可能被正常保留期清理，不影响其它图片与本轮文本任务。 */ }
  }
  return lines.join('\n');
}

module.exports = { authorize, childEnvironment, imageContext };
