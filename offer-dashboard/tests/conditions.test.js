/* Condizioni dei blocchi (when) e instradamento dei gate (ROUTE): valutazione, simulatore, DSL e validazione. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const ctx = load();
const { Model, Conditions, Simulator, Validation, Exporters, ExecutionPlan } = ctx;

const clone = function (x) { return JSON.parse(JSON.stringify(x)); };
const cl = function (left, op, value) { return { left: left, op: op, value: value }; };

function setup() {
  const data = Model.normalize(clone(ctx.SEED));
  const offer = data.offers.find(function (o) { return o.id === 'OFF_BUNDLE'; });
  return { data: data, offer: offer, block: function (id) { return offer.blocks.find(function (b) { return b.id === id; }); }, gate: function (id) { return offer.gates.find(function (g) { return g.id === id; }); } };
}

function dslOf(s) {
  return Exporters.buildServerless(ExecutionPlan.build(s.data, s.offer));
}

/* Ogni `then` deve indicare continue/exit/end o un task fratello nella stessa lista (è ciò che richiede l'interprete). */
function assertThens(list, where) {
  const names = list.map(function (t) { return Object.keys(t)[0]; });
  list.forEach(function (t) {
    const name = Object.keys(t)[0];
    const task = t[name];
    const check = function (then, at) {
      if (then === undefined || ['continue', 'exit', 'end'].indexOf(then) >= 0) return;
      assert.ok(names.indexOf(then) >= 0, where + '/' + at + ': then "' + then + '" non è un task fratello');
    };
    check(task.then, name);
    if (Array.isArray(task.switch)) task.switch.forEach(function (c) { const k = Object.keys(c)[0]; check(c[k].then, name + '/' + k); });
    if (Array.isArray(task.do)) assertThens(task.do, where + '/' + name);
  });
}

test('Conditions: valutazione, AND/OR e negazione (Altrimenti)', function () {
  const values = { 'a.x': 'PON', 'a.n': 700, esito: undefined };
  const env = { value: function (l) { return values[l]; }, type: function (l) { return l === 'a.n' ? 'number' : 'string'; } };
  const w = { join: 'AND', clauses: [cl('a.x', '==', 'PON'), cl('a.n', '>=', '600')] };
  assert.equal(Conditions.evaluate(w, env), true);
  assert.equal(Conditions.evaluate({ join: 'OR', clauses: [cl('a.x', '==', 'ALTRO'), cl('a.n', '<', '10')] }, env), false);
  assert.equal(Conditions.evaluate(Conditions.negate(w), env), false, 'not(A and B) con A e B vere');
  values['a.n'] = 100;
  assert.equal(Conditions.evaluate(w, env), false);
  assert.equal(Conditions.evaluate(Conditions.negate(w), env), true);
  assert.equal(Conditions.evaluate({ join: 'AND', clauses: [cl('a.x', 'in', 'PON, ABC')] }, env), true);
  assert.equal(Conditions.evaluate({ join: 'AND', clauses: [cl('manca', 'exists', '')] }, env), false);
  assert.equal(Conditions.evaluate({ join: 'AND', clauses: [cl('manca', '>', '1')] }, env), false, 'campo assente: i confronti ordinati sono falsi');
  assert.equal(Conditions.evaluate(Conditions.emptyWhen(), env), true);
});

