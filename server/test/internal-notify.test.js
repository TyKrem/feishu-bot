'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createInternalNotifyServer } = require('../lib/internal-notify.js');

/**
 * @param {number} port
 * @param {string} method
 * @param {string} route
 * @param {string} token
 * @param {Record<string, string>|null} body
 */
function request(port, method, route, token, body) {
  return new Promise(function (resolve, reject) {
    const req = http.request({ host: '127.0.0.1', port: port, method: method, path: route,
      headers: token ? { 'X-Notify-Token': token } : {} }, function (res) {
      let text = '';
      res.on('data', function (chunk) { text += chunk; });
      res.on('end', function () { resolve({ status: res.statusCode, body: JSON.parse(text) }); });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : '');
  });
}

test('内部通知接口校验路径、令牌与消息，成功后只投递一次', async function () {
  /** @type {{target: any, text: string}[]} */
  const delivered = [];
  /** @type {{level: string, message: string}[]} */
  const logs = [];
  const server = createInternalNotifyServer({
    token: 'test-token',
    tokenEqual: function (left, right) { return left === right; },
    resolveTarget: function () { return { kind: 'user', id: 'test-user', label: '测试用户' }; },
    deliver: function (target, text) { delivered.push({ target, text }); },
    writeLog: function (level, message) { logs.push({ level, message }); },
  });
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', function () { resolve(null); }); });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    assert.equal((await request(port, 'GET', '/internal/notify', '', null)).status, 404);
    assert.equal((await request(port, 'POST', '/internal/notify', '', { text: '消息' })).status, 401);
    assert.equal((await request(port, 'POST', '/internal/notify', 'test-token', {})).status, 400);
    assert.equal((await request(port, 'POST', '/internal/notify', 'test-token', { text: ' 消息 ' })).status, 200);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].text, '消息');
    assert.deepEqual(logs, [{ level: 'info', message: '内部通知已发送' }]);
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
  }
});
