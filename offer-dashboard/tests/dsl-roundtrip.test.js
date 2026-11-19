/* Test DSL ⇄ offerta. Esecuzione: node --test tests/ (dalla cartella offer-dashboard). Nessuna dipendenza esterna. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const ctx = load();
const { Store, Model, ExecutionPlan, Exporters, DslImport, jsyaml } = ctx;
const data = Store.load();

function exportText(offer) {
  return Exporters.toYaml(DslImport.exportMain(data, offer));
}
function canonical(offer) {
  const d = Model.normalize({ steps: data.steps, products: data.products, tasks: data.tasks, offers: [JSON.parse(JSON.stringify(offer))] });
  return JSON.stringify(Model.canonicalOffer(d.offers[0]));
}

/* Generatore pseudo-casuale deterministico. */
function rng(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
function subset(r, arr, min) {
  const out = arr.filter(function () { return r() < 0.5; });
  while (out.length < (min || 0) && out.length < arr.length) { const x = pick(r, arr); if (out.indexOf(x) < 0) out.push(x); }
  return arr.filter(function (x) { return out.indexOf(x) >= 0; });
}

function randomOffer(seed) {
  const r = rng(seed);
  const products = subset(r, data.products.map(function (p) { return p.id; }), 1);
  const offer = { id: 'OFF_RND_' + seed, name: 'Offerta casuale ' + seed, description: r() < 0.5 ? '' : 'Descrizione ' + seed, products: products, blocks: [], gates: [] };
  let n = 0;
  data.steps.forEach(function (st) {
    const count = Math.floor(r() * 4);
    for (let i = 0; i < count; i++) {
      const task = pick(r, data.tasks);
      const compatible = products.filter(function (p) { return task.compatibleProducts.indexOf(p) >= 0; });
      if (!compatible.length) continue;
      const same = offer.blocks.filter(function (b) { return b.stepId === st.id; }).map(function (b) { return b.id; });
      const def = Model.defaultBlockConfig(task);
      const hasKoTask = task.outcomes.indexOf('KO_TASK') >= 0;
      offer.blocks.push({
        id: 'B_' + (++n) + '_' + task.id, taskId: task.id, stepId: st.id,
        products: subset(r, compatible, 1), dependsOn: subset(r, same, 0),
        config: Object.assign(def, {
          callMode: r() < 0.5 ? 'perOffer' : 'perProduct',
          retry: { count: Math.floor(r() * 4), intervalSec: pick(r, [0, 1, 5, 30]) },
          onKo: r() < 0.8 ? 'MARK_KO' : 'IGNORE',
          koTask: { enabled: hasKoTask && r() < 0.5, queue: hasKoTask ? 'CODA_' + seed : '', slaHours: pick(r, [0, 8, 24]) },
          notify: { onOk: r() < 0.3, onKo: r() < 0.3, template: r() < 0.5 ? 'TPL_' + seed : '' },
          async: { callbackTopic: task.type === 'async' ? 'topic.' + seed : '', timeoutHours: pick(r, [1, 24, 48]) }
        })
      });
    }
  });
  data.steps.slice(0, -1).forEach(function (st) {
    const count = Math.floor(r() * 3);
    for (let i = 0; i < count; i++) {
      const rules = [];
      const stepBlocks = offer.blocks.filter(function (b) { return b.stepId === st.id; });
      if (stepBlocks.length && r() < 0.4) rules.push({ type: 'DONT_WAIT', blockId: pick(r, stepBlocks).id });
      if (r() < 0.4) rules.push({ type: 'STOP_ON_KO', products: subset(r, products, 0) });
      if (r() < 0.5) rules.push({ type: pick(r, ['ONLY_OK', 'CONTINUE_ON_KO']) });
      offer.gates.push({ id: 'G_' + st.id + '_' + i, afterStep: st.id, note: r() < 0.5 ? '' : 'nota ' + i, rules: rules });
    }
  });
  return offer;
}

test('offerte demo: offerta → DSL → offerta identica', function () {
  data.offers.forEach(function (o) {
    const res = DslImport.apply(data, exportText(o), o);
    assert.equal(res.ok, true, o.id + ': ' + (res.errors || []).join('\n'));
    assert.equal(canonical(res.offer), canonical(o), o.id);
  });
});

test('300 offerte casuali: andata e ritorno senza perdite, anche senza offerta precedente', function () {
  for (let seed = 1; seed <= 300; seed++) {
    const o = randomOffer(seed);
    const text = exportText(o);
    const res = DslImport.apply(data, text, null);
    assert.equal(res.ok, true, 'seed ' + seed + ': ' + (res.errors || []).join('\n'));
    assert.equal(canonical(res.offer), canonical(o), 'seed ' + seed);
    assert.equal(Exporters.toYaml(res.dsl), text, 'seed ' + seed + ': DSL rigenerato diverso');
  }
});

test('modifica del retry nel corpo: riportata in dashboard', function () {
  const o = data.offers.find(function (x) { return x.id === 'OFF_BUNDLE'; });
  const doc = jsyaml.load(exportText(o));
  const step = doc.do.find(function (t) { return t['step-preliminari']; })['step-preliminari'];
  const block = step.do.find(function (t) { return t['b-oracolo']; })['b-oracolo'];
  block.do[0]['b-oracolo-call'].catch.retry.limit.attempt.count = 7;
  block.do[0]['b-oracolo-call'].catch.retry.delay.seconds = 12;
  const res = DslImport.apply(data, Exporters.toYaml(doc), o);
  assert.equal(res.ok, true, (res.errors || []).join('\n'));
  const b = res.offer.blocks.find(function (x) { return x.id === 'B_ORACOLO'; });
  assert.equal(JSON.stringify(b.config.retry), JSON.stringify({ count: 7, intervalSec: 12 }));
});

test('modifica dei metadata: il corpo viene rigenerato di conseguenza', function () {
  const o = data.offers.find(function (x) { return x.id === 'OFF_BUNDLE'; });
  const doc = jsyaml.load(exportText(o));
  const step = doc.do.find(function (t) { return t['step-preliminari']; })['step-preliminari'];
  step.do.find(function (t) { return t['b-oracolo']; })['b-oracolo'].metadata.block.config.koTask.queue = 'BO_NUOVA_CODA';
  const res = DslImport.apply(data, Exporters.toYaml(doc), o);
  assert.equal(res.ok, true, (res.errors || []).join('\n'));
  assert.equal(res.offer.blocks.find(function (x) { return x.id === 'B_ORACOLO'; }).config.koTask.queue, 'BO_NUOVA_CODA');
  assert.match(Exporters.toYaml(res.dsl), /queue: BO_NUOVA_CODA/);
  assert.doesNotMatch(Exporters.toYaml(res.dsl), /queue: BO_ANTIFRODE/);
});

test('stessa modifica fatta solo nel corpo: rifiutata (la fonte è nei metadata)', function () {
  const o = data.offers.find(function (x) { return x.id === 'OFF_BUNDLE'; });
  const res = DslImport.apply(data, exportText(o).replace('queue: BO_ANTIFRODE', 'queue: BO_NUOVA_CODA'), o);
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /request-manual-task\/emit\/event\/with\/data\/queue/);
});

