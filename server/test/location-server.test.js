'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLocationServer } = require('../location-server');

test('定位接口仅接受持令牌的有效坐标', async function () {
  let saved = null;
  const server = createLocationServer({
    token: 'test-location-token',
    saveLocation: function (input) {
      if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude) ||
          input.latitude < -90 || input.latitude > 90 ||
          input.longitude < -180 || input.longitude > 180) throw new Error('经纬度无效');
      saved = input;
      return { receivedAt: 123 };
    },
  });
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', function () { resolve(undefined); }); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  /** @param {string} token @param {string} body */
  async function send(token, body) {
    return new Promise(function (resolve, reject) {
      const request = http.request({ hostname: '127.0.0.1', port: port, path: '/location', method: 'POST',
        headers: { 'X-Location-Token': token, 'Content-Type': 'application/json' } }, function (response) {
        let content = '';
        response.on('data', function (chunk) { content += String(chunk); });
        response.on('end', function () { resolve({ status: response.statusCode, body: JSON.parse(content) }); });
      });
      request.on('error', reject);
      request.end(body);
    });
  }
  try {
    assert.equal((await send('wrong', '{"latitude":31,"longitude":121}')).status, 401);
    assert.equal(saved, null);
    assert.equal((await send('test-location-token', '{"latitude":99,"longitude":121}')).status, 400);
    const result = await send('test-location-token', '{"latitude":31.2,"longitude":121.5}');
    assert.equal(result.status, 200);
    assert.deepEqual(saved, { latitude: 31.2, longitude: 121.5 });
    assert.equal(result.body.receivedAt, 123);
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
  }
});
