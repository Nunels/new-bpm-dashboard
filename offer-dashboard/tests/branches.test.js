/* Rami di uno step: catene indipendenti in parallelo nel DSL, join a gruppo. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const ctx = load();
const { Model, Simulator, Validation, Exporters, ExecutionPlan } = ctx;
const clone = function (x) { return JSON.parse(JSON.stringify(x)); };

/* Offerta con i blocchi dell'immagine: Cribis (Conto) e Pregiudizievoli (Conto, Evo) nei Verticali, più blocchi dopo ciascuno. */
function setup(extra) {
  const data = Model.normalize(clone(ctx.SEED));
  const offer = { id: 'OFF_R', name: 'Rami', description: '', products: ['CONTO', 'EVO'], gates: [], blocks: [
    { id: 'B_CRIBIS', taskId: 'CRIBIS', stepId: 'VERTICALI', products: ['CONTO'], dependsOn: [] },
    { id: 'B_PREG', taskId: 'PREGIUDIZIEVOLI', stepId: 'VERTICALI', products: ['CONTO', 'EVO'], dependsOn: [] },
    { id: 'B_T1', taskId: 'STAMPA_CONTRATTI', stepId: 'VERTICALI', products: ['CONTO'], dependsOn: ['B_CRIBIS'] },
    { id: 'B_T', taskId: 'STAMPA_CONTRATTI', stepId: 'VERTICALI', products: ['CONTO', 'EVO'], dependsOn: ['B_PREG'] }
  ].concat(extra || []) };
  data.offers.push(offer);
  Model.normalize(data);
  return { data: data, offer: data.offers[data.offers.length - 1] };
}
const dsl = function (s) { return Exporters.buildServerless(ExecutionPlan.build(s.data, s.offer)).main; };
const stepTasks = function (main) { return main.do.find(function (t) { return t['step-verticali']; })['step-verticali'].do; };
const names = function (list) { return list.map(function (t) { return Object.keys(t)[0]; }); };

test('Model.branches: due catene indipendenti sono due alberi', function () {
  const s = setup();
  const br = Model.branches(Model.blocksInStep(s.offer, 'VERTICALI'));
  assert.equal(br.length, 2);
  assert.deepEqual(clone(br.map(function (b) { return b.kind; })), ['tree', 'tree']);
  assert.equal(br[0].root.ref.id, 'B_CRIBIS');
  assert.equal(br[0].root.children[0].ref.id, 'B_T1');
  assert.equal(br[1].root.children[0].ref.id, 'B_T');
});

test('DSL: i rami sono indipendenti (T1 non aspetta Pregiudizievoli)', function () {
  const s = setup();
  const tasks = stepTasks(dsl(s));
  assert.equal(tasks.length, 1, 'un solo fork di rami nello step');
  const fork = tasks[0]['verticali-branches'].fork;
  assert.equal(fork.branches.length, 2);
  const inner = fork.branches.map(function (b) { return names(b[Object.keys(b)[0]].do); });
  assert.deepEqual(clone(inner), [['b-cribis', 'b-t1'], ['b-preg', 'b-t']]);
  assert.ok(ctx.jsyaml.load(Exporters.toYaml(dsl(s))));
});

test('DSL: albero con un blocco che apre due figli e blocco isolato', function () {
  const s = setup([
    { id: 'B_F1', taskId: 'STAMPA_CONTRATTI', stepId: 'VERTICALI', products: ['CONTO'], dependsOn: ['B_CRIBIS'] },
    { id: 'B_SOLO', taskId: 'ATTIVAZIONE_BANCARIA', stepId: 'VERTICALI', products: ['EVO'], dependsOn: [] }
  ]);
  const main = dsl(s);
  const fork = stepTasks(main)[0]['verticali-branches'].fork;
  assert.equal(fork.branches.length, 3);
  const first = fork.branches[0]['verticali-branch-b-cribis'].do;
  assert.deepEqual(clone(names(first)), ['b-cribis', 'verticali-fork-b-cribis']);
  assert.equal(first[1]['verticali-fork-b-cribis'].fork.branches.length, 2);
  assert.ok(fork.branches[2]['b-solo'], 'blocco isolato = ramo con un solo task');
});

