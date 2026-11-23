/*
 * Genera, a partire dal codice della dashboard (../../offer-dashboard), i file per la prova su Quarkus Flow:
 *   - src/main/resources/flow/*.sw.yaml   workflow Open Workflow generati dall'exporter "serverless"
 *   - src/test/resources/scenarios.json   scenari con gli esiti attesi calcolati dal Simulator della dashboard
 * Uso: node tools/generate.js
 */
const fs = require('fs'), vm = require('vm'), path = require('path');

const root = path.resolve(__dirname, '..');
const dash = path.resolve(root, '..', 'offer-dashboard', 'js');
const BASE_URL = 'http://localhost:8089/mock';

const ctx = { console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, document: { getElementById: () => null, createElement: () => ({}) }, Node: function () {} };
ctx.window = ctx; vm.createContext(ctx);
['seed', 'fields', 'store', 'conditions', 'validation', 'simulator', 'exporters/common', 'exporters/serverless', 'execution-plan']
  .forEach(f => vm.runInContext(fs.readFileSync(path.join(dash, f + '.js'), 'utf8'), ctx, { filename: f }));
ctx.Exporters.BASE_URL = BASE_URL;

/* ------------------------------------------------------------------ offerte di prova (solo servizi sincroni) */
const block = (id, taskId, stepId, products, dependsOn) => ({ id, taskId, stepId, products, dependsOn: dependsOn || [] });
const OFFERS = [
  {
    id: 'OFF_SIM', name: 'Prova: Conto + Evo + Lib Min + TIM (solo sincroni)',
    description: 'Copre Non attendere, Solo OK, Ferma tutto, Prosegui anche con KO, parallelo, sequenza, 1 chiamata per N e per prodotto',
    products: ['CONTO', 'EVO', 'LIBMIN', 'TIM'],
    blocks: [
      block('B_ORACOLO', 'ORACOLO', 'PRELIMINARI', ['CONTO', 'EVO', 'LIBMIN']),
      block('B_PREGIUDIZIEVOLI', 'PREGIUDIZIEVOLI', 'PRELIMINARI', ['CONTO', 'EVO', 'LIBMIN'], ['B_ORACOLO']),
      block('B_ORACOLO2', 'ORACOLO_2', 'PRELIMINARI', ['TIM']),
      block('B_CRIBIS', 'CRIBIS', 'VERTICALI', ['CONTO']),
      block('B_STAMPA', 'STAMPA_CONTRATTI', 'BO', ['CONTO', 'EVO', 'LIBMIN']),
      block('B_ATT_BANCA', 'ATTIVAZIONE_BANCARIA', 'ATTIVAZIONI', ['CONTO', 'EVO', 'LIBMIN']),
      block('B_STAMPA_TIM', 'STAMPA_CONTRATTI', 'ATTIVAZIONI', ['TIM']),
      block('B_COMUNICAZIONI', 'COMUNICAZIONI', 'POST_ATTIVAZIONI', ['CONTO', 'EVO', 'LIBMIN', 'TIM'])
    ],
    gates: [
      { id: 'G_PRE_1', afterStep: 'PRELIMINARI', note: '', rules: [{ type: 'DONT_WAIT', blockId: 'B_ORACOLO2' }] },
      { id: 'G_PRE_2', afterStep: 'PRELIMINARI', note: '', rules: [{ type: 'ONLY_OK' }] },
      { id: 'G_VER', afterStep: 'VERTICALI', note: '', rules: [{ type: 'STOP_ON_KO', products: [] }] },
      { id: 'G_ATT', afterStep: 'ATTIVAZIONI', note: '', rules: [{ type: 'CONTINUE_ON_KO' }] }
    ],
    scenarios: [
      { name: 'tutto-ok', outcomes: {} },
      { name: 'evo-ko-in-oracolo', outcomes: { B_ORACOLO: { EVO: 'KO' } } },
      { name: 'conto-ed-evo-ko-in-oracolo', outcomes: { B_ORACOLO: { CONTO: 'KO', EVO: 'KO' } } },
      { name: 'cribis-ko-ferma-tutto', outcomes: { B_CRIBIS: { CONTO: 'KO' } } },
      { name: 'pregiudizievoli-ko-libmin', outcomes: { B_PREGIUDIZIEVOLI: { LIBMIN: 'KO' } } },
      { name: 'stampa-ko-in-bo-esclude-evo', outcomes: { B_STAMPA: { EVO: 'KO' } } },
      { name: 'attivazione-ko-prosegue', outcomes: { B_ATT_BANCA: { CONTO: 'KO' } } },
      { name: 'oracolo2-lento-non-attendere', outcomes: { B_ORACOLO2: { TIM: 'PENDING' } }, latency: { B_ORACOLO2: 4000 }, maxMillis: 3000 }
    ]
  },
  {
    id: 'OFF_SIM_MONO', name: 'Prova: solo Conto (Solo OK)',
    description: 'Mono-prodotto: se l\'unico prodotto va KO nessun prodotto supera il gate',
    products: ['CONTO'],
    blocks: [
      block('B_M_ORACOLO', 'ORACOLO', 'PRELIMINARI', ['CONTO']),
      block('B_M_ATT', 'ATTIVAZIONE_BANCARIA', 'ATTIVAZIONI', ['CONTO'])
    ],
    gates: [{ id: 'G_M_PRE', afterStep: 'PRELIMINARI', note: '', rules: [{ type: 'ONLY_OK' }] }],
    scenarios: [
      { name: 'tutto-ok', outcomes: {} },
      { name: 'oracolo-ko-nessun-prodotto', outcomes: { B_M_ORACOLO: { CONTO: 'KO' } } }
    ]
  }
];

