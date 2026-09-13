'use strict';

const test = require('node:test');
const assert = require('node:assert');
const UTIL = require('../lib/util.js');

test('errText 整理错误信息', function () {
  assert.strictEqual(UTIL.errText(null), '未知错误');
  assert.strictEqual(UTIL.errText(new Error('炸了')), '炸了');
  // 带 code 的要带上
  const withCode = new Error('bad');
  withCode.code = 'E_FAIL';
  assert.strictEqual(UTIL.errText(withCode), '[E_FAIL] bad');
  // 飞书 SDK 的 response.data.msg 优先于 message
  assert.strictEqual(
    UTIL.errText({ message: 'fallback', response: { data: { msg: '飞书说不行' } } }),
    '飞书说不行'
  );
  assert.strictEqual(
    UTIL.errText({ message: 'x', response: { data: { code: 999, message: '上游报错' } } }),
    '[999] 上游报错'
  );
});

test('tokenEqual 常数时间比较', function () {
  assert.strictEqual(UTIL.tokenEqual('abc', 'abc'), true);
  assert.strictEqual(UTIL.tokenEqual('abc', 'abd'), false);
  // 长度不同也要能比（先摘要再比），不能抛异常
  assert.strictEqual(UTIL.tokenEqual('abc', 'abcdef'), false);
  assert.strictEqual(UTIL.tokenEqual('', ''), true);
  assert.strictEqual(UTIL.tokenEqual(null, 'null'), true);
});

test('localDateKey 补零', function () {
  assert.strictEqual(UTIL.localDateKey(new Date(2026, 0, 2)), '2026-01-02');
  assert.strictEqual(UTIL.localDateKey(new Date(2026, 11, 31)), '2026-12-31');
  // 不传时用当前时间，只断言格式
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(UTIL.localDateKey()));
});

test('sleep 不早于指定时间返回', async function () {
  const t0 = Date.now();
  await UTIL.sleep(30);
  assert.ok(Date.now() - t0 >= 25, '应至少等待约 30ms');
});
