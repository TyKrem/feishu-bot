'use strict';

// 内置指令的纯逻辑部分。

// 骰子：支持 .rand 3d10 / 2d6+1 / d20，也认「骰子」前缀。
// 随机数没抽出来，所以这里只测参数校验与用法提示，不断言点数。
/**
 * @param {unknown} text
 * @returns {string} 要回复的文本
 */
function rollDiceText(text) {
  const body = String(text).replace(/^(?:\.(?:rand|r)|骰子|掷骰子?|投骰子?)/i, '').trim();
  const re = /(\d+)?d(\d+)([+-]\d+)?/gi;
  const lines = [];
  let grandTotal = 0;
  let found = false;
  let m;
  while ((m = re.exec(body)) !== null) {
    found = true;
    const count = Math.max(1, parseInt(m[1] || '1', 10) || 1);
    const sides = parseInt(m[2], 10);
    const bonus = parseInt(m[3] || '0', 10) || 0;
    if (!sides || sides < 2 || count > 1000 || sides > 100000) {
      return '.rand 参数无效，请使用例如：3d10、2d6+1、d20';
    }
    const rolls = [];
    for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
    const sum = rolls.reduce(function (a, b) { return a + b; }, 0) + bonus;
    grandTotal += sum;
    lines.push(m[0].toLowerCase() + ' → ' + rolls.join(' + ') + ' = ' + sum +
      (bonus ? '（含调整 ' + (bonus > 0 ? '+' : '') + bonus + '）' : ''));
  }
  if (!found) return '🎲 用法：.rand 3d10，也支持 2d6+1、d20';
  if (lines.length === 1) return '🎲 ' + lines[0];
  return '🎲 ' + lines.join('\n') + '\n总计 ' + grandTotal;
}

module.exports = { rollDiceText: rollDiceText };
