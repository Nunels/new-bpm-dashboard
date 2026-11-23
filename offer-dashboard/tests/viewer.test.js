/* Scheda «Diagramma DSL»: il bundle del viewer Open Workflow è nel repo e la pagina lo carica come script classico (anche da file://). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./harness');

const vendor = path.join(ROOT, 'js', 'vendor', 'open-workflow-editor');

test('viewer: bundle classico, CSS e licenze presenti', function () {
  ['diagram-editor.iife.js', 'diagram-editor.css', 'NOTICE.txt', 'LICENSE-open-workflow-editor.txt', 'LICENSE-elkjs.txt'].forEach(function (f) {
    assert.ok(fs.existsSync(path.join(vendor, f)), f + ' mancante: rigenera con tools/open-workflow-viewer (npm run build)');
  });
  const js = fs.readFileSync(path.join(vendor, 'diagram-editor.iife.js'), 'utf8');
  assert.match(js, /OpenWorkflowViewer/, 'il bundle espone il globale OpenWorkflowViewer');
  assert.ok(!/^\s*(import|export)\s/m.test(js.slice(0, 2000)), 'non è un modulo ES: da file:// i moduli sono bloccati');
});

test('viewer: la pagina ha il contenitore e la dashboard usa gli stessi percorsi del bundle', function () {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /id="diagramview"/);
  const offer = fs.readFileSync(path.join(ROOT, 'js', 'offer.js'), 'utf8');
  assert.match(offer, /js\/vendor\/open-workflow-editor\//);
  assert.match(offer, /diagram-editor\.iife\.js/);
  assert.match(offer, /diagram-editor\.css/);
});