test('modifica di una regola di gate nei metadata: riportata', function () {
  const o = data.offers.find(function (x) { return x.id === 'OFF_BUNDLE'; });
  const doc = jsyaml.load(exportText(o));
  const gate = doc.do.find(function (t) { return t['gate-verticali']; })['gate-verticali'];
  gate.metadata.gates[0].rules = [{ type: 'STOP_ON_KO', products: ['CONTO'] }];
  const res = DslImport.apply(data, Exporters.toYaml(doc), o);
  assert.equal(res.ok, true, (res.errors || []).join('\n'));
  const g = res.offer.gates.find(function (x) { return x.afterStep === 'VERTICALI'; });
  assert.equal(JSON.stringify(g.rules), JSON.stringify([{ type: 'STOP_ON_KO', products: ['CONTO'] }]));
  const plan = ExecutionPlan.build(data, res.offer);
  assert.equal(JSON.stringify(plan.steps[1].exitGate.effectivePolicy.stopOnKo), '["CONTO"]');
});

test('titolo modificato: diventa il nome dell\'offerta', function () {
  const o = data.offers[0];
  const res = DslImport.apply(data, exportText(o).replace('title: ' + o.name, 'title: Nuovo nome'), o);
  assert.equal(res.ok, true, (res.errors || []).join('\n'));
  assert.equal(res.offer.name, 'Nuovo nome');
});

test('modifica nel corpo non riportabile: rifiutata con il punto esatto', function () {
  const o = data.offers.find(function (x) { return x.id === 'OFF_BUNDLE'; });
  const text = exportText(o).replace('/oracolo/v1/check', '/oracolo/v2/check');
  const res = DslImport.apply(data, text, o);
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /^Modifica non riportabile in dashboard in \/do\/1\/step-preliminari\/do\/.*\/endpoint\/uri/);
});

test('DSL senza metadata della dashboard: rifiutato', function () {
  const res = DslImport.apply(data, 'document:\n  dsl: "1.0.0"\n  namespace: x\n  name: y\n  version: "1.0.0"\ndo: []\n', null);
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /non è nel formato della dashboard/);
});

test('YAML non valido: errore con riga e colonna', function () {
  const res = DslImport.apply(data, 'document:\n  dsl: "1.0.0\ndo: [', null);
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /^YAML non valido \(riga \d+, colonna \d+\)/);
});
