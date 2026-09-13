'use strict';

// 图片相关的纯函数：落盘文件名与展示用时间戳。

// 会话键里有 ':'（p:ou_xxx、g:oc_xxx:ou_xxx），做文件名前先换成安全字符
function imageKeySlug(key) {
  return String(key || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

// 按 content-type 决定扩展名；认不出的一律按 jpg 存
function imageExtFromType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'image/png') return '.png';
  if (type === 'image/gif') return '.gif';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/bmp') return '.bmp';
  if (type === 'image/heic') return '.heic';
  return '.jpg';
}

// 图片登记时给人看的时间戳：2026-09-13 14:05
function imageStamp(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

module.exports = {
  imageKeySlug: imageKeySlug,
  imageExtFromType: imageExtFromType,
  imageStamp: imageStamp,
};
