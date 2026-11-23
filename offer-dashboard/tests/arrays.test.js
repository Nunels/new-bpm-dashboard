/* Liste in input e output dei task: campi, mappature, DSL, condizioni, simulatore e validazione. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const ctx = load();
const { Model, Fields, Conditions, Simulator, Validation, Exporters, ExecutionPlan } = ctx;

const clone = function (x) { return JSON.parse(JSON.stringify(x)); };
const cl = function (left, op, value) { return { left: left, op: op, value: value }; };

function setup() {
  const data = Model.normalize(clone(ctx.SEED));
  const offer = data.offers.find(function (o) { return o.id === 'OFF_BUNDLE'; });
  return { data: data, offer: offer, block: function (id) { return offer.blocks.find(function (b) { return b.id === id; }); }, task: function (id) { return data.tasks.find(function (t) { return t.id === id; }); } };
}

function dsl(s) { Model.normalize(s.data); return Exporters.buildServerless(ExecutionPlan.build(s.data, s.offer)).main; }

/* Chiamata http del blocco (con retry Ã¨ dentro try/invoke), ovunque sia nel DSL. */
function findCall(node, name) {
  if (!node || typeof node !== 'object') return null;
  if (node[name]) return node[name].call ? node[name] : (node[name].try && node[name].try[0] && node[name].try[0].invoke) || null;
  const kids = Array.isArray(node) ? node : Object.keys(node).map(function (k) { return node[k]; });
  for (let i = 0; i < kids.length; i++) { const r = findCall(kids[i], name); if (r) return r; }
  return null;
}

test('campi: schema ed esempio con array di oggetti diventano x[].campo', function () {
  const schema = { type: 'object', properties: { spedizioni: { type: 'array', items: { type: 'object', required: ['cap'], properties: { cap: { type: 'string' }, colli: { type: 'array', items: { type: 'object', properties: { peso: { type: 'number' } } } } } } }, tags: { type: 'array', items: { type: 'string' } } } };
  const r = Fields.parse(JSON.stringify(schema));
  const names = r.fields.map(function (f) { return f.name + ':' + f.type; }).sort();
  assert.deepEqual(clone(names), ['spedizioni[].cap:string', 'spedizioni[].colli[].peso:number', 'tags:array']);
  assert.equal(r.fields.find(function (f) { return f.name === 'spedizioni[].cap'; }).required, true);

  const ex = Fields.parse('{"spedizioni":[{"cap":"00144","peso":1},{"cap":"46019","note":"x"}],"ids":[1,2]}');
  assert.deepEqual(clone(ex.fields.map(function (f) { return f.name; }).sort()), ['ids', 'spedizioni[].cap', 'spedizioni[].note', 'spedizioni[].peso']);
});

test('campi: toSchema genera array con items e getPath/setPath proiettano le liste', function () {
  const s = Fields.toSchema([{ name: 'spedizioni[].cap', type: 'string', required: true }, { name: 'spedizioni[].colli[].peso', type: 'number' }, { name: 'pratica.id', type: 'string' }]);
  assert.equal(s.properties.spedizioni.type, 'array');
  assert.deepEqual(clone(s.properties.spedizioni.items.required), ['cap']);
  assert.equal(s.properties.spedizioni.items.properties.colli.items.properties.peso.type, 'number');
  const obj = { spedizioni: [{ cap: 'A', colli: [{ peso: 1 }, { peso: 2 }] }, { cap: 'B', colli: [{ peso: 3 }] }] };
  assert.deepEqual(clone(Fields.getPath(obj, 'spedizioni[].cap')), ['A', 'B']);
  assert.deepEqual(clone(Fields.getPath(obj, 'spedizioni[].colli[].peso')), [1, 2, 3]);
  assert.equal(Fields.getPath(obj, 'spedizioni[@].cap'), 'A');
  assert.equal(Fields.getPath(obj, 'mancante[]'), undefined);
  const made = Fields.setPath({}, 'a[].b.c', 1);
  assert.deepEqual(clone(made), { a: [{ b: { c: 1 } }] });
});

test('classify: elemento di lista, dato per prodotto, percorsi e risultati con []', function () {
  assert.equal(Fields.classify('@.cap', null).kind, 'item');
  assert.equal(Fields.classify('@', null).kind, 'item');
  assert.equal(Fields.classify('prodotti.{prodotto}.msisdn', null).kind, 'productPath');
  assert.equal(Fields.classify('pratica.spedizioni[]', ['pratica']).kind, 'path');
  assert.equal(Fields.classify('esiti.B_X.risultati[@].score', null).kind, 'result');
  assert.equal(Fields.classify('v1.2', ['pratica']).kind, 'literal');
  assert.deepEqual(clone(Fields.rootsOf([{ name: 'spedizioni[].cap' }, { name: 'a.b' }])), ['spedizioni', 'a']);
});

