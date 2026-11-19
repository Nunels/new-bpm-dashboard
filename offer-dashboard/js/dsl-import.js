/* Import DSL → offerta (Serverless Workflow 1.0 "canonico", cioè prodotto dall'exporter della dashboard).
 *
 * Regola: l'offerta si ricostruisce dai metadata del DSL (document.metadata.offer, metadata.block dei blocchi,
 * metadata.gates delle barre), più due valori letti dal corpo: il titolo (nome dell'offerta) e il retry dei blocchi
 * (try/catch). Poi il DSL viene rigenerato e confrontato con quello scritto: una differenza è accettata solo se
 * l'utente non ha toccato quel punto (è la conseguenza di una modifica ai metadata); altrimenti la modifica non è
 * riportabile in dashboard e l'import viene rifiutato con l'elenco dei punti.
 * Funziona nel browser e in GraalJS (backend): richiede Model, ExecutionPlan, Exporters e, per parse(), jsyaml.
 */
(function (global) {
  const MAX_DIFFS = 8;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function equal(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every(function (x, i) { return equal(x, b[i]); });
    if (isObj(a)) {
      if (!isObj(b)) return false;
      const ka = Object.keys(a), kb = Object.keys(b);
      return ka.length === kb.length && ka.every(function (k) { return Object.prototype.hasOwnProperty.call(b, k) && equal(a[k], b[k]); });
    }
    return false;
  }

  function at(obj, path) {
    let cur = obj;
    for (let i = 0; i < path.length; i++) {
      if (cur === null || typeof cur !== 'object' || !(path[i] in cur)) return undefined;
      cur = cur[path[i]];
    }
    return cur;
  }

  /* Differenze foglia per foglia (array di lunghezza diversa = differenza sull'array intero). */
  function diff(given, expected, path, out) {
    if (equal(given, expected)) return out;
    if (Array.isArray(given) && Array.isArray(expected) && given.length === expected.length) {
      for (let i = 0; i < given.length; i++) diff(given[i], expected[i], path.concat(i), out);
    } else if (isObj(given) && isObj(expected)) {
      const keys = {};
      Object.keys(given).concat(Object.keys(expected)).forEach(function (k) { keys[k] = true; });
      Object.keys(keys).forEach(function (k) { diff(given[k], expected[k], path.concat(k), out); });
    } else {
      out.push({ path: path, given: given, expected: expected });
    }
    return out;
  }

  function pointer(path) { return '/' + path.join('/'); }
  function show(v) { return v === undefined ? '(assente)' : JSON.stringify(v); }

  function parse(text) {
    if (!global.jsyaml) throw new Error('parser YAML non disponibile (jsyaml)');
    try {
      const doc = global.jsyaml.load(text);
      if (!isObj(doc)) return { error: 'Il DSL deve essere un documento YAML con document e do.' };
      return { doc: doc };
    } catch (e) {
      return { error: 'YAML non valido' + (e.mark ? ' (riga ' + (e.mark.line + 1) + ', colonna ' + (e.mark.column + 1) + ')' : '') + ': ' + (e.reason || e.message) };
    }
  }

  /* Visita tutti i task (anche annidati in do, try, for, fork) con il loro percorso. */
  function walk(list, path, visit) {
    if (!Array.isArray(list)) return;
    list.forEach(function (item, i) {
      if (!isObj(item)) return;
      Object.keys(item).forEach(function (name) {
        const task = item[name];
        if (!isObj(task)) return;
        const p = path.concat(i, name);
        visit(name, task, p);
        if (Array.isArray(task.do)) walk(task.do, p.concat('do'), visit);
        if (Array.isArray(task.try)) walk(task.try, p.concat('try'), visit);
        if (isObj(task.fork) && Array.isArray(task.fork.branches)) walk(task.fork.branches, p.concat('fork', 'branches'), visit);
      });
    });
  }

  /* Retry di un blocco letto dal corpo: primo try/catch.retry dentro il task del blocco. */
  function retryOf(task, metaInterval) {
    let found = null;
    walk([{ x: task }], [], function (name, t) {
      if (!found && Array.isArray(t.try) && isObj(t.catch) && isObj(t.catch.retry)) found = t.catch.retry;
    });
    if (!found) return { count: 0, intervalSec: metaInterval };
    const count = Number(at(found, ['limit', 'attempt', 'count'])) || 0;
    const delay = Number(at(found, ['delay', 'seconds']));
    // l'exporter scrive delay = intervalSec || 1: un delay di 1 con intervallo 0 nei metadata resta 0
    const intervalSec = isNaN(delay) ? metaInterval : (delay === 1 && metaInterval === 0 ? 0 : delay);
    return { count: count, intervalSec: intervalSec };
  }

  /* Offerta ricostruita dal DSL (senza confronto). */
  function toOffer(doc) {
    const errors = [];
    const meta = at(doc, ['document', 'metadata']);
    if (!isObj(meta) || meta.generator !== 'offer-process-designer' || meta.format !== 1 || !isObj(meta.offer)) {
      return { errors: ['Il DSL non è nel formato della dashboard: manca document.metadata (generator offer-process-designer, format 1).'] };
    }
    const m = meta.offer;
    const offer = {
      id: m.id, name: at(doc, ['document', 'title']) || m.id, description: m.description || '',
      products: Array.isArray(m.products) ? m.products.slice() : [], blocks: [], gates: []
    };
    if (m.generation) offer.generation = clone(m.generation);
    if (!offer.id) errors.push('document.metadata.offer.id mancante.');
    walk(doc.do, ['do'], function (name, task, path) {
      const md = task.metadata;
      if (!isObj(md)) return;
      if (isObj(md.block)) {
        const b = clone(md.block);
        b.config = b.config || {};
        // blocco non atteso (run): il corpo è nel sotto-workflow, il retry resta quello dei metadata
        if (!isObj(task.run)) b.config.retry = retryOf(task, Number(at(b, ['config', 'retry', 'intervalSec'])) || 0);
        if (offer.blocks.some(function (x) { return x.id === b.id; })) errors.push(pointer(path) + ': blocco ' + b.id + ' duplicato.');
        else offer.blocks.push(b);
      }
      if (Array.isArray(md.gates)) {
        md.gates.forEach(function (g) {
          offer.gates.push({ id: g.id, afterStep: md.afterStep, note: g.note || '', rules: clone(g.rules || []) });
        });
      }
    });
    function order(list, ids) {
      if (!Array.isArray(ids)) return list;
      return list.slice().sort(function (a, b) {
        const ia = ids.indexOf(a.id), ib = ids.indexOf(b.id);
        return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
      });
    }
    offer.blocks = order(offer.blocks, m.blockOrder);
    offer.gates = order(offer.gates, m.gateOrder);
    return { offer: offer, errors: errors };
  }

  /* DSL principale rigenerato dall'offerta (stessa catena della dashboard: piano → exporter). */
  function exportMain(data, offer) {
    const d = { steps: data.steps, products: data.products, tasks: data.tasks, practice: data.practice, offers: [offer] };
    return global.Exporters.buildServerless(global.ExecutionPlan.build(d, offer)).main;
  }

  function normalizedOffer(data, offer) {
    const d = global.Model.normalize({ steps: data.steps, products: clone(data.products), tasks: clone(data.tasks), practice: data.practice && clone(data.practice), offers: [clone(offer)] });
    return d.offers[0];
  }

  /*
   * Applica un DSL (testo YAML o documento già letto). previousOffer = offerta prima della modifica (può mancare).
   * Esito: { ok, offer, errors[], dsl } — dsl = documento rigenerato (forma canonica da mostrare dopo l'import).
   */
  function apply(data, input, previousOffer) {
    let doc = input;
    if (typeof input === 'string') {
      const p = parse(input);
      if (p.error) return { ok: false, errors: [p.error] };
      doc = p.doc;
    }
    const r = toOffer(doc);
    if (r.errors.length) return { ok: false, errors: r.errors };
    const offer = normalizedOffer(data, r.offer);
    let regenerated;
    try {
      regenerated = exportMain(data, offer);
    } catch (e) {
      return { ok: false, errors: ['Impossibile rigenerare il DSL dall\'offerta letta: ' + e.message] };
    }
    const before = previousOffer ? exportMain(data, normalizedOffer(data, previousOffer)) : null;
    const blocking = diff(doc, regenerated, [], []).filter(function (d) {
      // differenza accettata se l'utente non ha toccato quel punto: è la conseguenza di una modifica ai metadata
      return !(before && equal(at(before, d.path), d.given));
    });
    if (blocking.length) {
      const errors = blocking.slice(0, MAX_DIFFS).map(function (d) {
        return 'Modifica non riportabile in dashboard in ' + pointer(d.path) + ': trovato ' + show(d.given) + ', la forma canonica è ' + show(d.expected) + '.';
      });
      if (blocking.length > MAX_DIFFS) errors.push('…e altre ' + (blocking.length - MAX_DIFFS) + ' differenze.');
      errors.push('Nel DSL si possono modificare i metadata (document.metadata.offer, metadata.block, metadata.gates), il titolo e il retry dei blocchi; il resto si cambia dalla dashboard.');
      return { ok: false, errors: errors, offer: offer };
    }
    return { ok: true, offer: offer, errors: [], dsl: regenerated };
  }

  global.DslImport = { parse: parse, toOffer: toOffer, apply: apply, exportMain: exportMain, equal: equal, diff: diff };
})(typeof window !== 'undefined' ? window : globalThis);
