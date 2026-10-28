'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const CMDS = require('../lib/commands.js');

// 服务器类指令（状态 / 余额 / 定时器）的纯逻辑。
// 这些信息不放公开的监控页，改在飞书里查，所以格式和边界都钉在这里。

test('服务器指令只认整句，不吞正文', function () {
  assert.ok(CMDS.isStatusCommand('状态'));
  assert.ok(CMDS.isStatusCommand('巡检'));
  assert.ok(CMDS.isStatusCommand('.status'));
  assert.ok(CMDS.isBalanceCommand('余额'));
  assert.ok(CMDS.isBalanceCommand('.balance'));
  assert.ok(CMDS.isBalanceCommand('DeepSeek余额'));
  assert.ok(CMDS.isBalanceCommand('Api 余额'));
  assert.ok(CMDS.isTimersCommand('定时器'));
  assert.ok(CMDS.isTimersCommand('计时器'));
  // 带上下文的话不能当指令，否则「状态怎么样」就发不出去了
  assert.ok(!CMDS.isStatusCommand('状态怎么样'));
  assert.ok(!CMDS.isBalanceCommand('余额还有多少'));
  assert.ok(!CMDS.isTimersCommand('定时器列表'));
  assert.ok(!CMDS.isStatusCommand(''));
});

test('healthText 按退出码给结论并保留原文', function () {
  const now = new Date(2026, 8, 17, 20, 5).getTime();
  const ok = CMDS.healthText('== systemd 服务 ==\n  ok   nginx\n\n全部正常。\n', 0, now);
  assert.ok(ok.indexOf('✅ 服务器巡检正常') === 0, ok);
  assert.ok(ok.indexOf('09-17 20:05') > 0, ok);
  assert.ok(ok.indexOf('全部正常。') > 0, ok);
  const bad = CMDS.healthText('  FAIL nginx\n', 1, now);
  assert.ok(bad.indexOf('⚠️ 服务器巡检有异常') === 0, bad);
  assert.ok(CMDS.healthText('', 1, now).indexOf('没有拿到巡检输出') > 0);
});

test('timerRows 解析 list-timers，LEFT 撑满也不串列', function () {
  const text = [
    'NEXT                         LEFT          LAST                         PASSED       UNIT                         ACTIVATES',
    'Thu 2026-09-17 20:00:00 CST  8min left    Thu 2026-09-17 19:45:00 CST  6min ago   server-ops-healthcheck.timer        server-ops-healthcheck.service',
    'Thu 2026-09-17 21:00:00 CST  1h 8min left Wed 2026-09-16 21:00:00 CST  22h ago    scheduler-daily-report.timer        scheduler-daily-report.service',
    'n/a                          n/a          Mon 2026-09-14 06:00:01 CST  3 days ago model-switch-20260914.timer         model-switch-20260914.service',
  ].join('\n');
  const rows = CMDS.timerRows(text);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], {
    unit: 'server-ops-healthcheck.timer',
    activated: 'server-ops-healthcheck.service',
    nextText: '2026-09-17 20:00:00',
    lastText: '2026-09-17 19:45:00',
  });
  assert.strictEqual(rows[1].nextText, '2026-09-17 21:00:00');
  assert.strictEqual(rows[2].nextText, '', '停用的定时器没有下次时间');
  assert.strictEqual(rows[2].lastText, '2026-09-14 06:00:01');
  assert.deepStrictEqual(CMDS.timerRows('0 timers listed.'), []);
});

test('parseShowResults 把 Id 与 Result 配对', function () {
  const text = [
    'Result=success',
    'Id=backup-data.service',
    '',
    'Result=failed',
    'Id=scheduler-daily-report.service',
    '',
  ].join('\n');
  assert.deepStrictEqual(CMDS.parseShowResults(text), {
    'backup-data.service': 'success',
    'scheduler-daily-report.service': 'failed',
  });
  assert.deepStrictEqual(CMDS.parseShowResults(''), {});
});