test('DSL: lista un elemento per prodotto e lista da un campo della pratica (annidata e proiezioni)', function () {
  const s = setup();
  s.data.practice.fields.push({ name: 'pratica.spedizioni[].destinatario.cap', type: 'string' }, { name: 'pratica.spedizioni[].colli[].peso', type: 'number' });
  const bo = s.task('PRESA_IN_CARICO_BO');
  bo.inputs.push(
    { name: 'spedizioni[]', type: 'array', source: 'pratica.spedizioni[]', required: false },
    { name: 'spedizioni[].cap', source: '@.destinatario.cap' },
    { name: 'spedizioni[].colli[]', type: 'array', source: '@.colli[]' },
    { name: 'spedizioni[].colli[].peso', source: '@.peso' },
    { name: 'tuttiCap', type: 'array', source: 'pratica.spedizioni[].destinatario.cap' },
    { name: 'tuttiPesi', type: 'array', source: 'pratica.spedizioni[].colli[].peso' });
  Model.normalize(s.data);
  assert.equal(Validation.validateOffer(s.data, s.offer).errors.length, 0, JSON.stringify(Validation.validateOffer(s.data, s.offer).errors));
  const main = dsl(s);
  const body = findCall(main.do, 'b-bo-call').with.body;
  assert.match(body.spedizioni, /\(\$workflow\.input\.pratica\.spedizioni \/\/ \[\]\)\[\] as \$item0/);
  assert.match(body.spedizioni, /"cap": \(\$item0\.destinatario\.cap\)/);
  assert.match(body.spedizioni, /"colli": \(\[ \(\$item0\.colli \/\/ \[\]\)\[\] as \$item1 \| \{ "peso": \(\$item1\.peso\) \} \]\)/);
  assert.equal(body.tuttiCap, '${ [ ($workflow.input.pratica.spedizioni // [])[] | .destinatario.cap ] }');
  assert.equal(body.tuttiPesi, '${ [ ($workflow.input.pratica.spedizioni // [])[] | (.colli // [])[] | .peso ] }');
  assert.ok(!('spedizioni[]' in body) && !('spedizioni[].cap' in body), 'nessuna chiave letterale con []');
  // lo schema di input del workflow ha le liste con items
  const sp = main.input.schema.document.properties.pratica.properties.spedizioni;
  assert.equal(sp.type, 'array');
  assert.equal(sp.items.properties.colli.items.properties.peso.type, 'number');
  assert.ok(ctx.jsyaml.load(Exporters.toYaml(main)), 'il YAML si rilegge');
});

test('DSL: oggetto per prodotto e productOutcomes dalla lista risultati per prodotto', function () {
  const s = setup();
  const main = dsl(s);
  const call = findCall(main.do, 'b-oracolo-call');
  assert.match(call.with.body.prodotti, /as \$p \| \{ "id": \(\$p\) \}/);
  assert.match(call.output.as, /\(\.risultati == null\) then \. else/);
  assert.match(call.output.as, /\{ key: \(\.prodotto \| tostring\), value: \(if \(\.esito == "OK"\) then "OK" else "KO" end\) \}/);
  // senza la lista nella risposta resta il productOutcomes del servizio
  s.task('ORACOLO').productResults.koTask = ['MANUALE'];
  assert.match(findCall(dsl(s).do, 'b-oracolo-call').output.as, /elif \(\.esito == "MANUALE"\) then "KO_TASK"/);
});

test('[@] legge l\'elemento del prodotto corrente; condizioni su liste nel DSL e nel simulatore', function () {
  const s = setup();
  const cribis = s.task('CRIBIS');
  cribis.inputs.push({ name: 'scoreOracolo', type: 'integer', source: 'esiti.B_ORACOLO.risultati[@].score' });
  const b = s.block('B_CRIBIS');
  b.config = Model.normalize({ products: s.data.products, tasks: s.data.tasks, offers: [{ id: 'x', products: [], blocks: [clone(b)], gates: [] }] }).offers[0].blocks[0].config;
  b.config.inputMapping.scoreOracolo = 'esiti.B_ORACOLO.risultati[@].score';
  b.config.when = { join: 'AND', clauses: [cl('esiti.B_ORACOLO.risultati[@].esito', '==', 'OK'), cl('esiti.B_ORACOLO.risultati[].score', 'anyEq', '9')] };
  const v = Validation.validateOffer(s.data, s.offer);
  assert.equal(v.errors.length, 0, JSON.stringify(v.errors));
  const call = findCall(dsl(s).do, 'b-cribis-call');
  assert.match(call.with.query.scoreOracolo, /map\(select\(\.prodotto == \$product\)\) \| \.\[0\]\)\.score/);
  const when = JSON.stringify(dsl(s).do);
  assert.match(when, /any\(\. == 9\)|any\(\. == \\"9\\"\)/);

  const scenario = { practice: {}, outputs: { B_ORACOLO: { risultati: [{ prodotto: 'CONTO', esito: 'OK', score: 9 }, { prodotto: 'EVO', esito: 'KO', score: 3 }] } } };
  const sim = Simulator.run(s.data, s.offer, {}, scenario);
  const ver = sim.steps.find(function (x) { return x.stepId === 'VERTICALI'; });
  assert.equal(ver.blockResults.B_CRIBIS.CONTO, 'OK', 'elemento del prodotto OK e un punteggio uguale a 9');
  scenario.outputs.B_ORACOLO.risultati[0].esito = 'KO';
  assert.equal(Simulator.run(s.data, s.offer, {}, scenario).steps.find(function (x) { return x.stepId === 'VERTICALI'; }).blockResults.B_CRIBIS.CONTO, 'SKIPPED_BY_CONDITION');
});

