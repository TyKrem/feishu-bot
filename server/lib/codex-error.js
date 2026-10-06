'use strict';

/**
 * CLI 的失败详情可能是接口错误嵌套的 JSON；只认失败事件，避免把模型切换提示当成失败。
 * @param {any} event
 * @returns {string}
 */
function codexFailureMessage(event) {
  if (!event || (event.type !== 'error' && event.type !== 'turn.failed')) return '';
  let detail = event.type === 'turn.failed' ? event.error : event.message;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof detail === 'string') {
      const message = detail.trim();
      try { detail = JSON.parse(message); } catch (error) { return message.slice(0, 2000); }
      // JSON 数字、布尔值等不是错误说明，仍保留原始文本。
      if (!detail || typeof detail !== 'object') return message.slice(0, 2000);
    } else if (detail && typeof detail === 'object') {
      detail = detail.error || detail.message;
    } else {
      return '';
    }
  }
  return typeof detail === 'string' ? detail.trim().slice(0, 2000) : '';
}

module.exports = { codexFailureMessage };
