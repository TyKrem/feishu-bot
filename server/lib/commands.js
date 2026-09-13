'use strict';

// 内置指令的纯逻辑部分。

// 骰子：支持 .rand 3d10 / 2d6+1 / d20，也认「骰子」前缀。
// 随机数没抽出来，所以这里只测参数校验与用法提示，不断言点数。
/**
 * @param {unknown} text
 * @returns {string} 要回复的文本
 */
function rollDiceText(text) {
  const body = String(text).replace(/^(?:\.(?:rand|r)|骰子|掷骰子?|投骰子?)/i, '').trim();
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

// 单次提醒查询：只认整句「任务」，免得把「任务：写周报」这类的正文吞掉
const ONCE_TASKS_RE = /^(?:\.tasks?|任务|任务列表|单次任务|我的任务)$/i;

/**
 * @param {unknown} text
 * @returns {boolean}
 */
function isOnceTasksCommand(text) {
  return ONCE_TASKS_RE.test(String(text || '').trim());
}

/**
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// 当天零点，用来判断「今天 / 明天 / 后天」
/**
 * @param {number} ts
 * @returns {number}
 */
function dayStart(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * 执行时间：三天内说「今天 / 明天 / 后天 HH:mm」，更远写「M 月 D 日 HH:mm」
 * @param {number} runAt
 * @param {number} now
 * @returns {string}
 */
function onceTaskWhen(runAt, now) {
  const d = new Date(runAt);
  const clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  const days = Math.round((dayStart(runAt) - dayStart(now)) / 86400000);
  if (days === 0) return '今天 ' + clock;
  if (days === 1) return '明天 ' + clock;
  if (days === 2) return '后天 ' + clock;
  return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' + clock;
}

// 聊天里看「还有多久」比看时间点直观
/**
 * @param {number} ms
 * @returns {string}
 */
function fmtRemain(ms) {
  if (ms <= 0) return '即将执行';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return '还有 ' + minutes + ' 分钟';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return '还有 ' + hours + ' 小时 ' + (minutes % 60) + ' 分';
  return '还有 ' + Math.floor(hours / 24) + ' 天 ' + (hours % 24) + ' 小时';
}

/**
 * 单次提醒列表的回复文本
 * @param {Array<{ text: string, runAt: number|null, scheduled?: boolean }>} tasks 已按执行时间排好
 * @param {number} now
 * @returns {string}
 */
function onceTasksText(tasks, now) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) {
    return '📋 当前没有待执行的单次提醒。\n' +
      '直接在飞书里说「今晚 22 点提醒我喝水」，我就给排上一条。';
  }
  const lines = ['📋 待执行的单次提醒（' + list.length + ' 条）'];
  list.forEach(function (task, index) {
    const runAt = task.runAt == null ? null : Number(task.runAt);
    const when = runAt == null ? '时间未知' : onceTaskWhen(runAt, now) + '（' + fmtRemain(runAt - now) + '）';
    // cron 文件不在了说明这条排不上，得说一声，否则到点静悄悄不响
    const warn = task.scheduled === false ? ' ⚠️ 未排计划，可能不会执行' : '';
    lines.push('');
    lines.push((index + 1) + '. ' + when + warn);
    String(task.text || '').split('\n').forEach(function (line) {
      lines.push('   ' + line.trim());
    });
  });
  return lines.join('\n');
}

module.exports = {
  rollDiceText: rollDiceText,
  isOnceTasksCommand: isOnceTasksCommand,
  onceTasksText: onceTasksText,
};
