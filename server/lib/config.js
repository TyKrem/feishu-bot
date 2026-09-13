'use strict';

// 环境变量与配置文本的解析。全是纯函数，从 server.js 抽出来便于单测。

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
  splitList: splitList,
  parseKeyMap: parseKeyMap,
  reverseMap: reverseMap,
  tomlValue: tomlValue,
};
