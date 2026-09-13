'use strict';

const crypto = require('crypto');

// 杂项小工具。都是纯函数或只依赖入参。

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// 把飞书 SDK 抛出的错误整理成一行可读文本
/**
 * @param {any} e
 * @returns {string}
 */
function errText(e) {
  if (!e) return '未知错误';
  const detail = (e.response && e.response.data && (e.response.data.msg || e.response.data.message)) || '';
  const code = e.code || (e.response && e.response.data && e.response.data.code) || '';
  const msg = e.message || String(e);
  return (code ? '[' + code + '] ' : '') + (detail || msg);
}

// 令牌比较：先各自 sha256 再定时比较，避免按长度泄漏
/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function tokenEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 本地日期键 YYYY-MM-DD。日期从外面传进来，方便测
/**
 * @param {Date} [date] 不传用当前时间
 * @returns {string}
 */
function localDateKey(date) {
  const d = date || new Date();
  /** @param {number} n */
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

module.exports = {
  sleep: sleep,
  errText: errText,
  tokenEqual: tokenEqual,
  localDateKey: localDateKey,
};
