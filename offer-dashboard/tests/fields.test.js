/* Test del modello dei campi (pratica, mappatura input/output) e del DSL generato. Esecuzione: node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const ctx = load();
const { Store, Model, Fields, Exporters } = ctx;

const clone = function (x) { return JSON.parse(JSON.stringify(x)); };

test('parse: JSON Schema con $ref locale e annidamento', function () {
  const schema = {
    type: 'object', required: ['cliente'],
    properties: { cliente: { $ref: '#/$defs/Cliente' }, note: { type: 'string' }, scadenza: { type: 'string', format: 'date' }, tags: { type: 'array', items: { type: 'string' } } },
    $defs: { Cliente: { type: 'object', required: ['cf'], properties: { cf: { type: 'string' }, doc: { type: 'object', properties: { numero: { type: 'integer' } } } } } }
  };
  const r = Fields.parse(JSON.stringify(schema));
  const byName = {};
  r.fields.forEach(function (f) { byName[f.name] = f; });
  assert.deepEqual(clone(Object.keys(byName).sort()), ['cliente.cf', 'cliente.doc.numero', 'note', 'scadenza', 'tags']);
  assert.equal(byName['cliente.cf'].required, true);
  assert.equal(byName['cliente.doc.numero'].type, 'integer');
  assert.equal(byName.scadenza.type, 'date');
  assert.equal(byName.tags.type, 'array');
});

test('parse: JSON di esempio e documento OpenAPI rifiutato', function () {
  const r = Fields.parse('{"cliente":{"email":"a@b.it","eta":41,"nascita":"1980-01-02"},"vip":true}');
  assert.deepEqual(clone(r.fields.map(function (f) { return f.name + ':' + f.type; })), ['cliente.email:string', 'cliente.eta:integer', 'cliente.nascita:date', 'vip:boolean']);
  assert.match(Fields.parse('{"openapi":"3.0.0"}').error, /OpenAPI/);
  assert.match(Fields.parse('{').error, /non valido/);
});

test('toSchema: un campo obbligatorio rende obbligatori gli antenati', function () {
  const s = Fields.toSchema([{ name: 'pratica.id', type: 'string', required: true }, { name: 'cliente.doc.numero', type: 'integer', required: true }, { name: 'cliente.email', type: 'string' }]);
  assert.deepEqual(clone(s.required), ['pratica', 'cliente']);
  assert.deepEqual(clone(s.properties.cliente.required), ['doc']);
  assert.deepEqual(clone(s.properties.cliente.properties.doc.required), ['numero']);
  assert.equal(s.properties.cliente.properties.doc.properties.numero.type, 'integer');
});

test('classify: percorsi nidificati, sistema e valori fissi', function () {
  const roots = ['pratica', 'cliente'];
  assert.equal(Fields.classify('esiti.B_X.dati.codice', roots).field, 'dati.codice');
  assert.equal(Fields.classify('cliente.documento.numero', roots).kind, 'path');
  assert.equal(Fields.classify('v1.2', roots).kind, 'literal');
  assert.equal(Fields.classify('offerta.prodotti', roots).kind, 'system');
  assert.equal(Fields.classify('', roots).kind, 'none');
});

/* Dati di prova: due blocchi in sequenza (A per prodotto → B), con output annidato. */
function scenario() {
  const data = clone(Store.load());
  const base = data.tasks[0];
  const mk = function (id, extra) {
    return Object.assign(clone(base), { id: id, name: id, type: 'sync', callMode: 'perOffer', compatibleProducts: data.products.map(function (p) { return p.id; }), outcomes: ['OK', 'KO'], inputs: [], outputs: [] }, extra);
  };
  data.tasks.push(
    mk('T_A', { callMode: 'perProduct', api: { method: 'POST', path: '/a' }, inputs: [{ name: 'cf', type: 'string', required: true, source: 'cliente.codiceFiscale' }], outputs: [{ name: 'dati.codice', type: 'string' }] }),
    mk('T_B', {
      api: { method: 'GET', path: '/b/{id}' },
      inputs: [
        { name: 'id', type: 'string', required: true, source: '' },
        { name: 'richiesta.codice', type: 'string', required: true, source: '' },
        { name: 'prodotti', type: 'array', required: false, source: '' },
        { name: 'versione', type: 'string', required: false, source: '' }
      ]
    }));
  const pid = data.products[0].id;
  const offer = {
    id: 'OFF_T', name: 'Test', description: '', products: [pid, data.products[1].id], blocks: [
      { id: 'B_A', taskId: 'T_A', products: [pid, data.products[1].id], dependsOn: [], config: { callMode: 'perProduct' } },
      { id: 'B_B', taskId: 'T_B', products: [pid, data.products[1].id], dependsOn: ['B_A'], config: { callMode: 'perOffer', inputMapping: { id: 'pratica.id', 'richiesta.codice': 'esiti.B_A.dati.codice', prodotti: 'offerta.prodotti', versione: 'v1.2' } } }
    ], gates: []
  };
  data.offers = [offer];
  return Model.normalize(data);
}