/* ------------------------------------------------------------------ costruzione */
const out = ctx.vm_out = {};
const result = vm.runInContext(`(function (offers) {
  const data = Store.load();
  offers.forEach(o => data.offers.push({ id: o.id, name: o.name, description: o.description, products: o.products, blocks: o.blocks, gates: o.gates }));
  Model.normalize(data);
  const res = [];
  offers.forEach(def => {
    const offer = data.offers.find(o => o.id === def.id);
    offer.blocks.forEach(b => { b.config.koTask.enabled = false; });
    const plan = ExecutionPlan.build(data, offer);
    if (!plan.summary.valid) throw new Error('offerta non valida: ' + def.id + ' ' + JSON.stringify(plan.validation.errors));
    const files = Exporters.get('serverless').files(plan);
    const scenarios = def.scenarios.map(sc => {
      const sim = Simulator.run(data, offer, sc.outcomes);
      return { sc, sim };
    });
    res.push({ id: def.id, plan, files, scenarios: scenarios.map(x => ({ name: x.sc.name, outcomes: x.sc.outcomes, latency: x.sc.latency || null, maxMillis: x.sc.maxMillis || null, final: x.sim.final, steps: x.sim.steps.map(s => ({ stepId: s.stepId, entering: s.entering })),
      // prodotti che il simulatore NON esegue per dipendenza da un blocco in KO, per blocco
      skippedByBlock: (function () { const r = {}; x.sim.steps.forEach(s => { Object.keys(s.blockResults || {}).forEach(bid => {
        Object.keys(s.blockResults[bid]).forEach(p => { if (s.blockResults[bid][p] === 'SKIPPED') (r[bid] = r[bid] || []).push(p); }); }); }); return r; })() })),
      blocks: offer.blocks.map(b => ({ id: b.id, taskId: b.taskId, stepId: b.stepId, products: b.products, callMode: b.config.callMode })) });
  });
  return JSON.stringify(res);
})`, ctx)(OFFERS.map(o => ({ id: o.id, name: o.name, description: o.description, products: o.products, blocks: o.blocks, gates: o.gates, scenarios: o.scenarios })));
const built = JSON.parse(result);

