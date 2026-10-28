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

/* ---------------------------------------------------------------
 * 服务器类指令：状态 / 余额 / 定时器
 *
 * 这些信息要么涉及服务器内部结构，要么是私事，都不适合放在公开的
 * 监控页上，所以放在飞书里查——只有白名单账号能用，受限账号不给。
 * 纯解析与拼文本在这里，跑 systemctl / 调接口留在 server.js。
 * --------------------------------------------------------------- */

// 只认整句，免得把「状态怎么样」这类正文吞掉
const STATUS_RE = /^(?:\.status|状态|服务器状态|巡检|服务器巡检|健康检查)$/i;
const BALANCE_RE = /^(?:\.balance|余额|api\s*余额|deepseek\s*(?:api\s*)?余额)$/i;
const TIMERS_RE = /^(?:\.timers?|定时器|计时器|定时任务|计划任务)$/i;

/**
 * @param {unknown} text
 * @returns {boolean}
 */
function isStatusCommand(text) {
  return STATUS_RE.test(String(text || '').trim());
}

/**
 * 查询 DeepSeek 官方 API 余额。
 * @param {unknown} text
 * @returns {boolean}
 */
function isBalanceCommand(text) {
  return BALANCE_RE.test(String(text || '').trim());
}

/**
 * @param {unknown} text
 * @returns {boolean}
 */
function isTimersCommand(text) {
  return TIMERS_RE.test(String(text || '').trim());
}

// 知识库查询：`知识库 飞书` / `.kb 定时器 失败`。
// 返回关键词串（可能为空，表示只发了指令名），不是知识库指令时返回 null。
/**
 * @param {unknown} text
 * @returns {string|null}
 */
function kbQuery(text) {
  const m = /^(?:\.kb|知识库|查知识库|知识库查询)\s*[:：]?\s*(.*)$/i.exec(String(text || '').trim());
  return m ? m[1].trim() : null;
}

/**
 * @param {number} now
 * @returns {string}
 */
function stamp(now) {
  const d = new Date(now);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/**
 * DeepSeek 余额接口目前可能返回 CNY 或 USD；不要一律写成人民币。
 * @param {string|undefined} currency
 * @param {unknown} value
 * @returns {string}
 */
function fmtMoney(currency, value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : (currency ? currency + ' ' : '');
  return symbol + amount.toFixed(2);
}

/**
 * 巡检脚本的输出直接给用户看：脚本本身就按人读的格式打印，
 * 这里只加一个结论头，不重新解析（解析反而容易漏信息）。
 * @param {string} output
 * @param {number} exitCode
 * @param {number} now
 * @returns {string}
 */
function healthText(output, exitCode, now) {
  const head = exitCode === 0 ? '✅ 服务器巡检正常' : '⚠️ 服务器巡检有异常';
  const body = String(output || '').trim();
  if (!body) return head + '（' + stamp(now) + '）\n没有拿到巡检输出，看看 server-ops-healthcheck 的日志。';
  return head + '（' + stamp(now) + '）\n' + body;
}

/**
 * 解析 `systemctl list-timers --all --no-legend --plain`。
 *
 * 列是按宽度对齐的，但 LEFT 列会撑满（`1h 8min left` 后面只剩一个空格），
 * 按空白切列会错位；时间也只取 `YYYY-MM-DD HH:MM:SS`，不碰星期与时区——
 * 本机 locale 异常时星期会变成数字，时区里的 CST 又会被 V8 当成美国中部时间。
 *
 * @param {string} text
 * @returns {Array<{unit: string, activated: string, nextText: string, lastText: string}>}
 */
function timerRows(text) {
  /** @type {Array<{unit: string, activated: string, nextText: string, lastText: string}>} */
  const rows = [];
  String(text || '').split('\n').forEach(function (line) {
    const trimmed = line.replace(/\s+$/, '');
    if (!trimmed.trim()) return;
    const tail = /(\S+\.timer)\s+(\S+)\s*$/.exec(trimmed);
    if (!tail) return;
    const dates = trimmed.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g) || [];
    const inactive = /^n\/a\b/.test(trimmed);
    rows.push({
      unit: tail[1],
      activated: tail[2],
      nextText: inactive ? '' : (dates[0] || ''),
      lastText: inactive ? (dates[0] || '') : (dates[1] || ''),
    });
  });
  return rows;
}