test('status: mappature risolte, fisse e non risolte', function () {
  const data = scenario();
  const offer = data.offers[0];
  const b = offer.blocks.find(function (x) { return x.id === 'B_B'; });
  const t = Model.task(data, 'T_B');
  const st = function (n) { return Fields.status(data, offer, b, t.inputs.find(function (i) { return i.name === n; })).level; };
  assert.equal(st('id'), 'ok');
  assert.equal(st('richiesta.codice'), 'ok');
  assert.equal(st('prodotti'), 'ok');
  assert.equal(st('versione'), 'fixed');
  b.config.inputMapping['richiesta.codice'] = 'esiti.B_INESISTENTE.x';
  assert.equal(st('richiesta.codice'), 'error');
  b.config.inputMapping['richiesta.codice'] = 'esiti.B_A.dati.altro';
  assert.equal(st('richiesta.codice'), 'warn');
  // un blocco che non è ancora stato eseguito non può essere letto
  const a = offer.blocks.find(function (x) { return x.id === 'B_A'; });
  a.config.inputMapping.cf = 'esiti.B_B.x';
  assert.equal(Fields.status(data, offer, a, Model.task(data, 'T_A').inputs[0]).level, 'error');
});

test('autoMap: solo corrispondenze univoche per nome', function () {
  const data = scenario();
  const offer = data.offers[0];
  const b = offer.blocks.find(function (x) { return x.id === 'B_B'; });
  b.config.inputMapping = {};
  const done = Fields.autoMap(data, offer, b, Model.task(data, 'T_B'));
  assert.deepEqual(clone(done), ['id', 'richiesta.codice']);
  assert.equal(b.config.inputMapping.id, 'pratica.id');
  assert.equal(b.config.inputMapping['richiesta.codice'], 'esiti.B_A.dati.codice');
});

test('DSL: body annidato, output per prodotto, sorgenti di sistema, query GET e schema di input', function () {
  const data = scenario();
  const offer = data.offers[0];
  const main = Exporters.buildServerless(ctx.ExecutionPlan.build(data, offer)).main;
  const yaml = Exporters.toYaml(main);
  const text = JSON.stringify(main);
  // il consumatore "per offerta" legge la lista dei risultati del produttore "per prodotto"
  assert.ok(text.includes('esitiByProduct[\\"B_A\\"]') || text.includes('esitiByProduct["B_A"]'), 'lettura esitiByProduct');
  // il produttore per prodotto salva l'esito anche per prodotto
  assert.ok(text.includes('($product): $output'));
  // sorgente di sistema e valore fisso come stringa letterale
  assert.ok(text.includes('activeProducts'));
  assert.ok(yaml.includes('v1.2'));
  // percorso GET con segmento {id} sostituito e query con gli input non usati nel path
  const getCall = findCall(main, 'b');
  assert.ok(getCall.with.endpoint.uri.includes('| @uri'));
  assert.ok(getCall.with.query.products);
  assert.ok(!('id' in getCall.with.query));
  assert.ok('versione' in getCall.with.query);
  // output annidato letto con path jq corretto, body nidificato per gli input con il punto
  const postBody = findCall(main, 'a').with.body;
  assert.ok(postBody.cf);
  // schema dell'input dal modello della pratica, con pratica.id obbligatorio
  const schema = main.input.schema.document;
  assert.ok(schema.properties.pratica.properties.id);
  assert.ok(schema.required.includes('pratica'));
  assert.ok(schema.properties.cliente.properties.codiceFiscale);
});

function findCall(node, key) {
  let found = null;
  (function walk(n) {
    if (!n || typeof n !== 'object' || found) return;
    if (n.call === 'http' && n.with && (n.with.endpoint.uri + '').indexOf('/' + key) >= 0) { found = n; return; }
    Object.keys(n).forEach(function (k) { walk(n[k]); });
  })(node);
  return found;
}