test('DSL: un join mette i blocchi collegati in un gruppo a livelli', function () {
  const s = setup([{ id: 'B_J', taskId: 'ATTIVAZIONE_BANCARIA', stepId: 'VERTICALI', products: ['CONTO'], dependsOn: ['B_CRIBIS', 'B_PREG'] }]);
  const br = Model.branches(Model.blocksInStep(s.offer, 'VERTICALI'));
  assert.equal(br.length, 1);
  assert.equal(br[0].kind, 'levels');
  const tasks = stepTasks(dsl(s));
  assert.ok(names(tasks).some(function (n) { return /group-1-stage-1/.test(n); }));
  const msgs = Validation.validateOffer(s.data, s.offer).infos.map(function (i) { return i.msg; }).join('\n');
  assert.match(msgs, /join/);
});

test('simulatore e DSL coincidono: se Cribis è KO T1 non parte ma T sì', function () {
  const s = setup();
  const sim = Simulator.run(s.data, s.offer, { B_CRIBIS: { CONTO: 'KO' } }, {});
  const r = sim.steps.find(function (x) { return x.stepId === 'VERTICALI'; }).blockResults;
  assert.equal(r.B_T1.CONTO, 'SKIPPED');
  assert.equal(r.B_T.CONTO, 'OK');
  assert.match(JSON.stringify(dsl(s)), /koByBlock\[\\"B_CRIBIS\\"\]/);
});

test('validazione: dipendenza da un blocco che non copre tutti i prodotti', function () {
  const s = setup();
  s.offer.blocks.find(function (b) { return b.id === 'B_T'; }).dependsOn = ['B_CRIBIS'];
  const w = Validation.validateOffer(s.data, s.offer).warnings.map(function (x) { return x.msg; }).join('\n');
  assert.match(w, /non copre Evo/);
});

test('griglia: il figlio sta sulla corsia del genitore (caso dell\'immagine), il join sulla prima corsia libera', function () {
  const s = setup([
    { id: 'B_J', taskId: 'ATTIVAZIONE_BANCARIA', stepId: 'VERTICALI', products: ['CONTO', 'EVO'], dependsOn: ['B_PREG', 'B_CRIBIS'] },
    { id: 'B_T3', taskId: 'STAMPA_CONTRATTI', stepId: 'VERTICALI', products: ['CONTO'], dependsOn: ['B_T1'] }
  ]);
  const L = Model.layoutStep(s.offer, 'VERTICALI');
  const p = {}; L.placements.forEach(function (x) { p[x.block.id] = x; });
  assert.equal(L.lanes, 3, 'tre livelli = tre colonne');
  assert.equal(p.B_CRIBIS.k0, 0);
  assert.equal(p.B_PREG.k0, 1);
  assert.equal(p.B_T1.k0, p.B_CRIBIS.k0, 'T1 sulla corsia di Cribis');
  assert.equal(p.B_T3.k0, p.B_T1.k0, 'T3 sulla corsia di T1');
  assert.equal(p.B_T3.lane, 2);
  assert.equal(p.B_T3.rankTop[0], p.B_T1.rankTop[0], 'T3 grande come T1');
  assert.equal(p.B_T3.rankBot[0], p.B_T1.rankBot[0]);
  assert.equal(p.B_J.k0, 2, 'le corsie dei genitori sono occupate da T1 e T: il join va sulla prima libera');
  assert.equal(p.B_T3.laneCount[0], 3, 'la riga di Conto ha tre corsie');
  assert.equal(L.laneCount[1], 2, 'Evo: Pregiudizievoli, T e il join');
});

test('griglia: un join libero si allunga sulle corsie di tutti i genitori', function () {
  const s = setup([{ id: 'B_J', taskId: 'ATTIVAZIONE_BANCARIA', stepId: 'VERTICALI', products: ['CONTO'], dependsOn: ['B_CRIBIS', 'B_PREG'] }]);
  // T1 e T dipendono da un solo genitore: li tolgo per lasciare libera la colonna del join
  s.offer.blocks = s.offer.blocks.filter(function (b) { return b.id !== 'B_T1' && b.id !== 'B_T'; });
  const L = Model.layoutStep(s.offer, 'VERTICALI');
  const j = L.placements.find(function (x) { return x.block.id === 'B_J'; });
  assert.equal(j.k0, 0);
  assert.equal(j.k1, 1);
  assert.equal(j.rankTop[0], 0);
  assert.equal(j.rankBot[0], 1, 'copre entrambe le sotto-righe di Conto');
});