'use strict';

const http = require('http');
const { URL } = require('url');

/** @typedef {import('./identity.js').NotifyTarget} NotifyTarget */
/**
 * @param {{ token: string, tokenEqual: (left: string, right: string) => boolean,
 *   resolveTarget: (body: any) => NotifyTarget|null,
 *   deliver: (target: NotifyTarget, text: string) => void,
 *   writeLog: (level: string, message: string, meta: Record<string, any>) => void }} options
 * @returns {import('http').Server}
 */
function createInternalNotifyServer(options) {
  return http.createServer(function (req, res) {
    /**
     * @param {number} status
     * @param {any} object
     */
    function reply(status, object) {
      const body = JSON.stringify(object);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    }
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method !== 'POST' || url.pathname !== '/internal/notify') {
      reply(404, { error: '接口不存在' });
      return;
    }
    if (options.token && !options.tokenEqual(String(req.headers['x-notify-token'] || ''), options.token)) {
      reply(401, { error: '通知令牌无效' });
      return;
    }
    let data = '';
    req.on('data', function (chunk) {
      data += String(chunk);
      if (data.length > 256 * 1024) req.destroy();
    });
    req.on('end', function () {
      /** @type {any} */
      let body = {};
      try { body = JSON.parse(data || '{}'); } catch (error) {}
      const text = String(body.text || '').trim();
      if (!text) {
        reply(400, { error: '缺少 text' });
        return;
      }
      const target = options.resolveTarget(body);
      if (!target) {
        reply(503, { error: '没有可用的飞书接收人（请配置 FEISHU_NOTIFY_USER）' });
        return;
      }
      options.deliver(target, text);
      options.writeLog('info', '内部通知已发送', { length: text.length, target: target.label, kind: target.kind });
      reply(200, { ok: true });
    });
    req.on('error', function () {});
  });
}

module.exports = { createInternalNotifyServer: createInternalNotifyServer };
