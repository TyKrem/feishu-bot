'use strict';

const http = require('http');
const SOCKET = process.env.FEISHU_EXECUTOR_SOCKET || '/run/feishu-executor/control.sock';

/** @param {string} route @param {any} payload @returns {Promise<any>} */
function request(route, payload) {
  return new Promise((resolve, reject) => {
    const call = http.request({ socketPath: SOCKET, path: route, method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      let content = '';
      response.on('data', chunk => { content += chunk; if (content.length > 1024 * 1024) call.destroy(new Error('执行器响应超过限制')); });
      response.on('end', () => {
        try {
          const result = JSON.parse(content);
          if (response.statusCode !== 200) throw new Error(result.error || '执行器拒绝请求');
          resolve(result);
        } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    call.setTimeout(70000, () => call.destroy(new Error('执行器查询超时')));
    call.on('error', reject);
    call.end(JSON.stringify(payload));
  });
}

/** @param {any} payload */
function stream(payload) {
  const call = http.request({ socketPath: SOCKET, path: '/codex', method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
    if (response.statusCode !== 200) {
      let failure = '';
      response.on('data', chunk => { failure = (failure + chunk).slice(0, 8192); });
      response.on('end', () => {
        try { process.stderr.write(JSON.parse(failure).error + '\n'); } catch { process.stderr.write('执行器拒绝请求\n'); }
        process.exitCode = 1;
      });
      return;
    }
    let ended = false;
    let pending = '';
    response.setEncoding('utf8');
    response.on('data', chunk => {
      pending += chunk;
      if (pending.length > 4 * 1024 * 1024) { call.destroy(); process.exitCode = 1; return; }
      const lines = pending.split('\n'); pending = lines.pop() || '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.stdout) process.stdout.write(Buffer.from(event.stdout, 'base64'));
          if (event.stderr) process.stderr.write(Buffer.from(event.stderr, 'base64'));
          if (event.error) { process.stderr.write(event.error + '\n'); process.exitCode = 1; }
          if (event.exit !== undefined) { ended = true; process.exitCode = event.exit === 0 ? 0 : 1; }
        } catch { process.exitCode = 1; }
      }
    });
    response.on('end', () => { if (!ended) { process.stderr.write('执行器连接提前结束\n'); process.exitCode = 1; } });
    response.on('error', () => { process.exitCode = 1; });
  });
  call.on('error', () => { process.stderr.write('运维执行器不可用或连接中断\n'); process.exitCode = 1; });
  call.setTimeout(920000, () => call.destroy());
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { call.destroy(); process.exitCode = 1; });
  call.end(JSON.stringify(payload));
}

if (require.main === module) {
  try { stream(JSON.parse(process.argv[2] || '{}')); } catch { process.exitCode = 1; }
}
module.exports = { request };
