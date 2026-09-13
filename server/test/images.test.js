'use strict';

const test = require('node:test');
const assert = require('node:assert');
const IMGS = require('../lib/images.js');

test('imageKeySlug 把会话键换成安全文件名', function () {
  assert.strictEqual(IMGS.imageKeySlug('p:ou_abc'), 'p_ou_abc');
  assert.strictEqual(IMGS.imageKeySlug('g:oc_xyz:ou_abc'), 'g_oc_xyz_ou_abc');
  assert.strictEqual(IMGS.imageKeySlug(''), 'unknown');
  assert.strictEqual(IMGS.imageKeySlug(null), 'unknown');
  // 有长度上限，不能让超长 key 撑爆文件名
  assert.strictEqual(IMGS.imageKeySlug('a'.repeat(200)).length, 80);
});

test('imageExtFromType 按类型给扩展名', function () {
  assert.strictEqual(IMGS.imageExtFromType('image/png'), '.png');
  assert.strictEqual(IMGS.imageExtFromType('image/gif'), '.gif');
  assert.strictEqual(IMGS.imageExtFromType('image/webp'), '.webp');
  assert.strictEqual(IMGS.imageExtFromType('image/bmp'), '.bmp');
  assert.strictEqual(IMGS.imageExtFromType('image/heic'), '.heic');
  // 带参数、大写、未知类型
  assert.strictEqual(IMGS.imageExtFromType('image/PNG; charset=binary'), '.png');
  assert.strictEqual(IMGS.imageExtFromType('image/tiff'), '.jpg');
  assert.strictEqual(IMGS.imageExtFromType(''), '.jpg');
  assert.strictEqual(IMGS.imageExtFromType(null), '.jpg');
});

test('imageStamp 格式化补零', function () {
  // 用本地时间构造，避免测试机器时区不同导致断言飘
  const ts = new Date(2026, 8, 13, 14, 5).getTime();
  assert.strictEqual(IMGS.imageStamp(ts), '2026-09-13 14:05');
  const early = new Date(2026, 0, 2, 3, 4).getTime();
  assert.strictEqual(IMGS.imageStamp(early), '2026-01-02 03:04');
});
