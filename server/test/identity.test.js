'use strict';

const test = require('node:test');
const assert = require('node:assert');
const IDENT = require('../lib/identity.js');

// 本文件里的身份、映射一律用假值（ou_a、10001 这种）。
// 仓库是公开的，别图省事粘真实 open_id 或旧 QQ 号。

test('senderIds 取三种 id 并丢掉空值', function () {
  assert.deepStrictEqual(
    IDENT.senderIds({ sender_id: { open_id: 'ou_a', user_id: 'u_1', union_id: 'on_1' } }),
    ['ou_a', 'u_1', 'on_1']
  );
  assert.deepStrictEqual(IDENT.senderIds({ sender_id: { open_id: 'ou_a', user_id: '  ' } }), ['ou_a']);
  assert.deepStrictEqual(IDENT.senderIds({}), []);
  assert.deepStrictEqual(IDENT.senderIds(null), []);
});

test('matches 空名单一律不放行', function () {
  // 这条是安全相关：白名单没配时必须拒绝，不能变成"谁都能进"
  assert.strictEqual(IDENT.matches([], ['ou_a']), false);
  assert.strictEqual(IDENT.matches(null, ['ou_a']), false);
  assert.strictEqual(IDENT.matches(['ou_a'], ['ou_a']), true);
  // 三个 id 里任意一个命中即可
  assert.strictEqual(IDENT.matches(['u_1'], ['ou_a', 'u_1']), true);
  assert.strictEqual(IDENT.matches(['ou_b'], ['ou_a']), false);
});

test('lifeKey 优先映射，否则退回第一个 id', function () {
  const map = { ou_a: '10001' };
  assert.strictEqual(IDENT.lifeKey(['ou_a', 'u_1'], map), '10001');
  assert.strictEqual(IDENT.lifeKey(['ou_unknown', 'u_1'], map), 'ou_unknown');
  assert.strictEqual(IDENT.lifeKey([], map), '');
  assert.strictEqual(IDENT.lifeKey(['ou_a'], null), 'ou_a');
});

test('primaryId 反查飞书身份', function () {
  const reverse = { '10001': 'ou_a' };
  assert.strictEqual(IDENT.primaryId(['10001'], reverse), 'ou_a');
  assert.strictEqual(IDENT.primaryId(['ou_unknown'], reverse), 'ou_unknown');
  assert.strictEqual(IDENT.primaryId([], reverse), '');
});

test('mentionIsBot 判定规则', function () {
  const byId = { mentions: [{ id: { open_id: 'ou_bot' } }] };
  const byName = { mentions: [{ name: '小助手' }] };
  const other = { mentions: [{ id: { open_id: 'ou_someone' }, name: '别人' }] };
  assert.strictEqual(IDENT.mentionIsBot({ mentions: [] }, 'ou_bot', '小助手'), false);
  assert.strictEqual(IDENT.mentionIsBot(null, 'ou_bot', '小助手'), false);
  assert.strictEqual(IDENT.mentionIsBot(byId, 'ou_bot', '小助手'), true);
  assert.strictEqual(IDENT.mentionIsBot(byName, 'ou_bot', '小助手'), true);
  assert.strictEqual(IDENT.mentionIsBot(other, 'ou_bot', '小助手'), false);
  // 没配置机器人身份时，只要有 @ 就算呼叫
  assert.strictEqual(IDENT.mentionIsBot(other, '', ''), true);
});

test('resolveNotifyTarget 的优先级', function () {
  const reverse = { '10001': 'ou_mapped' };
  // 显式 open_id 最高
  assert.deepStrictEqual(
    IDENT.resolveNotifyTarget({ open_id: 'ou_x', chat_id: 'oc_y', qq: '10001' }, reverse, 'ou_default'),
    { kind: 'user', id: 'ou_x', label: 'ou_x' }
  );
  // 其次 chat_id
  assert.deepStrictEqual(
    IDENT.resolveNotifyTarget({ chat_id: 'oc_y', qq: '10001' }, reverse, 'ou_default'),
    { kind: 'chat', id: 'oc_y', label: 'oc_y' }
  );
  // 旧 QQ 号查映射
  assert.deepStrictEqual(
    IDENT.resolveNotifyTarget({ qq: '10001' }, reverse, 'ou_default'),
    { kind: 'user', id: 'ou_mapped', label: 'ou_mapped' }
  );
  // 映射里没有但本身就是 open_id → 直接用
  assert.deepStrictEqual(
    IDENT.resolveNotifyTarget({ qq: 'ou_direct' }, reverse, 'ou_default'),
    { kind: 'user', id: 'ou_direct', label: 'ou_direct' }
  );
  // 都没有 → 默认收件人
  assert.deepStrictEqual(
    IDENT.resolveNotifyTarget({}, reverse, 'ou_default'),
    { kind: 'user', id: 'ou_default', label: 'ou_default' }
  );
  // 连默认都没有 → null
  assert.strictEqual(IDENT.resolveNotifyTarget({}, reverse, ''), null);
});