/**
 * `systemctl show a.service b.service -p Id -p Result` 的分块输出 → { 单元名: 结果 }
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseShowResults(text) {
  /** @type {Record<string, string>} */
  const out = {};
  String(text || '').split(/\n\s*\n/).forEach(function (block) {
    let id = '';
    let result = '';
    block.split('\n').forEach(function (line) {
      const m = /^(Id|Result)=(.*)$/.exec(line.trim());
      if (!m) return;
      if (m[1] === 'Id') id = m[2].trim();
      else result = m[2].trim();
    });
    if (id) out[id] = result || 'unknown';
  });
  return out;
}

/**
 * `systemctl --failed --no-legend --plain` → 失败单元名
 * @param {string} text
 * @returns {string[]}
 */
function parseFailedUnits(text) {
  return String(text || '')
    .split('\n')
    .map(function (line) { return line.trim().split(/\s+/)[0]; })
    .filter(function (name) { return /\.(service|timer|socket|mount|target)$/.test(name || ''); });
}

/**
 * `2026-09-18 04:20:00` → `09-18 04:20`
 * @param {unknown} text
 * @returns {string}
 */
function shortWhen(text) {
  const m = /\d{4}-(\d{2}-\d{2})\s+(\d{2}:\d{2})/.exec(String(text || ''));
  return m ? m[1] + ' ' + m[2] : '--';
}

/** @type {Record<string, string>} */
const RESULT_LABEL = {
  success: '成功',
  exited: '已退出',
  'signal': '被信号终止',
  'core-dump': '崩溃',
  timeout: '超时',
  failed: '失败',
};

/**
 * 定时器清单文本：只列还在运行的（停用的单独给个数字），
 * 顺带带上上次运行结果——AGENTS 里的验证要求就是「timer active + 上次 success」。
 * @param {Array<{unit: string, activated: string, nextText: string, lastText: string}>} rows
 * @param {Record<string, string>} results 激活单元 → Result
 * @param {string[]} failedUnits `systemctl --failed` 的单元名
 * @param {number} now
 * @returns {string}
 */
function timersText(rows, results, failedUnits, now) {
  const list = Array.isArray(rows) ? rows : [];
  const active = list.filter(function (r) { return !!r.nextText; });
  const failed = Array.isArray(failedUnits) ? failedUnits : [];
  const lines = ['⏱ 定时器（' + active.length + ' / ' + list.length + ' 运行中 · 失败单元 ' + failed.length + ' 个）'];
  if (!active.length) {
    lines.push('（没有正在运行的定时器）');
  }
  active.forEach(function (row) {
    const result = (results || {})[row.activated];
    const label = result ? (RESULT_LABEL[result] || result) : '未知';
    const bad = result && result !== 'success' ? ' ⚠️' : '';
    lines.push('· ' + row.unit.replace(/\.timer$/, '') +
      ' · 下次 ' + shortWhen(row.nextText) +
      ' · 上次 ' + shortWhen(row.lastText) + ' ' + label + bad);
  });
  if (list.length > active.length) {
    lines.push('（另有 ' + (list.length - active.length) + ' 个已停用的定时器，不在上面）');
  }
  if (failed.length) lines.push('⚠️ 失败单元：' + failed.join('、'));
  return lines.join('\n') + '\n（' + stamp(now) + '）';
}

/**
 * DeepSeek 官方 API 余额。
 * @param {{isAvailable?: boolean, balances?: Array<{currency?: string, total?: string, granted?: string, toppedUp?: string}>}|null} balance
 * @param {number} now
 * @returns {string}
 */
function balanceText(balance, now) {
  const lines = ['💰 DeepSeek API 余额（' + stamp(now) + '）'];
  const rows = (balance && balance.balances) || [];
  if (rows.length) {
    rows.forEach(function (row) {
      lines.push('· 可用 ' + fmtMoney(row.currency, row.total) +
        '（充值 ' + fmtMoney(row.currency, row.toppedUp) +
        ' / 赠送 ' + fmtMoney(row.currency, row.granted) + '）');
    });
    if (balance && balance.isAvailable === false) lines.push('⚠️ 当前余额不足，API 调用可能失败');
  } else {
    lines.push('· 余额：拿不到');
  }
  return lines.join('\n');
}

module.exports = {
  rollDiceText: rollDiceText,
  isOnceTasksCommand: isOnceTasksCommand,
  onceTasksText: onceTasksText,
  isStatusCommand: isStatusCommand,
  isBalanceCommand: isBalanceCommand,
  isTimersCommand: isTimersCommand,
  kbQuery: kbQuery,
  healthText: healthText,
  balanceText: balanceText,
  timerRows: timerRows,
  parseShowResults: parseShowResults,
  parseFailedUnits: parseFailedUnits,
  shortWhen: shortWhen,
  timersText: timersText,
};
