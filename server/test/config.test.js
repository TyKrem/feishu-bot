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
