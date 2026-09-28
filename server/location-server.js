'use strict';

const http = require('http');
const { tokenEqual } = require('./lib/util');

/** @param {{ token: string, saveLocation: (input: any) => { receivedAt: number } }} options */
function createLocationServer(options) {
  const token = String(options.token || '');
  if (!token) throw new Error('定位上传令牌未配置');
  return http.createServer(function (request, response) {
    /** @param {number} status @param {any} result */
    function reply(status, result) {
      const body = JSON.stringify(result);
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      });
      response.end(body);
    }
    if (request.method !== 'POST' || request.url !== '/location') {
      reply(404, { error: '接口不存在' });
      return;
    }
    if (!tokenEqual(String(request.headers['x-location-token'] || ''), token)) {
      reply(401, { error: '定位上传令牌无效' });
      return;
    }
    if (Number(request.headers['content-length']) > 2048) {
      reply(413, { error: '定位请求过大' });
      return;
    }
    let data = '';
    request.on('data', function (chunk) {
      data += String(chunk);
      if (data.length > 2048) request.destroy();
    });
    request.on('end', function () {
      let input;
      try { input = JSON.parse(data); } catch (error) {
        reply(400, { error: '定位请求不是有效 JSON' });
        return;
      }
      try {
        const saved = options.saveLocation(input);
        reply(200, { ok: true, receivedAt: saved.receivedAt });
      } catch (/** @type {any} */ error) {
        reply(error && error.message === '经纬度无效' ? 400 : 500,
          { error: error && error.message === '经纬度无效' ? '经纬度无效' : '定位保存失败' });
      }
    });
  });
}

module.exports = { createLocationServer: createLocationServer };
