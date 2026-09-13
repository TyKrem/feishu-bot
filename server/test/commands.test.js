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

// 单次提醒查询（飞书里发「任务」）。时间相关的断言都传固定的 now，
// 否则跑测试的钟点一变，期望值就跟着变。

test('isOnceTasksCommand 只认整句关键字', function () {
  assert.strictEqual(CMDS.isOnceTasksCommand('任务'), true);
  assert.strictEqual(CMDS.isOnceTasksCommand('  任务 '), true);
  assert.strictEqual(CMDS.isOnceTasksCommand('.tasks'), true);
  assert.strictEqual(CMDS.isOnceTasksCommand('.task'), true);
  assert.strictEqual(CMDS.isOnceTasksCommand('单次任务'), true);
  // 带内容的句子不能被当成查询吞掉
  assert.strictEqual(CMDS.isOnceTasksCommand('任务：写周报'), false);
  assert.strictEqual(CMDS.isOnceTasksCommand('加任务 买菜'), false);
  assert.strictEqual(CMDS.isOnceTasksCommand('待办'), false);
  assert.strictEqual(CMDS.isOnceTasksCommand(''), false);
});

test('onceTasksText 空列表给提示', function () {
  const out = CMDS.onceTasksText([], Date.now());
  assert.ok(out.indexOf('没有待执行的单次提醒') >= 0, out);
  assert.ok(out.indexOf('提醒我喝水') >= 0, '应告诉用户怎么新建：' + out);
});

test('onceTasksText 列出时间、剩余与多行内容', function () {
  const now = new Date(2026, 8, 13, 17, 30, 0).getTime();   // 9 月 13 日 17:30
  const out = CMDS.onceTasksText([
    { text: '⏰ 提醒：预约螃蟹\n卡号：11880395', runAt: new Date(2026, 8, 13, 21, 0, 0).getTime(), scheduled: true },
    { text: '明天体检', runAt: new Date(2026, 8, 14, 8, 0, 0).getTime(), scheduled: true },
    { text: '后台任务', runAt: new Date(2026, 9, 10, 10, 0, 0).getTime(), scheduled: false },
  ], now);
  assert.ok(out.indexOf('待执行的单次提醒（3 条）') >= 0, out);
  assert.ok(out.indexOf('1. 今天 21:00（还有 3 小时 30 分）') >= 0, out);
  assert.ok(out.indexOf('2. 明天 08:00') >= 0, out);
  assert.ok(out.indexOf('10 月 10 日 10:00') >= 0, out);
  // 多行内容缩进，卡密这类字段不会跟序号混在一起
  assert.ok(out.indexOf('\n   ⏰ 提醒：预约螃蟹\n   卡号：11880395') >= 0, out);
  // cron 不在了要提醒
  assert.ok(out.indexOf('未排计划') >= 0, out);
  assert.ok(out.indexOf('未排计划') < out.indexOf('后台任务'), '警告要跟在对应那条上');
});

test('onceTasksText 时间缺失或已过期不报错', function () {
  const now = Date.now();
  const out = CMDS.onceTasksText([
    { text: '没时间', runAt: null },
    { text: '已经过了', runAt: now - 60000 },
  ], now);
  assert.ok(out.indexOf('时间未知') >= 0, out);
  assert.ok(out.indexOf('即将执行') >= 0, out);
});
