/*
 * Campi di input/output dei task e modello dati della pratica.
 *
 * Un campo è { name: 'cliente.documento.numero', type, required, description }: il nome con i punti descrive la
 * struttura ad albero, quindi anche API con 100 campi restano una lista piatta, filtrabile e importabile da JSON Schema
 * o da un JSON di esempio. Questo modulo è condiviso da dashboard, exporter e backend (GraalJS).
 */
(function (global) {
  const TYPES = ['string', 'number', 'integer', 'boolean', 'date', 'array', 'object'];
  /* Sorgenti di sistema, sempre disponibili: i prodotti dell'attività e, nei blocchi "per prodotto", il prodotto corrente. */
  const SYSTEM = {
    'offerta.prodotti': { label: 'Prodotti su cui gira il blocco', type: 'array' },
    'prodotto.id': { label: 'Prodotto corrente (solo blocchi 1 chiamata per prodotto)', type: 'string' }
  };
  const PATH_RE = /^[A-Za-z_]\w*(\.\w+)+$/;
  const RESULT_RE = /^esiti\.([A-Za-z0-9_]+)\.([A-Za-z_]\w*(?:\.\w+)*)$/;

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /* ---------- classificazione di una sorgente ---------- */
  function rootsOf(fields) {
    const r = [];
    (fields || []).forEach(function (f) { const k = String(f.name || '').split('.')[0]; if (k && r.indexOf(k) < 0) r.push(k); });
    return r;
  }

  /*
   * Sorgente di un input: risultato di un altro blocco (esiti.<blocco>.<campo>), sorgente di sistema, percorso nei dati
   * della pratica (a.b.c) o valore fisso. Se il modello della pratica ha dei campi, è un percorso solo se parte da una
   * sua radice: così un valore fisso come "v1.2" non viene scambiato per un percorso.
   */
  function classify(src, roots) {
    if (src == null || String(src).trim() === '') return { kind: 'none' };
    const s = String(src).trim();
    const m = RESULT_RE.exec(s);
    if (m) return { kind: 'result', ref: m[1], field: m[2], path: s };
    if (SYSTEM[s]) return { kind: 'system', path: s };
    if (PATH_RE.test(s) && (!roots || !roots.length || roots.indexOf(s.split('.')[0]) >= 0)) return { kind: 'path', path: s };
    return { kind: 'literal', value: s };
  }

  /* ---------- import / export ---------- */
  function mapType(p) {
    const t = Array.isArray(p.type) ? p.type.filter(function (x) { return x !== 'null'; })[0] : p.type;
    if (t === 'string' && (p.format === 'date' || p.format === 'date-time')) return 'date';
    if (TYPES.indexOf(t) >= 0) return t;
    return p.properties ? 'object' : 'string';
  }

  function resolveRef(root, node, depth) {
    let n = node;
    while (n && n.$ref && depth < 10) {
      const parts = String(n.$ref).replace(/^#\//, '').split('/');
      let cur = root;
      parts.forEach(function (k) { cur = cur && cur[k.replace(/~1/g, '/').replace(/~0/g, '~')]; });
      if (!cur) return n;
      n = cur; depth++;
    }
    return n;
  }

  function flattenSchema(root, node, prefix, out, depth) {
    const n = resolveRef(root, node, 0) || {};
    if (depth > 8) return;
    const props = n.properties;
    if (!props) return;
    const req = Array.isArray(n.required) ? n.required : [];
    Object.keys(props).forEach(function (k) {
      const p = resolveRef(root, props[k], 0) || {};
      const path = prefix ? prefix + '.' + k : k;
      if (p.properties && Object.keys(p.properties).length) flattenSchema(root, p, path, out, depth + 1);
      else out.push({ name: path, type: mapType(p), required: req.indexOf(k) >= 0, description: p.description || '' });
    });
  }

  function fromSchema(schema) {
    const out = [];
    flattenSchema(schema, schema, '', out, 0);
    return out;
  }

  function sampleType(v) {
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v)) return 'date';
    return 'string';
  }

  function fromSample(value) {
    const out = [];
    (function walk(v, prefix, depth) {
      if (!v || typeof v !== 'object' || Array.isArray(v) || depth > 8) return;
      Object.keys(v).forEach(function (k) {
        const path = prefix ? prefix + '.' + k : k;
        const x = v[k];
        if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length) walk(x, path, depth + 1);
        else out.push({ name: path, type: sampleType(x), required: false, description: '' });
      });
    })(value, '', 0);
    return out;
  }

  /* Testo incollato: JSON Schema (anche con $ref locali) oppure JSON di esempio. Esito { fields } o { error }. */
  function parse(text) {
    let doc;
    try { doc = JSON.parse(text); } catch (e) { return { error: 'JSON non valido: ' + e.message }; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'Serve un oggetto JSON (JSON Schema o esempio).' };
    if (doc.openapi || doc.swagger) return { error: 'È un documento OpenAPI: incolla lo schema del body (per esempio components.schemas.NomeRichiesta), non l\'intero documento.' };
    const isSchema = !!(doc.$schema || doc.properties || doc.$ref || (doc.type === 'object' && doc.properties));
    const fields = isSchema ? fromSchema(doc) : fromSample(doc);
    if (!fields.length) return { error: 'Nessun campo trovato: lo schema non ha "properties" oppure l\'esempio è vuoto.' };
    return { fields: fields, kind: isSchema ? 'JSON Schema' : 'JSON di esempio' };
  }

  function typeSchema(f) {
    const s = f.type === 'date' ? { type: 'string', format: 'date' } : { type: TYPES.indexOf(f.type) >= 0 ? f.type : 'string' };
    if (f.description) s.description = f.description;
    return s;
  }

  /* JSON Schema ad albero dei campi (per l'input del workflow). Un campo obbligatorio rende obbligatori i suoi antenati. */
  function toSchema(fields) {
    const root = { type: 'object', properties: {} };
    (fields || []).forEach(function (f) {
      const segs = String(f.name || '').split('.').filter(Boolean);
      if (!segs.length) return;
      let node = root;
      segs.forEach(function (seg, i) {
        const last = i === segs.length - 1;
        if (f.required) { node.required = node.required || []; if (node.required.indexOf(seg) < 0) node.required.push(seg); }
        if (last) { node.properties[seg] = Object.assign(node.properties[seg] || {}, typeSchema(f)); return; }
        const c = node.properties[seg] = node.properties[seg] || { type: 'object', properties: {} };
        if (!c.properties) c.properties = {};
        node = c;
      });
    });
    return root;
  }

  /* Modello della pratica ricavato dai percorsi usati dai task (per i dati salvati prima dell'introduzione del modello). */
  function inferPractice(tasks) {
    const fields = [{ name: 'pratica.id', type: 'string', required: true, description: 'Identificativo della pratica' }];
    (tasks || []).forEach(function (t) {
      (t.inputs || []).forEach(function (i) {
        const c = classify(i.source, null);
        if (c.kind === 'path' && !fields.some(function (f) { return f.name === c.path; })) fields.push({ name: c.path, type: 'string', required: !!i.required, description: '' });
      });
    });
    return { fields: fields };
  }

  /* ---------- percorsi ---------- */
  function pathExists(fields, path) {
    return fields.some(function (f) { return f.name === path || f.name.indexOf(path + '.') === 0 || path.indexOf(f.name + '.') === 0; });
  }

  function outputExists(task, field) {
    const outs = (task && task.outputs) || [];
    if (!outs.length) return true;
    return outs.some(function (o) { return o.name === field || o.name.indexOf(field + '.') === 0 || field.indexOf(o.name + '.') === 0; });
  }

  /* Blocco riferito da esiti.<ref>.<campo>: ref è l'id del blocco oppure l'id del suo task. */
  function resolveBlock(offer, ref) {
    return offer.blocks.find(function (b) { return b.id === ref; }) || offer.blocks.find(function (b) { return b.taskId === ref; }) || null;
  }

  /* Blocchi già eseguiti quando parte `block`: step precedenti e dipendenze (anche indirette) dello stesso step. */
  function producersFor(data, offer, block) {
    const idx = function (id) { return data.steps.findIndex(function (s) { return s.id === id; }); };
    const mine = idx(block.stepId);
    const deps = {};
    (function add(b) {
      (b.dependsOn || []).forEach(function (d) {
        if (deps[d]) return;
        deps[d] = true;
        const x = offer.blocks.find(function (y) { return y.id === d; });
        if (x) add(x);
      });
    })(block);
    return offer.blocks.filter(function (b) {
      return b.id !== block.id && (idx(b.stepId) < mine || (idx(b.stepId) === mine && deps[b.id]));
    });
  }

  /* Stato di una mappatura: { level: 'none'|'ok'|'fixed'|'warn'|'error', kind, msg }. */
  function status(data, offer, block, input, ctx) {
    ctx = ctx || {};
    const practice = (data.practice && data.practice.fields) || [];
    const c = classify((block.config.inputMapping || {})[input.name], rootsOf(practice));
    if (c.kind === 'none') return { level: 'none', kind: c.kind, msg: input.required ? 'obbligatorio senza sorgente/valore' : 'non mappato' };
    if (c.kind === 'literal') return { level: 'fixed', kind: c.kind, msg: 'valore fisso' };
    if (c.kind === 'system') return { level: 'ok', kind: c.kind, msg: SYSTEM[c.path].label };
    if (c.kind === 'path') {
      if (practice.length && !pathExists(practice, c.path)) return { level: 'warn', kind: c.kind, msg: 'campo "' + c.path + '" non presente nel modello della pratica' };
      return { level: 'ok', kind: c.kind, msg: 'dalla pratica' };
    }
    // risultato di un altro blocco: se l'input è facoltativo un riferimento non risolto è solo un avviso
    const bad = input.required ? 'error' : 'warn';
    const producer = resolveBlock(offer, c.ref);
    if (!producer) return { level: bad, kind: c.kind, msg: 'il blocco "' + c.ref + '" non è nell\'offerta' };
    if (producer.id === block.id) return { level: 'error', kind: c.kind, msg: 'un blocco non può leggere il proprio output' };
    const before = ctx.producers || producersFor(data, offer, block);
    if (!before.some(function (b) { return b.id === producer.id; })) return { level: bad, kind: c.kind, msg: 'il blocco "' + producer.id + '" non è eseguito prima di questo (serve uno step precedente o la dipendenza "Esegui dopo")' };
    if (!outputExists(data.tasks.find(function (t) { return t.id === producer.taskId; }), c.field)) return { level: 'warn', kind: c.kind, msg: 'l\'output "' + c.field + '" non è definito nel task ' + producer.taskId };
    return { level: 'ok', kind: c.kind, msg: 'output del blocco ' + producer.id };
  }

  /* Sorgenti proponibili per un blocco: pratica, output dei blocchi già eseguiti, sorgenti di sistema. */
  function sources(data, offer, block) {
    const practice = ((data.practice && data.practice.fields) || []).map(function (f) { return { path: f.name, type: f.type, label: f.description || '' }; });
    const results = [];
    producersFor(data, offer, block).forEach(function (p) {
      const t = data.tasks.find(function (x) { return x.id === p.taskId; });
      ((t && t.outputs) || []).forEach(function (o) { results.push({ path: 'esiti.' + p.id + '.' + o.name, type: o.type || 'string', label: (t ? t.name : p.taskId) + (o.description ? ' · ' + o.description : '') }); });
    });
    const system = Object.keys(SYSTEM).map(function (k) { return { path: k, type: SYSTEM[k].type, label: SYSTEM[k].label }; });
    return { practice: practice, results: results, system: system };
  }

  /* Mappa gli input vuoti per nome (ultimo segmento): prima i campi della pratica, poi gli output dei blocchi precedenti. Solo se univoco. */
  function autoMap(data, offer, block, task) {
    const src = sources(data, offer, block);
    const last = function (p) { return p.split('.').pop().toLowerCase(); };
    const mapped = [];
    (task.inputs || []).forEach(function (i) {
      if (String(block.config.inputMapping[i.name] || '').trim()) return;
      const key = last(i.name);
      let found = src.practice.filter(function (s) { return last(s.path) === key; });
      if (found.length !== 1) found = src.results.filter(function (s) { return last(s.path) === key; });
      if (found.length === 1) { block.config.inputMapping[i.name] = found[0].path; mapped.push(i.name); }
    });
    return mapped;
  }

  /* Imposta un valore dentro un oggetto annidato seguendo il nome con i punti (per il body delle chiamate). */
  function setPath(obj, name, value) {
    const segs = String(name).split('.');
    let n = obj;
    segs.forEach(function (s, i) {
      if (i === segs.length - 1) { n[s] = value; return; }
      if (!n[s] || typeof n[s] !== 'object' || Array.isArray(n[s])) n[s] = {};
      n = n[s];
    });
    return obj;
  }

  global.Fields = {
    TYPES: TYPES, SYSTEM: SYSTEM, clone: clone, rootsOf: rootsOf, classify: classify, parse: parse, fromSchema: fromSchema, fromSample: fromSample,
    toSchema: toSchema, inferPractice: inferPractice, pathExists: pathExists, resolveBlock: resolveBlock, producersFor: producersFor,
    status: status, sources: sources, autoMap: autoMap, setPath: setPath
  };
})(typeof window !== 'undefined' ? window : globalThis);
