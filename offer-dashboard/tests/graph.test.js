/* Grafo libero: struttura serie/parallelo, gate di ramo e join, semantica dei KO, DSL, migrazione dal modello a step. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const ctx = load();
const { Model, Simulator, Validation, Exporters, ExecutionPlan } = ctx;
const clone = function (x) { return JSON.parse(JSON.stringify(x)); };

const blk = function (id, task, products, dependsOn) { return { id: id, taskId: task, products: products, dependsOn: dependsOn || [] }; };

/* Offerta con i blocchi dell'immagine: Cribis (Conto) e Pregiudizievoli (Conto, Evo), ognuno con un blocco dopo. */
function setup(extraBlocks, gates) {
  const data = Model.normalize(clone(ctx.SEED));
  const offer = { id: 'OFF_R', name: 'Rami', description: '', products: ['CONTO', 'EVO'], gates: gates || [], blocks: [
    blk('B_CRIBIS', 'CRIBIS', ['CONTO']),
    blk('B_PREG', 'PREGIUDIZIEVOLI', ['CONTO', 'EVO']),
    blk('B_T1', 'STAMPA_CONTRATTI', ['CONTO'], ['B_CRIBIS']),
    blk('B_T', 'STAMPA_CONTRATTI', ['CONTO', 'EVO'], ['B_PREG'])
  ].concat(extraBlocks || []) };
  data.offers.push(offer);
  Model.normalize(data);
  return { data: data, offer: data.offers[data.offers.length - 1] };
}
const dsl = function (s) { return Exporters.buildServerless(ExecutionPlan.build(s.data, s.offer)).main; };
const names = function (list) { return list.map(function (t) { return Object.keys(t)[0]; }); };
const shape = function (n) { return n.type === 'node' ? n.id : n.type + '(' + n.items.map(shape).join(',') + ')'; };

test('struttura: due catene indipendenti sono due rami paralleli', function () {
  const s = setup();
  const st = Model.structure(s.offer);
  assert.deepEqual(clone(st.errors), []);
  assert.equal(shape(st.tree), 'par(seq(B_CRIBIS,B_T1),seq(B_PREG,B_T))');
  assert.deepEqual(clone(st.top), [], 'nessun nodo nella sequenza principale: solo un fork');
});

test('struttura: un gate join riunisce i rami e apre la sequenza principale', function () {
  const s = setup([blk('B_FIN', 'ATTIVAZIONE_BANCARIA', ['CONTO'], ['G_J'])], [{ id: 'G_J', dependsOn: ['B_T1', 'B_T'], note: '', rules: [] }]);
  const st = Model.structure(s.offer);
  assert.deepEqual(clone(st.errors), []);
  assert.equal(shape(st.tree), 'seq(par(seq(B_CRIBIS,B_T1),seq(B_PREG,B_T)),G_J,B_FIN)');
  assert.deepEqual(clone(st.top), ['G_J', 'B_FIN']);
});

