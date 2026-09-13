'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const CFG = require('../lib/config.js');

test('splitList 去空白丢空项', function () {
  assert.deepStrictEqual(CFG.splitList('ou_a, ou_b ,,ou_c'), ['ou_a', 'ou_b', 'ou_c']);
  assert.deepStrictEqual(CFG.splitList(''), []);
  assert.deepStrictEqual(CFG.splitList(null), []);
  assert.deepStrictEqual(CFG.splitList('  '), []);
});

test('parseKeyMap 只接受 k=v 且两边都非空', function () {
  assert.deepStrictEqual(CFG.parseKeyMap('ou_a=123,ou_b=456'), { ou_a: '123', ou_b: '456' });
  // 缺等号、只有键、只有值，都应当被忽略
  assert.deepStrictEqual(CFG.parseKeyMap('nou_eq,=onlyval,onlykey='), {});
  assert.deepStrictEqual(CFG.parseKeyMap(' a = 1 '), { a: '1' });
  assert.deepStrictEqual(CFG.parseKeyMap(''), {});
});

test('reverseMap 反查，重复值保留第一个键', function () {
  assert.deepStrictEqual(CFG.reverseMap({ a: '1', b: '2' }), { 1: 'a', 2: 'b' });
  assert.deepStrictEqual(CFG.reverseMap({ first: 'x', second: 'x' }), { x: 'first' });
  assert.deepStrictEqual(CFG.reverseMap({}), {});
});

test('tomlValue 只匹配以 key 开头的行，不能串到同前缀的键', function () {
  const text = 'model_provider = "deepseek"\nmodel = "deepseek-flash"\n';
  assert.strictEqual(CFG.tomlValue(text, 'model'), 'deepseek-flash');
  assert.strictEqual(CFG.tomlValue(text, 'model_provider'), 'deepseek');
  // 不存在的键返回空串，不能因为前缀相同就命中
  assert.strictEqual(CFG.tomlValue(text, 'mod'), '');
  assert.strictEqual(CFG.tomlValue('', 'model'), '');
  // 正则元字符要按字面量处理，不能当表达式
  assert.strictEqual(CFG.tomlValue('a.b = "v"', 'a.b'), 'v');
  assert.strictEqual(CFG.tomlValue('axb = "v"', 'a.b'), '');
});

test('toDelaySeconds 非法输入返回 NaN', function () {
  assert.strictEqual(CFG.toDelaySeconds('1.5'), 1.5);
  assert.ok(Number.isNaN(CFG.toDelaySeconds('-1')));
  assert.ok(Number.isNaN(CFG.toDelaySeconds('abc')));
  assert.ok(Number.isNaN(CFG.toDelaySeconds(undefined)));
});

test('parseReplyDelay 各种输入形态', function () {
  // 什么都没配 → 默认 0.8~2.5 秒
  assert.deepStrictEqual(CFG.parseReplyDelay(null, null, null), { minMs: 800, maxMs: 2500 });
  // 区间
  assert.deepStrictEqual(CFG.parseReplyDelay('0.5-3', null, null), { minMs: 500, maxMs: 3000 });
  // 只给一个数时视为上限，下限归 0
  assert.deepStrictEqual(CFG.parseReplyDelay('2', null, null), { minMs: 0, maxMs: 2000 });
  // 单独覆盖上下限优先于区间
  assert.deepStrictEqual(CFG.parseReplyDelay('1-2', '3', '4'), { minMs: 3000, maxMs: 4000 });
  // 上下限写反了要交换
  assert.deepStrictEqual(CFG.parseReplyDelay('5-1', null, null), { minMs: 1000, maxMs: 5000 });
  // 全是垃圾 → 回落默认
  assert.deepStrictEqual(CFG.parseReplyDelay('abc', null, null), { minMs: 800, maxMs: 2500 });
});

test('pickDelayMs 区间取值', function () {
  const range = { minMs: 100, maxMs: 200 };
  // random 由外部传入，所以这里能确定性断言
  assert.strictEqual(CFG.pickDelayMs(range, 0), 100);
  assert.strictEqual(CFG.pickDelayMs(range, 0.99999), 200);
  // 上限是 0 → 不延迟
  assert.strictEqual(CFG.pickDelayMs({ minMs: 0, maxMs: 0 }, 0.5), 0);
  // 上限不大于下限 → 直接取上限
  assert.strictEqual(CFG.pickDelayMs({ minMs: 500, maxMs: 500 }, 0.5), 500);
  assert.strictEqual(CFG.pickDelayMs({ minMs: 500, maxMs: 100 }, 0.5), 100);
});
