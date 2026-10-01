'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOptionalLibrary } = require('../lib/optional-dependency.js');

test('可选模块不存在时降级为 null', function () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-optional-'));
  try {
    assert.equal(loadOptionalLibrary(directory, 'missing.js'), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('只加载指定部署目录，模块内部错误不得静默降级', function () {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-optional-'));
  const library = path.join(directory, 'lib');
  fs.mkdirSync(library);
  try {
    fs.writeFileSync(path.join(library, 'ok.js'), "'use strict'; module.exports = { value: 42 };\n");
    fs.writeFileSync(path.join(library, 'broken.js'), "'use strict'; require('./absent.js');\n");
    assert.deepEqual(loadOptionalLibrary(directory, 'ok.js'), { value: 42 });
    assert.throws(function () { loadOptionalLibrary(directory, 'broken.js'); }, /absent\.js/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