test('condizioni su liste: operatori, negazione e numero di elementi', function () {
  const values = { 'x[].s': ['A', 'A'], 'y[].s': [] };
  const env = { value: function (l) { return values[l]; }, type: function () { return 'string'; } };
  const ev = function (left, op, value) { return Conditions.evaluate({ join: 'AND', clauses: [cl(left, op, value)] }, env); };
  assert.equal(ev('x[].s', 'allEq', 'A'), true);
  assert.equal(ev('x[].s', 'noneEq', 'B'), true);
  assert.equal(ev('x[].s', 'anyNe', 'A'), false);
  assert.equal(ev('x[].s', 'countGte', '2'), true);
  assert.equal(ev('y[].s', 'exists', ''), false);
  assert.equal(ev('y[].s', 'nexists', ''), true);
  const w = { join: 'AND', clauses: [cl('x[].s', 'allEq', 'A'), cl('x[].s', 'countLt', '5')] };
  assert.equal(Conditions.evaluate(Conditions.negate(w), env), false);
  assert.deepEqual(clone(Conditions.opsFor('x[].s', false).filter(function (k) { return k === '==' || k === 'anyEq'; })), ['anyEq']);
  assert.deepEqual(clone(Conditions.opsFor('x.s', false).filter(function (k) { return k === '==' || k === 'anyEq'; })), ['==']);
});

