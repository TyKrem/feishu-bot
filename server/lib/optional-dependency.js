'use strict';

const path = require('path');

/**
 * @param {string} directory
 * @param {string} filename
 * @returns {any}
 */
function loadOptionalLibrary(directory, filename) {
  const modulePath = path.resolve(directory, 'lib', filename);
  let resolvedPath;
  try {
    resolvedPath = require.resolve(modulePath);
  } catch (/** @type {any} */ error) {
    // 只有目标模块本身缺失才降级；模块内部缺依赖或运行报错必须暴露出来。
    if (error && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
  return require(resolvedPath);
}

module.exports = { loadOptionalLibrary: loadOptionalLibrary };
