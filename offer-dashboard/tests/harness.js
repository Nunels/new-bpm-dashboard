/* Carica gli script della dashboard (pensati per il browser) in un contesto Node isolato, con stub minimi del DOM. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = [
  'js/vendor/js-yaml/js-yaml.min.js', 'js/seed.js', 'js/store.js', 'js/validation.js', 'js/simulator.js',
  'js/exporters/common.js', 'js/exporters/serverless.js', 'js/exporters/temporal.js', 'js/execution-plan.js', 'js/dsl-import.js'
];

function load() {
  const storage = {};
  const ctx = {
    console: console,
    localStorage: { getItem: function (k) { return storage[k] || null; }, setItem: function (k, v) { storage[k] = String(v); }, removeItem: function (k) { delete storage[k]; } },
    document: { getElementById: function () { return null; }, createElement: function () { return {}; }, createElementNS: function () { return {}; } },
    Node: function () {}
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  SCRIPTS.forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }); });
  return ctx;
}

module.exports = { load: load, ROOT: ROOT, SCRIPTS: SCRIPTS };