test('when su blocco per prodotto: simulatore e DSL (if dentro il for)', function () {
  const s = setup();
  s.block('B_CRIBIS').config.when = { join: 'AND', clauses: [cl('cliente.documento.tipo', '==', 'CI')] };
  assert.equal(Validation.validateOffer(s.data, s.offer).errors.length, 0);

  const skipped = Simulator.run(s.data, s.offer, {}, { practice: { cliente: { documento: { tipo: 'PASS' } } } });
  assert.equal(skipped.blocks.B_CRIBIS.results.CONTO, 'SKIPPED_BY_CONDITION');
  assert.equal(skipped.final.status, 'COMPLETED', 'un blocco saltato per condizione non è un KO');
  const ran = Simulator.run(s.data, s.offer, { B_CRIBIS: { CONTO: 'KO' } }, { practice: { cliente: { documento: { tipo: 'CI' } } } });
  assert.equal(ran.blocks.B_CRIBIS.results.CONTO, 'KO');

  const main = dslOf(s).main;
  const unit = main.do.find(function (t) { return t['b-cribis']; })['b-cribis'];
  const run = unit.do[0]['b-cribis-run'];
  assert.ok(run.for, 'blocco per prodotto = for');
  const inner = run.do[0][Object.keys(run.do[0])[0]];
  assert.match(inner.if, /\$workflow\.input\.cliente\.documento\.tipo == "CI"/);
  assert.ok(Array.isArray(inner.do) && inner.do.length >= 1);
  // anche saltato, il blocco registra i prodotti esclusi a monte: i nodi successivi li ereditano
  assert.ok(unit.do[1]['b-cribis-settle'].export.as.indexOf('"B_CRIBIS"') > 0);
});

test('when su blocco per offerta: esito di un blocco precedente e prodotti presenti', function () {
  const s = setup();
  const w = s.block('B_WELCOME');
  w.config.when = { join: 'AND', clauses: [cl('esito.B_CRIBIS', '==', 'KO'), cl('offerta.prodotti', 'contains', 'CONTO')] };
  assert.equal(Validation.validateOffer(s.data, s.offer).errors.length, 0, JSON.stringify(Validation.validateOffer(s.data, s.offer).errors));
  const main = dslOf(s).main;
  const text = JSON.stringify(main);
  assert.ok(text.includes('koByBlock[\\"B_CRIBIS\\"]'));
  const sim = Simulator.run(s.data, s.offer, {}, {});
  assert.equal(sim.blocks.B_WELCOME.results.CONTO, 'SKIPPED_BY_CONDITION', 'nessun KO in Cribis: la condizione non è soddisfatta');
  w.config.when.clauses[0].value = 'OK';
  const ran = Simulator.run(s.data, s.offer, {}, {});
  assert.equal(ran.blocks.B_WELCOME.results.CONTO, 'OK');
});

test('ROUTE all\'indietro: contatore, limite e DSL con destinazioni fratelle', function () {
  const s = setup();
  s.gate('G_VER_1').rules.push({ type: 'ROUTE', when: { join: 'AND', clauses: [cl('esito.B_CRIBIS', '==', 'KO')] }, to: 'B_CRIBIS', maxIterations: 2, onExceed: 'STOP' });
  const v = Validation.validateOffer(s.data, s.offer);
  assert.equal(v.errors.length, 0, JSON.stringify(v.errors));

  const stop = Simulator.run(s.data, s.offer, { B_CRIBIS: { CONTO: 'KO' } }, {});
  assert.equal(stop.final.status, 'STOPPED');
  assert.equal(stop.routes.length, 2, 'due ritorni e poi stop');
  assert.equal(stop.blocks.B_CRIBIS.passes, 3);

  const fixed = Simulator.run(s.data, s.offer, { B_CRIBIS: { CONTO: 'KO' } }, {}, { recoverAfterLoop: true });
  assert.equal(fixed.final.status, 'COMPLETED');
  assert.equal(fixed.routes.length, 1);

  const perPass = Simulator.run(s.data, s.offer, { B_CRIBIS: { CONTO: ['KO', 'OK'] } }, {});
  assert.equal(perPass.final.status, 'COMPLETED', 'esito per passaggio: KO al primo giro, OK al secondo');

  const main = dslOf(s).main;
  assertThens(main.do, '/do');
  const names = main.do.map(function (t) { return Object.keys(t)[0]; });
  assert.ok(names.indexOf('gate-g-ver-1-route') >= 0 && names.indexOf('gate-g-ver-1-route') < names.indexOf('gate-g-ver-1-apply'), 'il ritorno si valuta prima delle regole del gate');
  const go = names.indexOf('gate-g-ver-1-go-1');
  assert.ok(go > names.indexOf('offer-completed') && go > names.indexOf('offer-stopped'), 'il task di ritorno sta in fondo, dopo i terminali');
  const sw = main.do[names.indexOf('gate-g-ver-1-route')]['gate-g-ver-1-route'].switch;
  assert.match(sw[0]['route-1'].when, /\(\$context\.loops \/\/ \{\}\)\["G_VER_1-1"\] \/\/ 0\) < 2/);
  assert.equal(sw[0]['route-1'].then, 'gate-g-ver-1-go-1');
  assert.equal(main.do[go]['gate-g-ver-1-go-1'].then, 'b-cribis');
  // il ritorno azzera i KO dei nodi che verranno rieseguiti
  assert.match(main.do[go]['gate-g-ver-1-go-1'].export.as, /dead: .*"B_CRIBIS"/);
  // il YAML prodotto si rilegge e mantiene le destinazioni valide
  const reread = ctx.jsyaml.load(Exporters.toYaml(main));
  assertThens(reread.do, '/do');
});

