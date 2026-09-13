'use strict';

const test = require('node:test');
const assert = require('node:assert');
const TXT = require('../lib/text.js');

test('chunkText 按长度切分', function () {
  assert.deepStrictEqual(TXT.chunkText('abcdef', 2), ['ab', 'cd', 'ef']);
  // 正好整除时不应多出空片段
  assert.deepStrictEqual(TXT.chunkText('abcd', 2), ['ab', 'cd']);
  assert.deepStrictEqual(TXT.chunkText('', 3), []);
  assert.deepStrictEqual(TXT.chunkText(null, 3), []);
  // 不传 size 默认 3000
  assert.strictEqual(TXT.chunkText('x'.repeat(3001)).length, 2);
});

test('stripMentionKeys 去掉 @ 占位并把空白压平', function () {
  const mentions = [{ key: '@_user_1' }, { key: '@_user_2' }];
  assert.strictEqual(TXT.stripMentionKeys('@_user_1 帮我看下 @_user_2 这个', mentions), '帮我看下 这个');
  assert.strictEqual(TXT.stripMentionKeys('没 有 占位', mentions), '没 有 占位');
  assert.strictEqual(TXT.stripMentionKeys('', mentions), '');
  assert.strictEqual(TXT.stripMentionKeys('abc', []), 'abc');
});

test('extractText 处理 text 与富文本 post', function () {
  assert.strictEqual(
    TXT.extractText({ message_type: 'text', content: JSON.stringify({ text: '你好' }) }),
    '你好'
  );
  const post = {
    message_type: 'post',
    content: JSON.stringify({
      title: '标题',
      content: [[{ tag: 'text', text: '正文' }, { tag: 'a', text: '链接' }, { tag: 'at', user_id: 'ou_x' }]],
    }),
  };
  const out = TXT.extractText(post);
  assert.ok(out.indexOf('标题') >= 0, '应包含标题');
  assert.ok(out.indexOf('正文') >= 0, '应包含文本节点');
  assert.ok(out.indexOf('链接') >= 0, '链接要取显示文字');
  // 不认识的类型返回空串
  assert.strictEqual(TXT.extractText({ message_type: 'file', content: '{}' }), '');
  // 内容不是合法 JSON 时不能抛，要返回空串
  assert.strictEqual(TXT.extractText({ message_type: 'text', content: '不是JSON' }), '');
  assert.strictEqual(TXT.extractText(null), '');
});

test('extractImageKeys 取图片消息与富文本内嵌图', function () {
  assert.deepStrictEqual(
    TXT.extractImageKeys({ message_type: 'image', content: JSON.stringify({ image_key: 'img_a' }) }),
    ['img_a']
  );
  assert.deepStrictEqual(
    TXT.extractImageKeys({ message_type: 'image', content: JSON.stringify({}) }),
    []
  );
  const post = {
    message_type: 'post',
    content: JSON.stringify({
      content: [[{ tag: 'text', text: '看图' }, { tag: 'img', image_key: 'img_b' }], [{ tag: 'img', image_key: 'img_c' }]],
    }),
  };
  assert.deepStrictEqual(TXT.extractImageKeys(post), ['img_b', 'img_c']);
  // 纯文本消息里没有图
  assert.deepStrictEqual(TXT.extractImageKeys({ message_type: 'text', content: '{"text":"hi"}' }), []);
  // 非法 JSON 不能抛
  assert.deepStrictEqual(TXT.extractImageKeys({ message_type: 'post', content: '不是JSON' }), []);
});

test('extractCodexPrompt 只认 .c / .codex 前缀', function () {
  assert.strictEqual(TXT.extractCodexPrompt('.c 帮我看下'), '帮我看下');
  assert.strictEqual(TXT.extractCodexPrompt('.codex 帮我看下'), '帮我看下');
  assert.strictEqual(TXT.extractCodexPrompt('.C   多空格'), '多空格');
  // 只有前缀没有内容 → 空串（不是 null，调用方靠这个区分"命中但没内容"）
  assert.strictEqual(TXT.extractCodexPrompt('.c'), '');
  assert.strictEqual(TXT.extractCodexPrompt('.c   '), '');
  // 不是前缀 → null
  assert.strictEqual(TXT.extractCodexPrompt('c 帮我看下'), null);
  assert.strictEqual(TXT.extractCodexPrompt('.codexx 不行'), null);
  assert.strictEqual(TXT.extractCodexPrompt('随便说点'), null);
});

test('extractGuestText 只取 output_text 片段', function () {
  const data = {
    output: [
      { type: 'reasoning', content: [{ type: 'output_text', text: '不该出现' }] },
      { type: 'message', content: [{ type: 'output_text', text: '第一段' }, { type: 'other', text: '忽略' }] },
      { type: 'message', content: [{ type: 'output_text', text: '第二段' }] },
    ],
  };
  assert.strictEqual(TXT.extractGuestText(data), '第一段\n第二段');
  assert.strictEqual(TXT.extractGuestText({}), '');
  assert.strictEqual(TXT.extractGuestText(null), '');
});