/* ------------------------------------------------------------------ output */
const flowDir = path.join(root, 'src', 'main', 'resources', 'flow');
fs.mkdirSync(flowDir, { recursive: true });
fs.readdirSync(flowDir).filter(f => /\.sw\.ya?ml$/.test(f)).forEach(f => fs.unlinkSync(path.join(flowDir, f)));
// Execution Plan in JSON: input della variante B (interprete Java)
const plansDir = path.join(root, 'src', 'main', 'resources', 'plans');
fs.mkdirSync(plansDir, { recursive: true });
fs.readdirSync(plansDir).filter(f => /\.plan\.json$/.test(f)).forEach(f => fs.unlinkSync(path.join(plansDir, f)));
built.forEach(b => fs.writeFileSync(path.join(plansDir, b.id + '.plan.json'), JSON.stringify(b.plan, null, 2) + '\n'));

const STATUS = { COMPLETED: 'COMPLETED', STOPPED: 'STOPPED', FAILED: 'NO_PRODUCTS', NO_PRODUCTS: 'NO_PRODUCTS', WAITING: 'WAITING' };
const scenariosOut = [];
built.forEach(b => {
  b.files.forEach(f => fs.writeFileSync(path.join(flowDir, f.name), f.content));
  const mainName = b.files[0].name.replace(/\.sw\.yaml$/, '');
  const taskOf = Object.fromEntries(b.blocks.map(x => [x.id, x]));
  // (servizio, prodotto) deve identificare in modo univoco un blocco, altrimenti la traduzione verso i mock è ambigua
  const seen = {};
  b.blocks.forEach(x => x.products.forEach(p => { const k = x.taskId + '/' + p; if (seen[k]) throw new Error('coppia servizio/prodotto duplicata: ' + k); seen[k] = x.id; }));

  b.scenarios.forEach(s => {
    const mock = {};
    Object.keys(s.outcomes).forEach(bid => Object.keys(s.outcomes[bid]).forEach(p => {
      const o = s.outcomes[bid][p];
      if (o === 'KO') (mock[taskOf[bid].taskId] = mock[taskOf[bid].taskId] || {})[p] = 'KO';
    }));
    const latency = {};
    Object.keys(s.latency || {}).forEach(bid => { latency[taskOf[bid].taskId] = s.latency[bid]; });
    // chiamate attese: 1 per blocco "per offerta", N per blocco "per prodotto", sui prodotti ancora in corsa
    // all'ingresso dello step e non saltati dal simulatore (dipendenza in KO)
    const expectedCalls = {}, expectedProducts = {};
    b.blocks.forEach(blk => {
      const step = s.steps.find(x => x.stepId === blk.stepId);
      const skip = (s.skippedByBlock || {})[blk.id] || [];
      const active = blk.products.filter(p => step && step.entering.indexOf(p) >= 0 && skip.indexOf(p) < 0);
      const n = !active.length ? 0 : (blk.callMode === 'perOffer' ? 1 : active.length);
      expectedCalls[blk.taskId] = (expectedCalls[blk.taskId] || 0) + n;
      expectedProducts[blk.taskId] = [...new Set([...(expectedProducts[blk.taskId] || []), ...active])].sort();
    });
    scenariosOut.push({
      offerId: b.id, workflow: 'offers:' + mainName, name: s.name, mock, latency, maxMillis: s.maxMillis,
      expected: { status: STATUS[s.final.status] || s.final.status, activeProducts: (s.final.active || []).slice().sort(), message: s.final.message },
      expectedCalls, expectedProducts,
      input: { pratica: { id: 'PRA-' + b.id + '-' + s.name }, cliente: { codiceFiscale: 'RSSMRA80A01H501U', email: 'mario.rossi@example.com', documento: { tipo: 'CI', numero: 'AX1234567', scadenza: '2030-01-01' } } }
    });
  });
});
const testRes = path.join(root, 'src', 'test', 'resources');
fs.mkdirSync(testRes, { recursive: true });
fs.writeFileSync(path.join(testRes, 'scenarios.json'), JSON.stringify(scenariosOut, null, 2) + '\n');
console.log('workflow generati:', fs.readdirSync(flowDir).join(', '));
console.log('scenari:', scenariosOut.length);
scenariosOut.forEach(s => console.log(' -', s.offerId, s.name, '->', s.expected.status, '[' + s.expected.activeProducts.join(',') + ']'));
