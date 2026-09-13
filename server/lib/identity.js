'use strict';

// 身份与白名单。
// 依赖映射表的部分把表当参数传进来，这样能脱开环境变量单测——
// server.js 里保留同名薄包装，调用点不用改。

// 一个发送者可能有三种 id，去重前先都取出来
function senderIds(sender) {
  const sid = (sender && sender.sender_id) || {};
  return [sid.open_id, sid.user_id, sid.union_id]
    .map(function (x) { return String(x || '').trim(); })
    .filter(Boolean);
}

// 白名单匹配：名单为空时一律不放行（默认拒绝）
function matches(list, ids) {
  if (!list || !list.length) return false;
  return ids.some(function (id) { return list.indexOf(id) >= 0; });
}

// 生活数据主键：优先用映射（可继续沿用 QQ 时代的数据），否则用飞书 open_id
function lifeKey(ids, keyMap) {
  for (let i = 0; i < ids.length; i++) {
    if (keyMap && keyMap[ids[i]]) return keyMap[ids[i]];
  }
  return ids[0] || '';
}

// 反查飞书身份：把生活主键（旧 QQ 号）映射回 open_id
function primaryId(ids, legacyToFeishu) {
  for (let i = 0; i < ids.length; i++) {
    if (legacyToFeishu && legacyToFeishu[ids[i]]) return legacyToFeishu[ids[i]];
  }
  return ids[0] || '';
}

// 有没有 @ 机器人。没配置机器人身份时，只要有 @ 就算呼叫
function mentionIsBot(message, botOpenId, botName) {
  const mentions = (message && message.mentions) || [];
  if (!mentions.length) return false;
  if (!botOpenId && !botName) return true;
  return mentions.some(function (m) {
    const id = (m && m.id) || {};
    if (botOpenId && (id.open_id === botOpenId || id.user_id === botOpenId)) return true;
    if (botName && String((m && m.name) || '') === botName) return true;
    return false;
  });
}

// 内部通知接口决定发给谁：显式 open_id > 显式 chat_id > 旧 QQ 号（查映射）> 默认收件人
function resolveNotifyTarget(body, legacyToFeishu, notifyUser) {
  const b = body || {};
  const openId = String(b.open_id || b.openId || b.user || '').trim();
  const chatId = String(b.chat_id || b.chatId || '').trim();
  const legacy = String(b.qq || '').trim();
  if (openId) return { kind: 'user', id: openId, label: openId };
  if (chatId) return { kind: 'chat', id: chatId, label: chatId };
  if (legacy) {
    const mapped = legacyToFeishu && legacyToFeishu[legacy];
    if (mapped) return { kind: 'user', id: mapped, label: mapped };
    if (/^ou_/.test(legacy)) return { kind: 'user', id: legacy, label: legacy };
  }
  if (notifyUser) return { kind: 'user', id: notifyUser, label: notifyUser };
  return null;
}

module.exports = {
  senderIds: senderIds,
  matches: matches,
  lifeKey: lifeKey,
  primaryId: primaryId,
  mentionIsBot: mentionIsBot,
  resolveNotifyTarget: resolveNotifyTarget,
};
