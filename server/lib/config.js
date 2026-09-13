'use strict';

// 环境变量与配置文本的解析。全是纯函数，从 server.js 抽出来便于单测。

/**
 * @typedef {{ minMs: number, maxMs: number }} DelayRange
 */

// 把 "0.8" / "1.5" 这类文本转成秒数；非法或负数返回 NaN，交给调用方决定默认值
/**
 * @param {unknown} v
 * @returns {number} 秒数，非法输入为 NaN
 */
function toDelaySeconds(v) {
  const n = parseFloat(String(v));
  return isFinite(n) && n >= 0 ? n : NaN;
}

// 解析"回复随机延迟"：
//   FEISHU_REPLY_DELAY 形如 "0.8-2.5" 或 "2.5"（只给一个数时视为上限，下限 0）
//   FEISHU_REPLY_DELAY_MIN / MAX 单独覆盖上下限
// 解析不出任何数时回落到默认的 0.8~2.5 秒。上下限反了就交换。
/**
 * @param {unknown} rangeRaw
 * @param {unknown} minRaw
 * @param {unknown} maxRaw
 * @returns {DelayRange}
 */
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

// 从区间里取一个延迟毫秒数。random01 单独传是为了能测——生产上传 Math.random()
/**
 * @param {DelayRange} range
 * @param {number} random01 [0,1) 的随机数
 * @returns {number} 毫秒
 */
function pickDelayMs(range, random01) {
  const lo = Number((range && range.minMs) || 0);
  const hi = Number((range && range.maxMs) || 0);
  if (hi <= 0) return 0;
  if (hi <= lo) return hi;
  return lo + Math.floor(Number(random01) * (hi - lo + 1));
}

// 逗号分隔的列表，去空白、丢空项
/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function splitList(raw) {
  return String(raw || '')
    .split(',')
    .map(function (x) { return x.trim(); })
    .filter(Boolean);
}

// 解析 "ou_xxx=123456,ou_yyy=654321" 这种身份映射
/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function parseKeyMap(raw) {
  /** @type {Record<string, string>} */
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

// 反转映射；同一个值被多个键指向时保留第一个
/**
 * @param {Record<string, string>} map
 * @returns {Record<string, string>}
 */
function reverseMap(map) {
  /** @type {Record<string, string>} */
  const out = {};
  Object.keys(map || {}).forEach(function (k) { if (!out[map[k]]) out[map[k]] = k; });
  return out;
}

// 从 tomllib 风格文本里取 key = "value" 的字符串值
/**
 * @param {unknown} text
 * @param {string} key
 * @returns {string} 取不到返回空串
 */
function tomlValue(text, key) {
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*"([^"]*)"', 'm');
  const m = re.exec(String(text == null ? '' : text));
  return m ? m[1] : '';
}

module.exports = {
  toDelaySeconds: toDelaySeconds,
  parseReplyDelay: parseReplyDelay,
  pickDelayMs: pickDelayMs,
  splitList: splitList,
  parseKeyMap: parseKeyMap,
  reverseMap: reverseMap,
  tomlValue: tomlValue,
};
