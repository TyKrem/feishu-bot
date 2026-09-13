'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const CMDS = require('../lib/commands.js');

// 骰子结果本身是随机的，这里只断言确定性的部分：参数校验、用法提示、格式

test('rollDiceText 参数非法时给提示', function () {
  assert.strictEqual(CMDS.rollDiceText('.rand 1d1'), '.rand 参数无效，请使用例如：3d10、2d6+1、d20');
  assert.strictEqual(CMDS.rollDiceText('.rand 1001d6'), '.rand 参数无效，请使用例如：3d10、2d6+1、d20');
  assert.strictEqual(CMDS.rollDiceText('.rand 1d100001'), '.rand 参数无效，请使用例如：3d10、2d6+1、d20');
});

test('rollDiceText 认不出表达式时给用法', function () {
  assert.strictEqual(CMDS.rollDiceText('.rand'), '🎲 用法：.rand 3d10，也支持 2d6+1、d20');
  assert.strictEqual(CMDS.rollDiceText('.rand 随便写点'), '🎲 用法：.rand 3d10，也支持 2d6+1、d20');
});

test('rollDiceText 点数落在合法区间', function () {
  const out = CMDS.rollDiceText('.rand 3d6');
  const m = /→ ([\d +]+) = (\d+)/.exec(out);
  assert.ok(m, '输出里应含点数：' + out);
  const rolls = m[1].trim().split(/\s*\+\s*/).map(Number);
  assert.strictEqual(rolls.length, 3);
  rolls.forEach(function (r) {
    assert.ok(r >= 1 && r <= 6, '点数应在 1~6，实际 ' + r);
  });
  assert.strictEqual(Number(m[2]), rolls.reduce(function (a, b) { return a + b; }, 0));
});

test('rollDiceText 支持调整值与多组求和', function () {
  const one = CMDS.rollDiceText('.rand d20+3');
  assert.ok(one.indexOf('含调整 +3') >= 0, '单个表达式应显示调整值：' + one);
  const many = CMDS.rollDiceText('.rand 2d6 1d10');
  assert.ok(many.indexOf('总计') >= 0, '多组应给总计：' + many);
});

test('rollDiceText 认中文别名', function () {
  assert.ok(CMDS.rollDiceText('骰子 1d6').indexOf('🎲') === 0);
});