test('struttura: un join che raccoglie solo alcuni rami resta esprimibile (fork annidato)', function () {
  const s = setup([blk('B_J', 'ATTIVAZIONE_BANCARIA', ['CONTO'], ['B_CRIBIS', 'B_PREG']), blk('B_X', 'ATTIVAZIONE_BANCARIA', ['EVO'])]);
  s.offer.blocks = s.offer.blocks.filter(function (b) { return b.id !== 'B_T1' && b.id !== 'B_T'; });
  const st = Model.structure(s.offer);
  assert.deepEqual(clone(st.errors), []);
  assert.equal(shape(st.tree), 'par(seq(par(B_CRIBIS,B_PREG),B_J),B_X)');
});
test('struttura: rami che si incrociano (forma a N) non sono esprimibili: errore con suggerimento', function () {
  // A→C, A→D, B→D
  const s = setup([blk('B_C', 'ATTIVAZIONE_BANCARIA', ['CONTO'], ['B_CRIBIS', 'B_PREG']), blk('B_D', 'ATTIVAZIONE_BANCARIA', ['EVO'], ['B_PREG'])]);
  s.offer.blocks.find(function (b) { return b.id === 'B_T'; }).dependsOn = [];
  const st = Model.structure(s.offer);
  assert.equal(st.errors.length, 1);
  assert.equal(st.errors[0].kind, 'nonSeriesParallel');
  const msgs = Validation.validateOffer(s.data, s.offer).errors.map(function (e) { return e.msg; }).join('\n');
  assert.match(msgs, /non si possono esprimere nel DSL/);
  assert.match(msgs, /gate "join"/);
  assert.throws(function () { dsl(s); }, /grafo dell'offerta non è valido/);
  assert.equal(Simulator.run(s.data, s.offer, {}, {}).final.status, 'FAILED');
});

test('struttura: dipendenze circolari', function () {
  const s = setup();
  s.offer.blocks.find(function (b) { return b.id === 'B_CRIBIS'; }).dependsOn = ['B_T1'];
  assert.equal(Model.structure(s.offer).errors[0].kind, 'cycle');
  assert.match(Validation.validateOffer(s.data, s.offer).errors.map(function (e) { return e.msg; }).join('\n'), /circolari/);
});

test('DSL: i rami sono indipendenti e un gate di ramo sta dentro il suo ramo', function () {
  const s = setup([], [{ id: 'G_A', dependsOn: ['B_T1'], note: '', rules: [{ type: 'STOP_ON_KO', products: [] }] }]);
  const tasks = dsl(s).do;
  assert.deepEqual(clone(names(tasks)), ['init-offer', 'fork-1', 'offer-completed']);
  const fork = tasks[1]['fork-1'].fork;
  assert.equal(fork.branches.length, 2);
  const inner = fork.branches.map(function (b) { return names(b[Object.keys(b)[0]].do); });
  assert.deepEqual(clone(inner[0]), ['b-cribis', 'b-t1', 'gate-g-a-stop', 'gate-g-a-apply'], 'il gate del ramo A è nel ramo A');
  assert.deepEqual(clone(inner[1]), ['b-preg', 'b-t'], 'il ramo B non ha gate e non aspetta il ramo A');
  const stop = fork.branches[0][Object.keys(fork.branches[0])[0]].do[2]['gate-g-a-stop'];
  assert.ok(stop.raise && stop.if, 'lo stop su KO è un raise con if, valido in qualunque ramo');
  assert.ok(ctx.jsyaml.load(Exporters.toYaml(dsl(s))));
});

test('DSL: i nodi ereditano i prodotti KO/esclusi da chi li precede, anche se un blocco è stato saltato', function () {
  const s = setup();
  const t1 = dsl(s).do[1]['fork-1'].fork.branches[0]['branch-1'].do.find(function (t) { return t['b-t1']; })['b-t1'];
  const run = t1.do[0]['b-t1-run'];
  assert.match(run.for.in, /\$context\.dead\["B_CRIBIS"\]/, 'T1 esclude i prodotti KO di Cribis');
  assert.match(t1.do[1]['b-t1-settle'].set.dead, /\$context\.dead\["B_CRIBIS"\].*koByBlock.*"B_T1"/, 'il settle registra a monte + KO propri');
  assert.equal(Object.keys(t1.do[1])[0], 'b-t1-settle');
});

test('simulatore e DSL coincidono: se Cribis è KO T1 non parte ma T sì (rami indipendenti)', function () {
  const s = setup();
  const sim = Simulator.run(s.data, s.offer, { B_CRIBIS: { CONTO: 'KO' } }, {});
  assert.equal(sim.blocks.B_T1.results.CONTO, 'SKIPPED');
  assert.equal(sim.blocks.B_T.results.CONTO, 'OK');
  assert.equal(sim.productStatus.CONTO, 'KO', 'il prodotto è KO in un nodo finale');
  assert.equal(sim.productStatus.EVO, 'OK');
  assert.equal(sim.final.status, 'COMPLETED');
});

test('gate: Solo OK lascia fuori i KO a valle, Prosegui anche con KO li riammette, Stop ferma l\'offerta', function () {
  const mk = function (rules) {
    return setup([blk('B_FIN', 'ATTIVAZIONE_BANCARIA', ['CONTO', 'EVO'], ['G_J'])], [{ id: 'G_J', dependsOn: ['B_T1', 'B_T'], note: '', rules: rules }]);
  };
  const ko = { B_CRIBIS: { CONTO: 'KO' } };
  let s = mk([{ type: 'ONLY_OK' }]);
  assert.equal(Simulator.run(s.data, s.offer, ko, {}).blocks.B_FIN.results.CONTO, 'SKIPPED');
  s = mk([{ type: 'CONTINUE_ON_KO' }]);
  const cont = Simulator.run(s.data, s.offer, ko, {});
  assert.equal(cont.blocks.B_FIN.results.CONTO, 'OK');
  assert.equal(cont.productStatus.CONTO, 'OK');
  s = mk([{ type: 'STOP_ON_KO', products: [] }]);
  assert.equal(Simulator.run(s.data, s.offer, ko, {}).final.status, 'STOPPED');
  // senza gate (un blocco con più genitori è comunque un join) il KO arriva ai dipendenti
  s = setup([blk('B_J', 'ATTIVAZIONE_BANCARIA', ['CONTO'], ['B_T1', 'B_T'])]);
  assert.equal(Simulator.run(s.data, s.offer, ko, {}).blocks.B_J.results.CONTO, 'SKIPPED');
  // il DSL del gate che riammette i KO azzera l'elenco
  const apply = names(dsl(mk([{ type: 'CONTINUE_ON_KO' }])).do);
  assert.ok(apply.indexOf('gate-g-j-apply') > 0);
  assert.deepEqual(clone(dsl(mk([{ type: 'CONTINUE_ON_KO' }])).do.find(function (t) { return t['gate-g-j-apply']; })['gate-g-j-apply'].set.dead), []);
});

test('Non attendere: ammesso solo su un blocco collegato al gate e senza altri dipendenti', function () {
  const s = setup([], [{ id: 'G_J', dependsOn: ['B_T1', 'B_T'], note: '', rules: [{ type: 'DONT_WAIT', blockId: 'B_T1' }] }]);
  assert.equal(Validation.validateOffer(s.data, s.offer).errors.length, 0);
  const sim = Simulator.run(s.data, s.offer, { B_T1: { CONTO: 'PENDING' } }, {});
  assert.equal(sim.final.status, 'COMPLETED', 'il blocco non atteso non blocca il gate');
  const main = dsl(s);
  const start = JSON.stringify(main).match(/start-b-t1/);
  assert.ok(start, 'il blocco parte come sotto-workflow senza attesa');
  assert.equal(Exporters.buildServerless(ExecutionPlan.build(s.data, s.offer)).subflows.length, 1);
  s.offer.gates[0].rules = [{ type: 'DONT_WAIT', blockId: 'B_CRIBIS' }];
  assert.match(Validation.validateOffer(s.data, s.offer).errors.map(function (e) { return e.msg; }).join('\n'), /collegato direttamente al gate/);
});

test('ritorno/salto: solo per i gate della sequenza principale; nei rami resta lo STOP', function () {
  const s = setup([blk('B_FIN', 'ATTIVAZIONE_BANCARIA', ['CONTO'], ['G_J'])], [
    { id: 'G_A', dependsOn: ['B_T1'], note: '', rules: [{ type: 'ROUTE', to: 'B_FIN', maxIterations: 2, onExceed: 'STOP', when: { join: 'AND', clauses: [{ left: 'cliente.giaVerificato', op: '==', value: 'true' }] } }] },
    { id: 'G_J', dependsOn: ['G_A', 'B_T'], note: '', rules: [] }]);
  const msgs = Validation.validateOffer(s.data, s.offer).errors.map(function (e) { return e.msg; }).join('\n');
  assert.match(msgs, /dentro un ramo parallelo/);
  s.offer.gates[0].rules = [{ type: 'ROUTE', to: 'STOP', when: { join: 'AND', clauses: [{ left: 'cliente.giaVerificato', op: '==', value: 'true' }] } }];
  assert.equal(Validation.validateOffer(s.data, s.offer).errors.length, 0);
  const branch = dsl(s).do[1]['fork-1'].fork.branches[0]['branch-1'].do;
  assert.ok(names(branch).indexOf('gate-g-a-stop-route-1') >= 0, 'lo stop nel ramo è un raise con if');
});

test('griglia: rami in parallelo nella stessa colonna; il figlio sta sulla corsia del genitore, il join sulla prima libera', function () {
  const s = setup([blk('B_J', 'ATTIVAZIONE_BANCARIA', ['CONTO', 'EVO'], ['B_PREG', 'B_CRIBIS']), blk('B_T3', 'STAMPA_CONTRATTI', ['CONTO'], ['B_T1'])]);
  const L = Model.layout(s.offer);
  const p = {};
  L.placements.forEach(function (x) { p[x.id] = x; });
  assert.equal(L.lanes, 3, 'tre livelli = tre colonne');
  assert.equal(p.B_CRIBIS.lane, p.B_PREG.lane, 'blocchi paralleli nella stessa colonna');
  assert.equal(p.B_CRIBIS.k0, 0);
  assert.equal(p.B_PREG.k0, 1);
  assert.equal(p.B_T1.k0, p.B_CRIBIS.k0, 'T1 sulla corsia di Cribis');
  assert.equal(p.B_T3.k0, p.B_T1.k0, 'T3 sulla corsia di T1');
  assert.equal(p.B_T3.rankTop[0], p.B_T1.rankTop[0], 'T3 grande come T1');
  assert.equal(p.B_J.k0, 2, 'le corsie dei genitori sono occupate: il join va sulla prima libera');
  assert.equal(L.laneCount[0], 3, 'la riga di Conto ha tre corsie');
});

test('griglia: un gate join si allunga sulle corsie dei rami che riunisce', function () {
  const s = setup([], [{ id: 'G_J', dependsOn: ['B_CRIBIS', 'B_PREG'], note: '', rules: [] }]);
  s.offer.blocks = s.offer.blocks.filter(function (b) { return b.id !== 'B_T1' && b.id !== 'B_T'; });
  const j = Model.layout(s.offer).placements.find(function (x) { return x.id === 'G_J'; });
  assert.equal(j.kind, 'gate');
  assert.equal(j.k0, 0);
  assert.equal(j.k1, 1);
  assert.equal(j.rankBot[0], 1, 'copre entrambe le sotto-righe di Conto');
  assert.deepEqual(clone(j.products), ['CONTO', 'EVO'], 'governa i prodotti dei blocchi a monte');
});

test('migrazione dal modello a step: stesso comportamento, gate join per ogni step', function () {
  const legacy = {
    id: 'OFF_L', name: 'Vecchia', description: '', products: ['CONTO', 'EVO'],
    blocks: [
      { id: 'B_1', taskId: 'ORACOLO', stepId: 'PRELIMINARI', products: ['CONTO', 'EVO'], dependsOn: [] },
      { id: 'B_2', taskId: 'PREGIUDIZIEVOLI', stepId: 'PRELIMINARI', products: ['CONTO', 'EVO'], dependsOn: [] },
      { id: 'B_3', taskId: 'CRIBIS', stepId: 'VERTICALI', products: ['CONTO'], dependsOn: [] },
      { id: 'B_4', taskId: 'ATTIVAZIONE_BANCARIA', stepId: 'ATTIVAZIONI', products: ['CONTO', 'EVO'], dependsOn: [] }
    ],
    gates: [{ id: 'G_X', afterStep: 'PRELIMINARI', note: 'n', rules: [{ type: 'ONLY_OK' }] }]
  };
  const data = Model.normalize(clone(ctx.SEED));
  data.offers.push(legacy);
  Model.normalize(data);
  const o = data.offers[data.offers.length - 1];
  assert.ok(o.blocks.every(function (b) { return b.stepId === undefined; }));
  assert.equal(shape(Model.structure(o).tree), 'seq(par(B_1,B_2),G_X,B_3,G_VERTICALI,B_4)');
  assert.deepEqual(clone(Model.gate(o, 'G_X').dependsOn), ['B_1', 'B_2']);
  assert.deepEqual(clone(Model.block(o, 'B_3').dependsOn), ['G_X']);
  const sim = Simulator.run(data, o, { B_2: { EVO: 'KO' } }, {});
  assert.equal(sim.blocks.B_4.results.EVO, 'SKIPPED', 'il KO dello step esce dall\'offerta (default Solo OK)');
  assert.equal(sim.blocks.B_4.results.CONTO, 'OK');
  assert.equal(Validation.validateOffer(data, o).errors.length, 0);
});
