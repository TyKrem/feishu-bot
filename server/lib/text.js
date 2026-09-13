'use strict';

// 飞书消息体与模型返回的文本解析。纯函数，不依赖任何模块级状态。

// 按字符数切分长消息（飞书单条有长度上限）
/**
 * @param {unknown} text
 * @param {number} [size] 不传默认 3000
 * @returns {string[]}
 */
function chunkText(text, size) {
  const s = String(text == null ? '' : text);
  const limit = size || 3000;
  const chunks = [];
  for (let i = 0; i < s.length; i += limit) chunks.push(s.slice(i, i + limit));
  return chunks;
}

// 去掉 @ 人留下的占位 key，再把连续空白压成一个空格
/**
 * @param {unknown} text
 * @param {Array<{ key?: string }>} [mentions]
 * @returns {string}
 */
function stripMentionKeys(text, mentions) {
  let out = String(text || '');
  (mentions || []).forEach(function (m) {
    if (m && m.key) out = out.split(m.key).join(' ');
  });
  return out.replace(/\s+/g, ' ').trim();
}

// 取消息正文：text 直接取 text 字段；post（富文本）把标题、文本节点和链接拼起来
/**
 * @param {any} message 飞书事件里的 message 对象
 * @returns {string}
 */
function extractText(message) {
  const type = String((message && message.message_type) || '');
  /** @type {any} */
  let content = {};
  try { content = JSON.parse((message && message.content) || '{}'); } catch (e) { content = {}; }
  if (type === 'text') return String(content.text || '');
  if (type === 'post') {
    /** @type {string[]} */
    const parts = [];
    if (content.title) parts.push(String(content.title));
    (content.content || []).forEach(/** @param {any} line */ function (line) {
      (line || []).forEach(/** @param {any} node */ function (node) {
        if (!node) return;
        if (node.tag === 'text' && node.text) parts.push(String(node.text));
        else if (node.tag === 'a' && node.text) parts.push(String(node.text));
        else if (node.tag === 'at' && node.user_id) parts.push(' ');
      });
      parts.push('\n');
    });
    return parts.join('');
  }
  return '';
}

// 取出消息里的图片：image 消息本身，或富文本(post)里内嵌的 img 节点
/**
 * @param {any} message
 * @returns {string[]} image_key 列表
 */
function extractImageKeys(message) {
  const type = String((message && message.message_type) || '');
  /** @type {any} */
  let content = {};
  try { content = JSON.parse((message && message.content) || '{}'); } catch (e) { return []; }
  if (type === 'image') {
    const key = String(content.image_key || '').trim();
    return key ? [key] : [];
  }
  if (type === 'post') {
    /** @type {string[]} */
    const keys = [];
    (content.content || []).forEach(/** @param {any} line */ function (line) {
      (line || []).forEach(/** @param {any} node */ function (node) {
        if (node && node.tag === 'img' && node.image_key) keys.push(String(node.image_key));
      });
    });
    return keys;
  }
  return [];
}

// ".c 帮我看看" / ".codex 帮我看看" → "帮我看看"；不是这个前缀返回 null
/**
 * @param {unknown} text
 * @returns {string|null} 命中前缀返回去掉前缀的内容（可能是空串），没命中返回 null
 */
function extractCodexPrompt(text) {
  const m = /^\.(?:codex|c)(?:\s+|$)/i.exec(String(text || ''));
  return m ? String(text).slice(m[0].length).trim() : null;
}

// 从模型返回的结构里取 output_text 片段
/**
 * @param {any} data 模型接口的返回体
 * @returns {string}
 */
function extractGuestText(data) {
  const out = (data && data.output) || [];
  /** @type {string[]} */
  const parts = [];
  out.forEach(/** @param {any} item */ function (item) {
    if (item && item.type === 'message' && Array.isArray(item.content)) {
      item.content.forEach(/** @param {any} c */ function (c) {
        if (c && c.type === 'output_text' && c.text) parts.push(c.text);
      });
    }
  });
  return parts.join('\n').trim();
}

module.exports = {
  chunkText: chunkText,
  stripMentionKeys: stripMentionKeys,
  extractText: extractText,
  extractImageKeys: extractImageKeys,
  extractCodexPrompt: extractCodexPrompt,
  extractGuestText: extractGuestText,
};