test('parseFailedUnits 取单元名', function () {
  assert.deepStrictEqual(CMDS.parseFailedUnits('foo.service loaded failed failed Foo\n'), ['foo.service']);
  assert.deepStrictEqual(CMDS.parseFailedUnits('0 loaded units listed.'), []);
});

test('timersText 只列运行中的，标出上次失败与失败单元', function () {
  const rows = [
    { unit: 'backup-data.timer', activated: 'backup-data.service', nextText: '2026-09-18 04:20:00', lastText: '2026-09-17 04:20:00' },
    { unit: 'scheduler-daily-report.timer', activated: 'scheduler-daily-report.service', nextText: '2026-09-17 21:00:00', lastText: '2026-09-16 21:00:00' },
    { unit: 'model-switch-20260914.timer', activated: 'model-switch-20260914.service', nextText: '', lastText: '2026-09-14 06:00:00' },
  ];
  const now = new Date(2026, 8, 17, 20, 5).getTime();
  const out = CMDS.timersText(rows, { 'backup-data.service': 'success', 'scheduler-daily-report.service': 'failed' }, ['foo.timer'], now);
  assert.ok(out.indexOf('⏱ 定时器（2 / 3 运行中 · 失败单元 1 个）') === 0, out);
  assert.ok(out.indexOf('· backup-data · 下次 09-18 04:20 · 上次 09-17 04:20 成功') > 0, out);
  assert.ok(out.indexOf('scheduler-daily-report · 下次 09-17 21:00 · 上次 09-16 21:00 失败 ⚠️') > 0, out);
  assert.ok(out.indexOf('model-switch-20260914') < 0, '停用的定时器不列出来：' + out);
  assert.ok(out.indexOf('另有 1 个已停用的定时器') > 0, out);
  assert.ok(out.indexOf('失败单元：foo.timer') > 0, out);
  assert.ok(out.indexOf('09-17 20:05') > 0, out);
});

test('timersText 没有运行中的定时器也给准话', function () {
  const out = CMDS.timersText([], {}, [], Date.now());
  assert.ok(out.indexOf('⏱ 定时器（0 / 0 运行中') === 0, out);
  assert.ok(out.indexOf('没有正在运行的定时器') > 0, out);
  assert.ok(out.indexOf('未知') < 0, '没有条目就不该出现「未知」：' + out);
});

test('shortWhen 把 systemctl 时间缩成 MM-DD HH:MM', function () {
  assert.strictEqual(CMDS.shortWhen('2026-09-18 04:20:00'), '09-18 04:20');
  assert.strictEqual(CMDS.shortWhen(''), '--');
  assert.strictEqual(CMDS.shortWhen(null), '--');
});

test('balanceText 只展示 DeepSeek 官方余额并区分币种', function () {
  const now = new Date(2026, 9, 28, 13, 30).getTime();
  const out = CMDS.balanceText({ isAvailable: true, balances: [
    { currency: 'CNY', total: '80.49', granted: '0.00', toppedUp: '80.49' },
    { currency: 'USD', total: '1.20', granted: '0.20', toppedUp: '1.00' },
  ] }, now);
  assert.equal(out, [
    '💰 DeepSeek API 余额（10-28 13:30）',
    '· 可用 ¥80.49（充值 ¥80.49 / 赠送 ¥0.00）',
    '· 可用 $1.20（充值 $1.00 / 赠送 $0.20）',
  ].join('\n'));
  assert.ok(out.indexOf('Token') < 0);
});

test('balanceText 对不可用余额和空响应给出明确状态', function () {
  const unavailable = CMDS.balanceText({ isAvailable: false, balances: [
    { currency: 'CNY', total: '0.00', granted: '0.00', toppedUp: '0.00' },
  ] }, Date.now());
  assert.ok(unavailable.indexOf('当前余额不足') > 0, unavailable);
  assert.ok(CMDS.balanceText(null, Date.now()).indexOf('余额：拿不到') > 0);
});