test('validazione: liste senza origine, riga mancante, @ fuori lista, [@] senza dichiarazione', function () {
  const s = setup();
  const bo = s.task('PRESA_IN_CARICO_BO');
  s.block('B_BO').config.inputMapping['documenti[]'] = '';
  let msgs = Validation.validateOffer(s.data, s.offer).errors.map(function (e) { return e.msg; }).join('\n');
  assert.match(msgs, /la lista "documenti\[\]" non ha un'origine/);
  s.block('B_BO').config.inputMapping['documenti[]'] = 'pratica.documenti[]';
  bo.inputs.push({ name: 'colli[].peso', source: '@.peso' });
  s.block('B_BO').config.inputMapping['colli[].peso'] = '@.peso';
  bo.inputs.push({ name: 'fuori', source: '@.x' });
  s.block('B_BO').config.inputMapping.fuori = '@.x';
  bo.inputs.push({ name: 'sc', source: 'esiti.B_ORACOLO.risultati[@].score' });
  s.block('B_BO').config.inputMapping.sc = 'esiti.B_ORACOLO.risultati[@].score';
  msgs = Validation.validateOffer(s.data, s.offer).errors.map(function (e) { return e.msg; }).join('\n');
  assert.match(msgs, /manca la riga della lista "colli\[\]"/);
  assert.match(msgs, /@ si usa solo dentro una lista/);
  assert.match(msgs, /\[@\] si usa in un blocco "1 chiamata per prodotto"/);
  s.task('ORACOLO').productResults.productField = 'inesistente';
  assert.match(Validation.validateOffer(s.data, s.offer).errors.map(function (e) { return e.msg; }).join('\n'), /manca l'output "risultati\[\]\.inesistente"/);
});

test('modello della pratica ricavato dai task con liste', function () {
  const s = setup();
  const inferred = Fields.inferPractice(s.data.tasks).fields.map(function (f) { return f.name; });
  assert.ok(inferred.indexOf('pratica.documenti[].tipo') >= 0 && inferred.indexOf('pratica.documenti[].nome') >= 0, JSON.stringify(inferred));
  assert.ok(inferred.indexOf('pratica.documenti[]') < 0);
  const nested = Fields.inferPractice([{ inputs: [
    { name: 'sp[]', source: 'pratica.sp[]' }, { name: 'sp[].colli[]', source: '@.colli[]' }, { name: 'sp[].colli[].peso', source: '@.peso' }, { name: 'tags[]', source: 'pratica.tags[]' }] }]).fields.map(function (f) { return f.name; });
  assert.deepEqual(clone(nested.sort()), ['pratica.id', 'pratica.sp[].colli[].peso', 'pratica.tags']);
});

test('offerta demo OFF_DEMO: valida, con tutte le funzioni, DSL e simulazione', function () {
  const data = Model.normalize(clone(ctx.SEED));
  const offer = data.offers.find(function (o) { return o.id === 'OFF_DEMO'; });
  assert.ok(offer, 'offerta demo presente nel seed');
  const v = Validation.validateOffer(data, offer);
  assert.deepEqual(clone(v.errors), []);
  assert.deepEqual(clone(v.warnings.map(function (w) { return w.msg; })), []);

  // parallelo: tre blocchi nella stessa colonna dei preliminari
  const pre = Model.levels(Model.blocksInStep(offer, 'PRELIMINARI')).levels;
  assert.equal(pre.length, 1);
  assert.equal(pre[0].length, 3);
  // condizioni (anche su liste e con [@]), instradamenti avanti/indietro/stop, liste in input e output
  const whens = offer.blocks.filter(function (b) { return Conditions.isActive(b.config.when); }).length;
  assert.ok(whens >= 4);
  const kinds = offer.gates.reduce(function (acc, g) { return acc.concat(g.rules.filter(function (r) { return r.type === 'ROUTE'; }).map(function (r) { return r.to === 'STOP' ? 'stop' : Model.stepIndex(data, r.to) > Model.stepIndex(data, g.afterStep) ? 'avanti' : 'indietro'; })); }, []);
  assert.deepEqual(clone(kinds.sort()), ['avanti', 'indietro', 'stop']);

  const main = Exporters.buildServerless(ExecutionPlan.build(data, offer)).main;
  const text = JSON.stringify(main);
  ['gate-verticali-go-1', 'gate-preliminari-skip', 'offer-stopped', 'koByBlock', 'spedizioni', 'productOutcomes'].forEach(function (k) { assert.ok(text.indexOf(k) >= 0, k); });
  assert.ok(ctx.jsyaml.load(Exporters.toYaml(main)));

  // simulazione con i dati dello scenario: Cribis KO fa tornare ai preliminari, poi si passa
  const scenario = { practice: { cliente: { documento: { tipo: 'CI' }, giaVerificato: false }, pratica: { documenti: [{ tipo: 'CI', nome: 'a.pdf' }] } }, outputs: { B_D_ORACOLO: { risultati: [{ prodotto: 'CONTO', esito: 'OK', score: 80 }, { prodotto: 'EVO', esito: 'OK', score: 80 }] } } };
  const loop = Simulator.run(data, offer, { B_D_CRIBIS: { CONTO: ['KO', 'OK'] } }, scenario);
  assert.equal(loop.final.status, 'COMPLETED', loop.final.message);
  assert.equal(loop.routes.filter(function (r) { return r.kind === 'back'; }).length, 1);
  const skip = Simulator.run(data, offer, {}, Object.assign({}, scenario, { practice: { cliente: { documento: { tipo: 'CI' }, giaVerificato: true }, pratica: { documenti: [] } } }));
  assert.ok(skip.routes.some(function (r) { return r.kind === 'skip'; }));
  const stopped = Simulator.run(data, offer, {}, { practice: scenario.practice, outputs: { B_D_ORACOLO: { risultati: [{ prodotto: 'CONTO', esito: 'KO', score: 80 }] } } });
  assert.equal(stopped.final.status, 'STOPPED');
});

test('mappatura: elementi per prodotto, dati per prodotto e anteprima del body', function () {
  const s = setup();
  const t = s.task('ORACOLO');
  t.inputs.push({ name: 'prodotti[].msisdn', source: 'prodotti.{prodotto}.msisdn' });
  const b = s.block('B_ORACOLO');
  b.config.inputMapping['prodotti[].msisdn'] = 'prodotti.{prodotto}.msisdn';
  assert.equal(Fields.status(s.data, s.offer, b, t.inputs.find(function (i) { return i.name === 'prodotti[].msisdn'; })).level, 'ok');
  assert.equal(Fields.status(s.data, s.offer, b, t.inputs.find(function (i) { return i.name === 'prodotti[]'; })).level, 'ok');
  const shape = Fields.bodyShape(t, b.config.inputMapping);
  assert.deepEqual(clone(shape.prodotti), [{ id: 'prodotto.id', msisdn: 'prodotti.{prodotto}.msisdn' }]);
  const main = dsl(s);
  assert.match(findCall(main.do, 'b-oracolo-call').with.body.prodotti, /"msisdn": \(\$workflow\.input\.prodotti\[\$p\]\.msisdn\)/);
});
