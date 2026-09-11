'use strict';

/*
 * 塔罗牌面图片。
 *
 * 来源：Wikimedia Commons 上的 Rider-Waite-Smith 牌面（1909 年出版，公有领域），
 * 按需下载并缓存到本地；逆位把图片旋转 180° 后单独缓存。
 *
 * 对外只暴露 getTarotImage()，失败时返回 null —— 调用方降级为纯文字即可。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const jpeg = require('jpeg-js');

// 顺序必须与 life-app 的 CARDS（大阿卡纳 0~21）一致
const RWS_FILES = [
  'RWS_Tarot_00_Fool.jpg',
  'RWS_Tarot_01_Magician.jpg',
  'RWS_Tarot_02_High_Priestess.jpg',
  'RWS_Tarot_03_Empress.jpg',
  'RWS_Tarot_04_Emperor.jpg',
  'RWS_Tarot_05_Hierophant.jpg',
  'RWS_Tarot_06_Lovers.jpg',
  'RWS_Tarot_07_Chariot.jpg',
  'RWS_Tarot_08_Strength.jpg',
  'RWS_Tarot_09_Hermit.jpg',
  'RWS_Tarot_10_Wheel_of_Fortune.jpg',
  'RWS_Tarot_11_Justice.jpg',
  'RWS_Tarot_12_Hanged_Man.jpg',
  'RWS_Tarot_13_Death.jpg',
  'RWS_Tarot_14_Temperance.jpg',
  'RWS_Tarot_15_Devil.jpg',
  'RWS_Tarot_16_Tower.jpg',
  'RWS_Tarot_17_Star.jpg',
  'RWS_Tarot_18_Moon.jpg',
  'RWS_Tarot_19_Sun.jpg',
  'RWS_Tarot_20_Judgement.jpg',
  'RWS_Tarot_21_World.jpg',
];

// Wikimedia 要求 User-Agent 能标识调用方，否则会拒绝请求
const USER_AGENT = 'feishu-bot/1.0 (+https://github.com/TyKrem/feishu-bot)';
const API_URL = 'https://commons.wikimedia.org/w/api.php';
const THUMB_WIDTH = 960;

function httpGet(url, opts, redirectsLeft) {
  const asBuffer = !!(opts && opts.binary);
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' },
      timeout: 30000,
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((redirectsLeft || 0) <= 0) { reject(new Error('重定向次数过多')); return; }
        httpGet(new URL(res.headers.location, url).toString(), opts, redirectsLeft - 1)
          .then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', function (c) {
        size += c.length;
        if (size > 12 * 1024 * 1024) { req.destroy(new Error('图片过大')); return; }
        chunks.push(c);
      });
      res.on('end', function () {
        const buf = Buffer.concat(chunks);
        resolve(asBuffer ? buf : buf.toString('utf8'));
      });
    });
    req.on('timeout', function () { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.end();
  });
}

// 把牌面旋转 180°（逆位）。像素顺序整体倒置即可，不需要额外的图像库。
function rotate180(buf) {
  const raw = jpeg.decode(buf, { useTArray: true });
  const px = raw.width * raw.height;
  const out = Buffer.alloc(raw.data.length);
  for (let i = 0; i < px; i++) {
    const s = i * 4;
    const d = (px - 1 - i) * 4;
    out[d] = raw.data[s];
    out[d + 1] = raw.data[s + 1];
    out[d + 2] = raw.data[s + 2];
    out[d + 3] = raw.data[s + 3];
  }
  return jpeg.encode({ data: out, width: raw.width, height: raw.height }, 85).data;
}

let urlMapCache = null;

// 通过 Commons API 把文件名换成实际下载地址，结果落盘复用
async function resolveUrls(cacheDir, log) {
  if (urlMapCache) return urlMapCache;
  const cacheFile = path.join(cacheDir, 'urls.json');
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached && Object.keys(cached).length) {
      urlMapCache = cached;
      return cached;
    }
  } catch (e) {}

  const titles = RWS_FILES.map(function (f) { return 'File:' + f; }).join('|');
  const url = API_URL + '?action=query&format=json&prop=imageinfo&iiprop=url'
    + '&iiurlwidth=' + THUMB_WIDTH
    + '&titles=' + encodeURIComponent(titles);
  const body = await httpGet(url, {}, 3);
  const data = JSON.parse(body);
  const pages = (data.query && data.query.pages) || {};
  const map = {};
  Object.keys(pages).forEach(function (k) {
    const p = pages[k];
    if (p && p.imageinfo && p.imageinfo[0]) {
      const name = String(p.title || '').replace(/^File:/, '').replace(/ /g, '_');
      map[name] = p.imageinfo[0].thumburl || p.imageinfo[0].url;
    }
  });
  if (!Object.keys(map).length) throw new Error('未能解析牌面地址');
  try { fs.writeFileSync(cacheFile, JSON.stringify(map, null, 1)); } catch (e) {}
  urlMapCache = map;
  if (typeof log === 'function') log('已解析 ' + Object.keys(map).length + ' 张牌面地址');
  return map;
}

/*
 * opts: { index, reversed, cacheDir, log }
 * 返回本地图片绝对路径；任何一步失败都返回 null（调用方降级成纯文字）。
 */
async function getTarotImage(opts) {
  const index = Number(opts && opts.index);
  const reversed = !!(opts && opts.reversed);
  const cacheDir = (opts && opts.cacheDir) || path.join(process.cwd(), '.tarot-cache');
  const log = opts && opts.log;

  if (!(index >= 0 && index < RWS_FILES.length)) return null;
  const file = RWS_FILES[index];
  const localFile = path.join(cacheDir, file.replace(/\.jpg$/, reversed ? '-rev.jpg' : '.jpg'));

  try {
    if (fs.existsSync(localFile) && fs.statSync(localFile).size > 1024) return localFile;
  } catch (e) {}

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (e) {
    if (typeof log === 'function') log('无法创建缓存目录：' + e.message);
    return null;
  }

  try {
    const map = await resolveUrls(cacheDir, log);
    const url = map[file];
    if (!url) throw new Error('没有该牌的图片地址：' + file);
    let buf = await httpGet(url, { binary: true }, 3);
    if (reversed) buf = rotate180(buf);
    // 先写临时文件再改名，避免并发时读到半张图
    const tmp = localFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, localFile);
    if (typeof log === 'function') {
      log('牌面已缓存：' + path.basename(localFile) + '（' + Math.round(buf.length / 1024) + 'KB）');
    }
    return localFile;
  } catch (e) {
    if (typeof log === 'function') log('获取牌面失败（' + file + '）：' + e.message);
    return null;
  }
}

module.exports = { getTarotImage: getTarotImage, RWS_FILES: RWS_FILES };
