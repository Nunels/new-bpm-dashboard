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
  /*
   * Liste: un segmento `nome[]` indica una lista di oggetti (o di valori). `spedizioni[].destinatario.cap` è il campo
   * `destinatario.cap` di ogni elemento di `spedizioni`. Nei percorsi di lettura `x[]` = tutti gli elementi (proiezione),
   * `x[@]` = l'elemento del prodotto corrente (liste risultati per prodotto). Nelle mappature dentro una lista
   * `@.campo` = campo dell'elemento corrente e `prodotti.{prodotto}.campo` = dato del prodotto corrente.
   */
  const PATH_RE = /^[A-Za-z_]\w*(?:\[\])?(?:\.\w+(?:\[\])?)*$/;
  const RESULT_RE = /^esiti\.([A-Za-z0-9_]+)\.([A-Za-z_]\w*(?:\[@?\])?(?:\.\w+(?:\[@?\])?)*)$/;
  const ITEM_RE = /^@(?:\.[A-Za-z_]\w*(?:\[\])?)*$/;
  const PRODUCT_PATH_RE = /^[A-Za-z_]\w*(?:\.(?:\w+|\{prodotto\}))*$/;

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  /* Percorso senza i segni di lista: per confrontare `a[].b` con `a.b` senza distinguere la forma. */
  function plain(p) { return String(p || '').replace(/\[@?\]/g, ''); }
  function isListRow(name) { return /\[\]$/.test(String(name || '')); }
  function hasList(name) { return /\[@?\]/.test(String(name || '')); }
  /* Lista che contiene il campo (`a[].b[].c` → `a[].b[]`); per la riga di una lista, la lista che la contiene. */
  function parentList(name) {
    const base = isListRow(name) ? String(name).slice(0, -2) : String(name || '');
    const p = base.lastIndexOf('[]');
    return p < 0 ? null : base.slice(0, p + 2);
  }

  /* ---------- classificazione di una sorgente ---------- */
  function rootsOf(fields) {
    const r = [];
    (fields || []).forEach(function (f) { const k = String(f.name || '').split('.')[0].replace(/\[\]$/, ''); if (k && r.indexOf(k) < 0) r.push(k); });
    return r;
  }

  /*
   * Sorgente di un input: risultato di un altro blocco (esiti.<blocco>.<campo>), sorgente di sistema, campo dell'elemento
   * di una lista (@.campo), dato del prodotto corrente (prodotti.{prodotto}.campo), percorso nei dati della pratica
   * (a.b.c, anche con liste a[].b) o valore fisso. Se il modello della pratica ha dei campi, è un percorso solo se parte
   * da una sua radice: così un valore fisso come "v1.2" non viene scambiato per un percorso.
   */
  function classify(src, roots) {
    if (src == null || String(src).trim() === '') return { kind: 'none' };
    const s = String(src).trim();
    const m = RESULT_RE.exec(s);
    if (m) return { kind: 'result', ref: m[1], field: m[2], path: s };
    if (SYSTEM[s]) return { kind: 'system', path: s };
    if (ITEM_RE.test(s)) return { kind: 'item', path: s === '@' ? '' : s.slice(2), raw: s };
    if (s.indexOf('{prodotto}') >= 0 && PRODUCT_PATH_RE.test(s)) return { kind: 'productPath', path: s };
    if (PATH_RE.test(s) && (s.indexOf('.') >= 0 || s.indexOf('[]') >= 0) && (!roots || !roots.length || roots.indexOf(s.split('.')[0].replace(/\[\]$/, '')) >= 0)) return { kind: 'path', path: s };
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
      const items = p.type === 'array' ? resolveRef(root, p.items, 0) : null;
      if (p.properties && Object.keys(p.properties).length) flattenSchema(root, p, path, out, depth + 1);
      else if (items && items.properties && Object.keys(items.properties).length) flattenSchema(root, items, path + '[]', out, depth + 1);
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

  function isPlainObject(x) { return x && typeof x === 'object' && !Array.isArray(x); }

  /* Campi di un esempio. Un array di oggetti diventa `nome[].campo` (unione dei campi di tutti gli elementi); un array di valori resta un campo `array`. */
  function fromSample(value) {
    const out = [];
    const add = function (f) {
      const cur = out.find(function (x) { return x.name === f.name; });
      if (!cur) out.push(f);
      else if (cur.type === 'string' && f.type !== 'string') cur.type = f.type;
    };
    (function walk(v, prefix, depth) {
      if (!isPlainObject(v) || depth > 8) return;
      Object.keys(v).forEach(function (k) {
        const path = prefix ? prefix + '.' + k : k;
        const x = v[k];
        if (isPlainObject(x) && Object.keys(x).length) walk(x, path, depth + 1);
        else if (Array.isArray(x) && x.some(isPlainObject)) x.filter(isPlainObject).forEach(function (el) { walk(el, path + '[]', depth + 1); });
        else add({ name: path, type: sampleType(x), required: false, description: '' });
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

  /* JSON Schema ad albero dei campi (per l'input del workflow). Un campo obbligatorio rende obbligatori i suoi antenati; `a[].b` diventa un array con `items`. */
  function toSchema(fields) {
    const root = { type: 'object', properties: {} };
    (fields || []).forEach(function (f) {
      const segs = String(f.name || '').split('.').filter(Boolean);
      if (!segs.length) return;
      let node = root;
      segs.forEach(function (raw, i) {
        const last = i === segs.length - 1;
        const list = /\[\]$/.test(raw);
        const seg = list ? raw.slice(0, -2) : raw;
        if (f.required) { node.required = node.required || []; if (node.required.indexOf(seg) < 0) node.required.push(seg); }
        if (last) {
          const leaf = typeSchema(f);
          node.properties[seg] = Object.assign(node.properties[seg] || {}, list ? { type: 'array', items: leaf } : leaf);
          return;
        }
        let c = node.properties[seg];
        if (list) {
          c = node.properties[seg] = c && c.items ? c : { type: 'array', items: { type: 'object', properties: {} } };
          c = c.items;
        } else c = node.properties[seg] = c || { type: 'object', properties: {} };
        if (!c.properties) c.properties = {};
        node = c;
      });
    });
    return root;
  }

  /* Percorso nella pratica di un campo `rel` dell'elemento della lista `listKey` di un task (risale le liste annidate); null se l'origine non è nella pratica. */
  function practiceItemPath(task, listKey, rel) {
    const row = (task.inputs || []).find(function (x) { return x.name === listKey; });
    if (!row) return null;
    const c = classify(row.source, null);
    if (c.kind === 'path') return c.path + '.' + rel;
    if (c.kind === 'item') {
      const up = parentList(listKey);
      return up ? practiceItemPath(task, up, (c.path ? c.path + '.' : '') + rel) : null;
    }
    return null;
  }

  /* Modello della pratica ricavato dai percorsi usati dai task (per i dati salvati prima dell'introduzione del modello). */
  function inferPractice(tasks) {
    const fields = [{ name: 'pratica.id', type: 'string', required: true, description: 'Identificativo della pratica' }];
    const add = function (name, required) { if (name && !fields.some(function (f) { return f.name === name; })) fields.push({ name: name, type: 'string', required: !!required, description: '' }); };
    (tasks || []).forEach(function (t) {
      (t.inputs || []).forEach(function (i) {
        const c = classify(i.source, null);
        if (isListRow(i.name)) {
          // lista senza campi nell'input: resta un campo unico della pratica
          if (c.kind === 'path' && !(t.inputs || []).some(function (x) { return x.name.indexOf(i.name + '.') === 0; })) add(c.path.replace(/\[\]$/, ''), i.required);
          return;
        }
        if (c.kind === 'path') add(c.path, i.required);
        else if (c.kind === 'item' && parentList(i.name)) add(practiceItemPath(t, parentList(i.name), c.path), i.required);
      });
    });
    return { fields: fields };
  }

  /* ---------- percorsi ---------- */
  function pathExists(fields, path) {
    const p = plain(path);
    return fields.some(function (f) { const n = plain(f.name); return n === p || n.indexOf(p + '.') === 0 || p.indexOf(n + '.') === 0; });
  }

  function outputExists(task, field) {
    const outs = (task && task.outputs) || [];
    if (!outs.length) return true;
    const p = plain(field);
    return outs.some(function (o) { const n = plain(o.name); return n === p || n.indexOf(p + '.') === 0 || p.indexOf(n + '.') === 0; });
  }

  /*
   * Legge un valore da un oggetto annidato seguendo il nome con i punti. `x[]` proietta tutti gli elementi (lista dei valori,
   * appiattita se ci sono più liste), `x[@]` prende un elemento (`pick(lista)`, di default il primo). undefined se manca un tratto.
   */
  function getPath(obj, name, pick) {
    const segs = String(name).split('.');
    const walk = function (cur, i) {
      if (i === segs.length) return cur;
      const m = /^(.*?)\[(@?)\]$/.exec(segs[i]);
      const key = m ? m[1] : segs[i];
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
      const v = cur[key];
      if (!m) return walk(v, i + 1);
      if (!Array.isArray(v)) return undefined;
      if (m[2]) return walk(pick ? pick(v) : v[0], i + 1);
      if (i + 1 === segs.length) return v.slice();
      const nested = segs.slice(i + 1).some(function (x) { return /\[@?\]$/.test(x); });
      const parts = v.map(function (el) { return walk(el, i + 1); });
      return nested ? [].concat.apply([], parts.map(function (r) { return Array.isArray(r) ? r : []; })) : parts.filter(function (r) { return r !== undefined; });
    };
    return walk(obj, 0);
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

  /* Task che produce un blocco (per leggere le dichiarazioni del catalogo, es. lista risultati per prodotto). */
  function taskOf(data, block) { return block ? data.tasks.find(function (t) { return t.id === block.taskId; }) : null; }

  /*
   * Contesto di un input dentro le liste del blocco: le liste che lo contengono (dalla più esterna) con la loro origine,
   * e come si ottiene "il prodotto corrente": 'list' = dentro una lista con un elemento per prodotto, 'block' = blocco
   * "1 chiamata per prodotto", null = nessuno.
   */
  function scopeOf(block, name, roots) {
    const mapping = (block.config && block.config.inputMapping) || {};
    const chain = [];
    for (let k = parentList(name); k; k = parentList(k)) chain.unshift({ key: k, c: classify(mapping[k], roots) });
    const inProducts = chain.some(function (x) { return x.c.kind === 'system' && x.c.path === 'offerta.prodotti'; });
    const perProduct = block.config && block.config.callMode !== 'perOffer';
    return { chain: chain, prod: inProducts ? 'list' : (perProduct ? 'block' : null) };
  }

  /* Stato di una mappatura: { level: 'none'|'ok'|'fixed'|'warn'|'error', kind, msg }. */
  function status(data, offer, block, input, ctx) {
    ctx = ctx || {};
    const practice = (data.practice && data.practice.fields) || [];
    const roots = rootsOf(practice);
    const c = classify((block.config.inputMapping || {})[input.name], roots);
    const scope = scopeOf(block, input.name, roots);
    const asList = isListRow(input.name);
    const bad = input.required ? 'error' : 'warn';
    if (c.kind === 'none') return { level: 'none', kind: c.kind, msg: asList ? 'lista senza origine (da dove si prendono gli elementi?)' : (input.required ? 'obbligatorio senza sorgente/valore' : 'non mappato') };
    if (asList) {
      if (c.kind === 'literal') return { level: 'error', kind: c.kind, msg: 'serve una lista: indica offerta.prodotti, un campo lista (es. pratica.spedizioni[]) o @.campo[]' };
      if (c.kind === 'productPath') return { level: 'error', kind: c.kind, msg: 'prodotti.{prodotto}… dà un singolo dato, non una lista' };
      if (c.kind === 'system') {
        if (c.path !== 'offerta.prodotti') return { level: 'error', kind: c.kind, msg: 'prodotto.id non è una lista' };
        if (scope.chain.length) return { level: 'error', kind: c.kind, msg: 'offerta.prodotti è ammesso solo nella lista più esterna' };
        return { level: 'ok', kind: c.kind, msg: 'un elemento per ogni prodotto del blocco' };
      }
      if (c.kind === 'item') {
        if (!scope.chain.length) return { level: 'error', kind: c.kind, msg: '@ si usa solo dentro un\'altra lista' };
        if (!isListRow(c.raw)) return { level: 'warn', kind: c.kind, msg: 'non indica una lista (manca [] finale)' };
      } else if (!isListRow(c.kind === 'result' ? c.field : c.path)) return { level: 'warn', kind: c.kind, msg: 'non indica una lista (manca [] finale)' };
    }
    if (c.kind === 'literal') return { level: 'fixed', kind: c.kind, msg: 'valore fisso' };
    if (c.kind === 'system') {
      if (c.path === 'prodotto.id' && !scope.prod) return { level: 'warn', kind: c.kind, msg: 'fuori da un blocco "1 chiamata per prodotto" o da una lista di prodotti vale null' };
      return { level: 'ok', kind: c.kind, msg: SYSTEM[c.path].label };
    }
    if (c.kind === 'item') {
      const parent = scope.chain[scope.chain.length - 1];
      if (!parent) return { level: 'error', kind: c.kind, msg: '@ si usa solo dentro una lista' };
      if (parent.c.kind === 'system') return { level: 'error', kind: c.kind, msg: 'gli elementi sono prodotti: usa prodotto.id o prodotti.{prodotto}.campo' };
      return { level: 'ok', kind: c.kind, msg: 'campo dell\'elemento della lista ' + parent.key };
    }
    if (c.kind === 'productPath') {
      if (!scope.prod) return { level: 'error', kind: c.kind, msg: '{prodotto} si usa dentro una lista di prodotti o in un blocco "1 chiamata per prodotto"' };
      if (practice.length) {
        const segs = c.path.split('.');
        const found = practice.some(function (f) { const fs = plain(f.name).split('.'); return fs.length >= segs.length && segs.every(function (s, k) { return s === '{prodotto}' || s === fs[k]; }); });
        if (!found) return { level: 'warn', kind: c.kind, msg: 'dato del prodotto non presente nel modello della pratica' };
      }
      return { level: 'ok', kind: c.kind, msg: 'dato del prodotto corrente' };
    }
    if (c.kind === 'path') {
      if (practice.length && !pathExists(practice, c.path)) return { level: 'warn', kind: c.kind, msg: 'campo "' + c.path + '" non presente nel modello della pratica' };
      if (!asList && hasList(c.path) && !scope.chain.length && input.type && input.type !== 'array') return { level: 'warn', kind: c.kind, msg: 'un percorso con [] dà una lista, ma il campo è ' + input.type };
      return { level: 'ok', kind: c.kind, msg: hasList(c.path) ? 'lista dalla pratica' : 'dalla pratica' };
    }
    // risultato di un altro blocco: se l'input è facoltativo un riferimento non risolto è solo un avviso
    const producer = resolveBlock(offer, c.ref);
    if (!producer) return { level: bad, kind: c.kind, msg: 'il blocco "' + c.ref + '" non è nell\'offerta' };
    if (producer.id === block.id) return { level: 'error', kind: c.kind, msg: 'un blocco non può leggere il proprio output' };
    const before = ctx.producers || producersFor(data, offer, block);
    if (!before.some(function (b) { return b.id === producer.id; })) return { level: bad, kind: c.kind, msg: 'il blocco "' + producer.id + '" non è eseguito prima di questo (serve uno step precedente o la dipendenza "Esegui dopo")' };
    const pt = taskOf(data, producer);
    if (/\[@\]/.test(c.field)) {
      if (!pt || !pt.productResults) return { level: 'error', kind: c.kind, msg: '[@] richiede che il task ' + producer.taskId + ' dichiari la lista risultati per prodotto (catalogo)' };
      if (!scope.prod) return { level: 'error', kind: c.kind, msg: '[@] si usa in un blocco "1 chiamata per prodotto" o dentro una lista di prodotti' };
      if (c.field.split('[@]')[0] !== pt.productResults.list) return { level: 'error', kind: c.kind, msg: '[@] vale solo sulla lista ' + pt.productResults.list + '[]' };
    }
    if (!outputExists(pt, c.field)) return { level: 'warn', kind: c.kind, msg: 'l\'output "' + c.field + '" non è definito nel task ' + producer.taskId };
    if (hasList(c.field) && isPerProductBlock(producer)) return { level: 'warn', kind: c.kind, msg: 'il blocco ' + producer.id + ' gira per prodotto: della lista si legge l\'ultima chiamata' };
    return { level: 'ok', kind: c.kind, msg: 'output del blocco ' + producer.id };
  }

  function isPerProductBlock(block) { return !!block && !!block.config && block.config.callMode !== 'perOffer'; }

  /* Liste dichiarate negli input/output di un task: `a[]`, `a[].b[]`, … */
  function listKeys(fields) {
    const out = [];
    (fields || []).forEach(function (f) {
      const name = String(f.name || '');
      let p = 0;
      for (let i = name.indexOf('[]', p); i >= 0; i = name.indexOf('[]', p)) {
        const k = name.slice(0, i + 2);
        if (out.indexOf(k) < 0) out.push(k);
        p = i + 2;
      }
    });
    return out;
  }

  /* Sorgenti proponibili per un blocco: pratica, liste, output dei blocchi già eseguiti, sorgenti di sistema; per un input dentro una lista anche i campi dell'elemento. */
  function sources(data, offer, block, input) {
    const fields = (data.practice && data.practice.fields) || [];
    const practice = fields.map(function (f) { return { path: f.name, type: f.type, label: f.description || '' }; });
    const lists = listKeys(fields).map(function (k) { return { path: k, type: 'array', label: 'lista della pratica' }; });
    const results = [];
    producersFor(data, offer, block).forEach(function (p) {
      const t = data.tasks.find(function (x) { return x.id === p.taskId; });
      ((t && t.outputs) || []).forEach(function (o) { results.push({ path: 'esiti.' + p.id + '.' + o.name, type: o.type || 'string', label: (t ? t.name : p.taskId) + (o.description ? ' · ' + o.description : '') }); });
      listKeys((t && t.outputs) || []).forEach(function (k) { lists.push({ path: 'esiti.' + p.id + '.' + k, type: 'array', label: 'lista di ' + (t ? t.name : p.taskId) }); });
      if (t && t.productResults) {
        ((t.outputs) || []).filter(function (o) { return o.name.indexOf(t.productResults.list + '[].') === 0; }).forEach(function (o) {
          results.push({ path: 'esiti.' + p.id + '.' + t.productResults.list + '[@].' + o.name.slice(t.productResults.list.length + 3), type: o.type || 'string', label: (t.name) + ' · elemento del prodotto corrente' });
        });
      }
    });
    const system = Object.keys(SYSTEM).map(function (k) { return { path: k, type: SYSTEM[k].type, label: SYSTEM[k].label }; });
    const out = { practice: practice, lists: lists, results: results, system: system, items: [], perProduct: [] };
    if (input && hasList(input.name)) {
      const roots = rootsOf(fields);
      const scope = scopeOf(block, input.name, roots);
      const parent = scope.chain[scope.chain.length - 1];
      if (parent && parent.c.kind === 'path') {
        const base = parent.c.path;
        practice.forEach(function (s) {
          if (s.path.indexOf(base + '.') === 0) out.items.push({ path: '@.' + s.path.slice(base.length + 1), type: s.type, label: s.label });
        });
      } else if (parent && parent.c.kind === 'result') {
        const pb = resolveBlock(offer, parent.c.ref);
        const pt = taskOf(data, pb);
        const prefix = parent.c.field.replace(/\[@?\]$/, '[]');
        ((pt && pt.outputs) || []).filter(function (o) { return o.name.indexOf(prefix + '.') === 0; }).forEach(function (o) {
          out.items.push({ path: '@.' + o.name.slice(prefix.length + 1), type: o.type || 'string', label: pt.name });
        });
      }
      if (scope.prod) {
        fields.forEach(function (f) {
          const segs = f.name.split('.');
          if (segs.length > 2 && data.products.some(function (p) { return p.id === segs[1]; })) out.perProduct.push({ path: segs[0] + '.{prodotto}.' + segs.slice(2).join('.'), type: f.type, label: f.description || 'dato per prodotto' });
        });
      }
    }
    return out;
  }

  /* Mappa gli input vuoti per nome (ultimo segmento): prima i campi della pratica, poi gli output dei blocchi precedenti. Solo se univoco. */
  function autoMap(data, offer, block, task) {
    const last = function (p) { return plain(p).split('.').pop().toLowerCase(); };
    const mapped = [];
    (task.inputs || []).forEach(function (i) {
      if (isListRow(i.name) || String(block.config.inputMapping[i.name] || '').trim()) return;
      const src = sources(data, offer, block, i);
      const key = last(i.name);
      let found;
      if (hasList(i.name)) {
        found = src.items.filter(function (s) { return last(s.path) === key; });
      } else {
        found = src.practice.filter(function (s) { return !hasList(s.path) && last(s.path) === key; });
        if (found.length !== 1) found = src.results.filter(function (s) { return !hasList(s.path) && last(s.path) === key; });
      }
      if (found.length === 1) { block.config.inputMapping[i.name] = found[0].path; mapped.push(i.name); }
    });
    return mapped;
  }

  /* Struttura del body della request così come la costruisce il DSL: ogni foglia mostra la sorgente mappata (anteprima nel pannello del blocco). */
  function bodyShape(task, mapping) {
    const root = {};
    const inputs = task.inputs || [];
    inputs.forEach(function (i) {
      const src = String((mapping || {})[i.name] || '').trim() || '(non mappato)';
      if (isListRow(i.name)) {
        if (!inputs.some(function (x) { return x.name.indexOf(i.name + '.') === 0; })) setPath(root, i.name.slice(0, -2), '[ ' + src + ' ]');
        return;
      }
      setPath(root, i.name, src);
    });
    return root;
  }

  /*
   * Imposta un valore dentro un oggetto annidato seguendo il nome con i punti (per il body delle chiamate e per i dati degli scenari).
   * `x[]` crea una lista con un elemento d'esempio.
   */
  function setPath(obj, name, value) {
    const segs = String(name).split('.');
    let n = obj;
    segs.forEach(function (raw, i) {
      const list = /\[@?\]$/.test(raw);
      const s = list ? raw.replace(/\[@?\]$/, '') : raw;
      const last = i === segs.length - 1;
      if (list) {
        if (!Array.isArray(n[s])) n[s] = [];
        if (last) { if (!n[s].length) n[s].push(value); return; }
        if (!n[s].length || !n[s][0] || typeof n[s][0] !== 'object') n[s][0] = {};
        n = n[s][0];
        return;
      }
      if (last) { n[s] = value; return; }
      if (!n[s] || typeof n[s] !== 'object' || Array.isArray(n[s])) n[s] = {};
      n = n[s];
    });
    return obj;
  }

  global.Fields = {
    TYPES: TYPES, SYSTEM: SYSTEM, clone: clone, rootsOf: rootsOf, classify: classify, parse: parse, fromSchema: fromSchema, fromSample: fromSample,
    toSchema: toSchema, inferPractice: inferPractice, pathExists: pathExists, resolveBlock: resolveBlock, producersFor: producersFor,
    status: status, sources: sources, autoMap: autoMap, setPath: setPath, getPath: getPath,
    plain: plain, isListRow: isListRow, hasList: hasList, parentList: parentList, listKeys: listKeys, scopeOf: scopeOf, bodyShape: bodyShape, taskOf: taskOf
  };
})(typeof window !== 'undefined' ? window : globalThis);