test('ROUTE in avanti e verso STOP', function () {
  const s = setup();
  s.gate('G_PRE_1').rules.push({ type: 'ROUTE', when: { join: 'AND', clauses: [cl('cliente.documento.tipo', '==', 'PASS')] }, to: 'B_BO', maxIterations: 3, onExceed: 'STOP' });
  s.gate('G_BO_1').rules.push({ type: 'ROUTE', when: { join: 'AND', clauses: [cl('cliente.email', 'nexists', '')] }, to: 'STOP' });
  assert.equal(Validation.validateOffer(s.data, s.offer).errors.length, 0, JSON.stringify(Validation.validateOffer(s.data, s.offer).errors));

  const sim = Simulator.run(s.data, s.offer, {}, { practice: { cliente: { documento: { tipo: 'PASS' }, email: 'a@b.it' } } });
  assert.equal(sim.blocks.B_CRIBIS.skipped, true);
  assert.equal(sim.routes[0].kind, 'skip');
  assert.equal(sim.final.status, 'COMPLETED');
  const stopped = Simulator.run(s.data, s.offer, {}, { practice: { cliente: { documento: { tipo: 'CI' } } } });
  assert.equal(stopped.final.status, 'STOPPED');

  const main = dslOf(s).main;
  assertThens(main.do, '/do');
  const names = main.do.map(function (t) { return Object.keys(t)[0]; });
  assert.ok(names.indexOf('gate-g-pre-1-skip') > names.indexOf('gate-g-pre-1-apply'), 'il salto in avanti segue la politica KO');
  assert.equal(main.do[names.indexOf('gate-g-pre-1-skip')]['gate-g-pre-1-skip'].switch[0]['route-1'].then, 'gate-g-pre-1-skip-go-1');
  const go = main.do[names.indexOf('gate-g-pre-1-skip-go-1')]['gate-g-pre-1-skip-go-1'];
  assert.equal(go.then, 'b-bo');
  assert.match(go.export.as, /"B_CRIBIS": \(\$context\.dead\["G_PRE_1"\]/, 'i nodi saltati lasciano passare i prodotti del gate');
  assert.ok(names.indexOf('offer-stopped') >= 0);
});

test('validazione: condizioni e instradamenti incoerenti', function () {
  const s = setup();
  s.block('B_ORACOLO').config.when = { join: 'AND', clauses: [cl('esito.B_CRIBIS', '==', 'OK')] };       // B_CRIBIS viene dopo
  s.block('B_BO').config.when = { join: 'AND', clauses: [cl('prodotto.id', '==', 'CONTO')] };            // blocco "per offerta"
  s.block('B_CRIBIS').config.when = { join: 'AND', clauses: [cl('cliente.documento.tipo', '==', '')] };   // valore mancante
  s.gate('G_VER_1').rules.push({ type: 'ROUTE', when: { join: 'AND', clauses: [] }, to: 'NOPE', maxIterations: 50, onExceed: 'STOP' });
  const msgs = Validation.validateOffer(s.data, s.offer).errors.map(function (e) { return e.msg; }).join('\n');
  assert.match(msgs, /non è eseguito prima/);
  assert.match(msgs, /"prodotto\.id" esiste solo/);
  assert.match(msgs, /valore mancante/);
  assert.match(msgs, /condizione vuota/);
  assert.match(msgs, /la destinazione "NOPE" non esiste/);
  assert.match(msgs, /tra 1 e 10/);
});