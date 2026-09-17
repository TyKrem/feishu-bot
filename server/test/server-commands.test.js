'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const CMDS = require('../lib/commands.js');

// 服务器类指令（状态 / 用量 / 定时器）的纯逻辑。
// 这些信息不放公开的监控页，改在飞书里查，所以格式和边界都钉在这里。

test('服务器指令只认整句，不吞正文', function () {
  assert.ok(CMDS.isStatusCommand('状态'));
  assert.ok(CMDS.isStatusCommand('巡检'));
  assert.ok(CMDS.isStatusCommand('.status'));
  assert.ok(CMDS.isUsageCommand('用量'));
  assert.ok(CMDS.isUsageCommand('余额'));
  assert.ok(CMDS.isTimersCommand('定时器'));
  assert.ok(CMDS.isTimersCommand('计时器'));
  // 带上下文的话不能当指令，否则「状态怎么样」就发不出去了
  assert.ok(!CMDS.isStatusCommand('状态怎么样'));
  assert.ok(!CMDS.isUsageCommand('用量是多少'));
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

test('fmtTokens 大数字用万 / 亿', function () {
  assert.strictEqual(CMDS.fmtTokens(999), '999');
  assert.strictEqual(CMDS.fmtTokens(12345), '1.2 万');
  assert.strictEqual(CMDS.fmtTokens(9153725), '915.4 万');
  assert.strictEqual(CMDS.fmtTokens(123456789), '1.23 亿');
  assert.strictEqual(CMDS.fmtTokens(null), '0');
});

test('usageText 汇总余额、最近记录与累计', function () {
  const now = new Date(2026, 8, 17, 20, 5).getTime();
  const out = CMDS.usageText(
    { isAvailable: true, balances: [{ currency: 'CNY', total: '67.75', granted: '0.00', toppedUp: '67.75' }] },
    {
      conversations: 3,
      messages: 23,
      totalTokens: 9153725,
      totals: { input: 9053038, output: 100687 },
      last14: [
        { date: '2026-09-10', input: 100, output: 10 },
        { date: '2026-09-11', input: 4826541, output: 46514 },
      ],
    },
    now
  );
  assert.ok(out.indexOf('💰 用量与余额（09-17 20:05）') === 0, out);
  assert.ok(out.indexOf('余额 ¥67.75（充值 67.75 / 赠送 0.00）') > 0, out);
  assert.ok(out.indexOf('最近记录 2026-09-11：输入 482.7 万 / 输出 4.7 万 tok') > 0, out);
  assert.ok(out.indexOf('近 14 天：487.3 万 tok') > 0, out);
  assert.ok(out.indexOf('累计：对话 3 个 · 消息 23 条 · 915.4 万 tok') > 0, out);
});

test('usageText 拿不到余额或用量时不炸', function () {
  const out = CMDS.usageText(null, null, Date.now());
  assert.ok(out.indexOf('余额：拿不到') > 0, out);
  assert.strictEqual(out.split('\n').length, 2, '只有标题与余额一行：' + out);
  const unavailable = CMDS.usageText({ isAvailable: false, balances: [] }, null, Date.now());
  assert.ok(unavailable.indexOf('接口说不可用') > 0, unavailable);
  // 有 totals 但 last14 是空的：不硬凑「近 14 天」，累计照常给
  const noDaily = CMDS.usageText(null, { totals: { input: 10, output: 5 }, last14: [], totalTokens: 15 }, Date.now());
  assert.ok(noDaily.indexOf('undefined') < 0, noDaily);
  assert.ok(noDaily.indexOf('近 14 天') < 0, noDaily);
  assert.ok(noDaily.indexOf('累计：对话 0 个 · 消息 0 条 · 15 tok') > 0, noDaily);
});
