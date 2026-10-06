'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { codexFailureMessage } = require('../lib/codex-error.js');

test('读取 stdout 失败事件及嵌套接口错误', function () {
  const message = '当前账号不支持这个模型';
  const nested = JSON.stringify({ type: 'error', status: 400, error: { message: message } });
  assert.equal(codexFailureMessage({ type: 'error', message: nested }), message);
  assert.equal(codexFailureMessage({ type: 'turn.failed', error: { message: nested } }), message);
  assert.equal(codexFailureMessage({ type: 'error', message: '连接失败' }), '连接失败');
});

test('忽略提示与缺失详情，限制异常输出长度', function () {
  assert.equal(codexFailureMessage({ type: 'item.completed', item: { type: 'error', message: '模型已切换' } }), '');
  assert.equal(codexFailureMessage({ type: 'turn.completed' }), '');
  assert.equal(codexFailureMessage(null), '');
  assert.equal(codexFailureMessage({ type: 'turn.failed', error: {} }), '');
  assert.equal(codexFailureMessage({ type: 'error', message: '错'.repeat(3000) }).length, 2000);
});
