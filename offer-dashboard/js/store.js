/* Persistenza (localStorage), utilità DOM e modello di dominio condiviso tra le due dashboard. */
(function () {
  const KEY = 'offerDashboard.data.v1';

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------------- Util ---------------- */
  function h(tag, props) {
    const el = document.createElement(tag);
    const children = Array.prototype.slice.call(arguments, 2);
    (function append(list) {
      list.forEach(function (c) {
        if (c == null || c === false) return;
        if (Array.isArray(c)) return append(c);
        el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
      });
    })(children);
    // Le props vengono applicate dopo i figli così che "value" delle <select> funzioni.
    if (props) {
      Object.keys(props).forEach(function (k) {
        const v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'draggable') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    return el;
  }

  function toast(msg, kind) {
    let t = document.getElementById('toast');
    if (!t) { t = h('div', { id: 'toast' }); document.body.appendChild(t); }
    const item = h('div', { class: 'toast-item ' + (kind || '') }, msg);
    t.appendChild(item);
    setTimeout(function () { item.remove(); }, 3500);
  }

  function modal(title, content, buttons) {
    closeModal();
    const footer = h('div', { class: 'modal-footer' }, (buttons || []).map(function (b) {
      return h('button', { class: b.class || '', onclick: b.onClick }, b.label);
    }), h('button', { onclick: closeModal }, 'Chiudi'));
    const m = h('div', { class: 'modal-backdrop', id: 'modal', onclick: function (e) { if (e.target.id === 'modal') closeModal(); } },
      h('div', { class: 'modal' },
        h('div', { class: 'modal-header' }, h('h2', null, title), h('button', { class: 'icon', onclick: closeModal, title: 'Chiudi' }, '✕')),
        h('div', { class: 'modal-body' }, content),
        footer));
    document.body.appendChild(m);
    return m;
  }
  function closeModal() { const m = document.getElementById('modal'); if (m) m.remove(); }

  function slug(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'ITEM';
  }
  function uniqueId(base, existing) {
    let id = base, i = 2;
    while (existing.indexOf(id) >= 0) id = base + '_' + (i++);
    return id;
  }
  function uid(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 8).toUpperCase(); }

  window.Util = { h: h, toast: toast, modal: modal, closeModal: closeModal, slug: slug, uniqueId: uniqueId, uid: uid, clone: clone };

  /* ---------------- Model ---------------- */
  const RULE_TYPES = {
    DONT_WAIT: { label: 'Non attendere', short: 'NON ATTENDERE', desc: 'Non attendere l\'esito del blocco indicato: i prodotti proseguono e l\'esito viene gestito in asincrono.', needsBlock: true },
    ONLY_OK: { label: 'Manda solo gli OK', short: 'SOLO OK', desc: 'I prodotti con esito KO escono dall\'offerta, gli OK proseguono.' },
    STOP_ON_KO: { label: 'Ferma tutto se ci sono KO', short: 'STOP SE KO', desc: 'Se almeno un prodotto (eventualmente tra quelli indicati) è KO, l\'intera offerta si ferma.', hasProducts: true },
    CONTINUE_ON_KO: { label: 'Prosegui anche con KO', short: 'PROSEGUI', desc: 'Tutti i prodotti proseguono anche se hanno esito KO.' },
    ROUTE: { label: 'Instrada se…', short: 'INSTRADA', desc: 'Se la condizione è vera la pratica salta a un altro step (anche precedente: ripete lo step, al massimo N volte) oppure si ferma. Si valuta prima delle altre regole del gate; le regole sono provate nell\'ordine.', hasRoute: true }
  };

  /* Instradamento di un gate: iterazioni di default e massime (la history di un workflow Temporal non è illimitata). */
  const MAX_ITERATIONS_DEFAULT = 3;
  const MAX_ITERATIONS_LIMIT = 10;

  const OUTCOMES = {
    OK: 'OK',
    KO: 'KO',
    KO_TASK: 'KO con task manuale'
  };

  const Model = {
    RULE_TYPES: RULE_TYPES,
    MAX_ITERATIONS_DEFAULT: MAX_ITERATIONS_DEFAULT,
    MAX_ITERATIONS_LIMIT: MAX_ITERATIONS_LIMIT,
    OUTCOMES: OUTCOMES,
    task: function (data, id) { return data.tasks.find(function (t) { return t.id === id; }); },
    product: function (data, id) { return data.products.find(function (p) { return p.id === id; }); },
    productName: function (data, id) { const p = Model.product(data, id); return p ? p.name : id + ' (?)'; },
    step: function (data, id) { return data.steps.find(function (s) { return s.id === id; }); },
    stepIndex: function (data, id) { return data.steps.findIndex(function (s) { return s.id === id; }); },
    blocksInStep: function (offer, stepId) { return offer.blocks.filter(function (b) { return b.stepId === stepId; }); },
    gatesAfter: function (offer, stepId) { return offer.gates.filter(function (g) { return g.afterStep === stepId; }); },
    blockLabel: function (data, offer, blockId) {
      const b = offer.blocks.find(function (x) { return x.id === blockId; });
      if (!b) return blockId + ' (?)';
      const t = Model.task(data, b.taskId);
      return (t ? t.name : b.taskId) + ' [' + b.products.map(function (p) { return Model.productName(data, p); }).join(', ') + ']';
    },

    /* Forma canonica dell'offerta (solo i dati di configurazione, in ordine stabile): usata da DSL, import e confronti. */
    canonicalOffer: function (offer) {
      const o = {
        id: offer.id, name: offer.name, description: offer.description || '',
        products: (offer.products || []).slice(),
        blocks: (offer.blocks || []).map(function (b) {
          return { id: b.id, taskId: b.taskId, stepId: b.stepId, products: (b.products || []).slice(), dependsOn: (b.dependsOn || []).slice(), config: clone(b.config || {}) };
        }),
        gates: (offer.gates || []).map(function (g) {
          return { id: g.id, afterStep: g.afterStep, note: g.note || '', rules: clone(g.rules || []) };
        })
      };
      if (offer.generation) o.generation = clone(offer.generation);
      return o;
    },

    defaultBlockConfig: function (task) {
      const d = (task && task.defaults) || {};
      const mapping = {};
      ((task && task.inputs) || []).forEach(function (i) { mapping[i.name] = i.source || ''; });
      return {
        callMode: (task && task.callMode) || 'perOffer',
        inputMapping: mapping,
        retry: clone(d.retry || { count: 0, intervalSec: 0 }),
        onKo: 'MARK_KO',
        koTask: { enabled: !!(task && task.outcomes && task.outcomes.indexOf('KO_TASK') >= 0), queue: d.koQueue || '', slaHours: 24 },
        notify: { onOk: false, onKo: false, template: '' },
        async: { callbackTopic: d.callbackTopic || '', timeoutHours: 48 }
      };
    },

    /* Completa i campi mancanti (es. blocchi seed senza config). */
    normalize: function (data) {
      data.steps = clone(window.SEED.steps);
      data.products = data.products || [];
      data.tasks = data.tasks || [];
      data.offers = data.offers || [];
      // dati salvati prima del modello della pratica: lo ricavo dai percorsi usati dai task
      if (!data.practice || !Array.isArray(data.practice.fields)) data.practice = window.Fields.inferPractice(data.tasks);
      data.tasks.forEach(function (t) {
        t.inputs = t.inputs || []; t.outputs = t.outputs || []; t.outcomes = t.outcomes || ['OK', 'KO'];
        t.inputs.forEach(function (i) { i.type = i.type || 'string'; });
        t.outputs.forEach(function (o) { o.type = o.type || 'string'; });
        t.compatibleProducts = t.compatibleProducts || []; t.allowedSteps = t.allowedSteps || [];
        t.api = t.api || { method: 'POST', path: '' }; t.extensions = t.extensions || { request: false, ko: false };
        t.defaults = t.defaults || {}; t.defaults.retry = t.defaults.retry || { count: 0, intervalSec: 0 };
        // lista dei risultati per prodotto: la risposta contiene una lista con un elemento per prodotto (campo prodotto + campo esito)
        t.productResults = t.productResults && t.productResults.list ? Object.assign({ productField: 'prodotto', outcomeField: 'esito', ok: ['OK'], koTask: [] }, t.productResults) : null;
      });
      data.offers.forEach(function (o) {
        o.products = o.products || []; o.blocks = o.blocks || []; o.gates = o.gates || [];
        o.blocks.forEach(function (b) {
          b.products = b.products || []; b.dependsOn = b.dependsOn || [];
          const def = Model.defaultBlockConfig(Model.task(data, b.taskId));
          const c = b.config || {};
          b.config = Object.assign(def, c, {
            inputMapping: Object.assign(def.inputMapping, c.inputMapping || {}),
            retry: Object.assign(def.retry, c.retry || {}),
            koTask: Object.assign(def.koTask, c.koTask || {}),
            notify: Object.assign(def.notify, c.notify || {}),
            async: Object.assign(def.async, c.async || {})
          });
        });
        o.gates.forEach(function (g) {
          g.rules = g.rules || []; g.note = g.note || '';
          g.rules.forEach(function (r) {
            if (r.type !== 'ROUTE') return;
            r.when = r.when && Array.isArray(r.when.clauses) ? r.when : { join: 'AND', clauses: [] };
            r.when.join = r.when.join === 'OR' ? 'OR' : 'AND';
            r.to = r.to || '';
            if (r.to !== 'STOP') {
              r.maxIterations = Number(r.maxIterations) > 0 ? Math.floor(Number(r.maxIterations)) : MAX_ITERATIONS_DEFAULT;
              r.onExceed = r.onExceed === 'CONTINUE' ? 'CONTINUE' : 'STOP';
            }
          });
        });
      });
      return data;
    },

    /* Raggruppa i blocchi di uno step in livelli (stage) secondo le dipendenze: stesso livello = parallelo. */
    levels: function (blocks) {
      const ids = blocks.map(function (b) { return b.id; });
      const level = {};
      const remaining = blocks.slice();
      let progress = true;
      while (remaining.length && progress) {
        progress = false;
        for (let i = remaining.length - 1; i >= 0; i--) {
          const b = remaining[i];
          const deps = b.dependsOn.filter(function (d) { return ids.indexOf(d) >= 0; });
          if (deps.every(function (d) { return level[d] != null; })) {
            level[b.id] = deps.length ? Math.max.apply(null, deps.map(function (d) { return level[d]; })) + 1 : 0;
            remaining.splice(i, 1);
            progress = true;
          }
        }
      }
      const cycle = remaining.map(function (b) { return b.id; });
      const maxLevel = Math.max.apply(null, [-1].concat(Object.keys(level).map(function (k) { return level[k]; })));
      remaining.forEach(function (b) { level[b.id] = maxLevel + 1; });
      const levels = [];
      blocks.forEach(function (b) { (levels[level[b.id]] = levels[level[b.id]] || []).push(b); });
      return { levels: levels.filter(Boolean), cycle: cycle };
    },

    /*
     * Rami di uno step: le componenti connesse delle dipendenze ("Esegui dopo"). Una componente in cui ogni blocco ha al più un
     * genitore è un albero (kind 'tree': radice + figli annidati); se c'è un join (blocco con più genitori) o un ciclo resta
     * un gruppo a livelli (kind 'levels'), in cui si attende l'intero livello prima del successivo.
     * `idOf` permette di usarla anche sulle attività del piano (id = activityId); i nodi riportano l'elemento originale in `ref`.
     */
    branches: function (items, idOf) {
      idOf = idOf || function (b) { return b.id; };
      const wraps = items.map(function (b) { return { id: idOf(b), ref: b, dependsOn: [] }; });
      const byId = {};
      wraps.forEach(function (w) { byId[w.id] = w; });
      wraps.forEach(function (w) { w.dependsOn = (w.ref.dependsOn || []).filter(function (d) { return byId[d] && d !== w.id; }); });
      const comp = {};
      const find = function (x) { while (comp[x] !== x) { comp[x] = comp[comp[x]]; x = comp[x]; } return x; };
      wraps.forEach(function (w) { comp[w.id] = w.id; });
      wraps.forEach(function (w) { w.dependsOn.forEach(function (d) { comp[find(w.id)] = find(d); }); });
      const groups = [];
      wraps.forEach(function (w) {
        const r = find(w.id);
        let g = groups.find(function (x) { return x.key === r; });
        if (!g) { g = { key: r, wraps: [] }; groups.push(g); }
        g.wraps.push(w);
      });
      return groups.map(function (g) {
        const single = g.wraps.every(function (w) { return w.dependsOn.length <= 1; });
        const roots = g.wraps.filter(function (w) { return !w.dependsOn.length; });
        if (single && roots.length === 1) {
          const node = function (w) { return { ref: w.ref, children: g.wraps.filter(function (c) { return c.dependsOn[0] === w.id; }).map(node) }; };
          return { kind: 'tree', root: node(roots[0]), items: g.wraps.map(function (w) { return w.ref; }) };
        }
        const lv = Model.levels(g.wraps).levels;
        return { kind: 'levels', levels: lv.map(function (l) { return l.map(function (w) { return w.ref; }); }), items: g.wraps.map(function (w) { return w.ref; }) };
      });
    },

  /*
   * Colonne = livelli di esecuzione dello step (sequenza "Esegui dopo"). I blocchi paralleli stanno nella stessa colonna.
   * Corsie: ogni ramo ha la propria; un figlio sta sulla corsia del genitore se è libera, un join (più genitori) si
   * allunga sulle corsie di tutti i suoi genitori quando sono libere nella sua colonna. Dentro una riga prodotto le corsie
   * realmente usate diventano sotto-righe (rankTop/rankBot = posizione di inizio/fine del blocco); se la riga ha una sola
   * corsia il blocco occupa tutta la riga. `laneCount[r]` = corsie usate nella riga prodotto r.
   */
  layoutStep: function (o, stepId) {
    const blocks = Model.blocksInStep(o, stepId);
    const levels = Model.levels(blocks).levels.map(function (l) { return l.slice(); });
    const ids = blocks.map(function (b) { return b.id; });
    const parentsOf = function (b) { return (b.dependsOn || []).filter(function (d) { return ids.indexOf(d) >= 0; }); };
    // dentro un livello i figli seguono l'ordine dei genitori; i join per ultimi, così trovano libere le corsie dei genitori
    for (let li = 1; li < levels.length; li++) {
      const prev = [].concat.apply([], levels.slice(0, li)).map(function (b) { return b.id; });
      const rank = function (b) {
        const ps = parentsOf(b).map(function (d) { return prev.indexOf(d); }).filter(function (i) { return i >= 0; });
        return ps.length ? Math.min.apply(null, ps) : 1e6;
      };
      levels[li] = levels[li].map(function (b, i) { return { b: b, i: i, r: rank(b), j: parentsOf(b).length > 1 ? 1 : 0 }; })
        .sort(function (x, y) { return x.j - y.j || x.r - y.r || x.i - y.i; }).map(function (x) { return x.b; });
    }
    const lane = {};
    const placements = [];
    levels.forEach(function (level, li) {
      const occ = [];
      const free = function (k, rs, re) { return !(occ[k] || []).some(function (r) { return !(re < r[0] || rs > r[1]); }); };
      level.forEach(function (b) {
        const idx = b.products.map(function (p) { return o.products.indexOf(p); }).filter(function (i) { return i >= 0; });
        const rs = idx.length ? Math.min.apply(null, idx) : 0;
        const re = idx.length ? Math.max.apply(null, idx) : 0;
        const ps = parentsOf(b).filter(function (d) { return lane[d]; });
        let k0 = null, k1 = null;
        if (ps.length > 1) {
          const lo = Math.min.apply(null, ps.map(function (d) { return lane[d].k0; })), hi = Math.max.apply(null, ps.map(function (d) { return lane[d].k1; }));
          let ok = true;
          for (let k = lo; k <= hi; k++) if (!free(k, rs, re)) ok = false;
          if (ok) { k0 = lo; k1 = hi; }
        }
        if (k0 === null && ps.length) {
          const pref = Math.min.apply(null, ps.map(function (d) { return lane[d].k0; }));
          if (free(pref, rs, re)) { k0 = pref; k1 = pref; }
        }
        if (k0 === null) { let k = 0; while (!free(k, rs, re)) k++; k0 = k1 = k; }
        for (let k = k0; k <= k1; k++) (occ[k] = occ[k] || []).push([rs, re]);
        lane[b.id] = { k0: k0, k1: k1 };
        placements.push({ block: b, lane: li, rs: rs, re: re, k0: k0, k1: k1 });
      });
    });
    const laneCount = {}, ranks = {};
    for (let r = 0; r < o.products.length; r++) {
      const used = [];
      placements.forEach(function (p) {
        if (r < p.rs || r > p.re) return;
        for (let k = p.k0; k <= p.k1; k++) if (used.indexOf(k) < 0) used.push(k);
      });
      used.sort(function (a, z) { return a - z; });
      laneCount[r] = Math.max(used.length, 1);
      ranks[r] = used;
    }
    placements.forEach(function (p) {
      p.laneCount = laneCount;
      p.rankTop = {}; p.rankBot = {};
      for (let r = p.rs; r <= p.re; r++) {
        p.rankTop[r] = Math.max((ranks[r] || []).indexOf(p.k0), 0);
        p.rankBot[r] = Math.max((ranks[r] || []).indexOf(p.k1), 0);
      }
    });
    return { lanes: Math.max(levels.length, 1), placements: placements, laneCount: laneCount };
  },

    /* Politica effettiva di una transizione, combinando le regole di tutti i gate (in ordine). */
    effectivePolicy: function (gates) {
      const rules = [];
      gates.forEach(function (g) { g.rules.forEach(function (r) { rules.push(r); }); });
      const has = function (t) { return rules.some(function (r) { return r.type === t; }); };
      const dontWait = rules.filter(function (r) { return r.type === 'DONT_WAIT' && r.blockId; }).map(function (r) { return r.blockId; });
      const stopRules = rules.filter(function (r) { return r.type === 'STOP_ON_KO'; });
      const stopScope = stopRules.length ? (stopRules.some(function (r) { return !r.products || !r.products.length; }) ? 'ALL' :
        stopRules.reduce(function (acc, r) { return acc.concat(r.products.filter(function (p) { return acc.indexOf(p) < 0; })); }, [])) : null;
      const explicit = has('ONLY_OK') || has('CONTINUE_ON_KO') || has('STOP_ON_KO');
      const koPolicy = has('ONLY_OK') ? 'ONLY_OK' : (has('CONTINUE_ON_KO') ? 'CONTINUE_ON_KO' : 'ONLY_OK');
      return {
        dontWait: dontWait,
        stopOnKo: stopScope,
        koPolicy: koPolicy,
        explicit: explicit,
        conflict: has('ONLY_OK') && has('CONTINUE_ON_KO')
      };
    },

    /* Regole ROUTE di un gate (tutti i gate della transizione, in ordine). */
    routesAfter: function (offer, stepId) {
      const r = [];
      Model.gatesAfter(offer, stepId).forEach(function (g) { g.rules.forEach(function (x, i) { if (x.type === 'ROUTE') r.push({ gate: g, rule: x, index: i, key: g.id + '-' + i }); }); });
      return r;
    },

    ruleText: function (data, offer, r) {
      const t = RULE_TYPES[r.type];
      if (!t) return r.type;
      if (r.type === 'ROUTE') {
        const dest = r.to === 'STOP' ? 'ferma l\'offerta' : (r.to ? (Model.step(data, r.to) || { name: r.to }).name : '(destinazione?)');
        return 'Se ' + (window.Conditions.describe(data, offer, r.when) || '(condizione?)') + ' → ' + dest + (r.to === 'STOP' ? '' : ' (max ' + r.maxIterations + ' volte)');
      }
      if (r.type === 'DONT_WAIT') return 'Non attendere: ' + (r.blockId ? Model.blockLabel(data, offer, r.blockId) : '(blocco?)');
      if (r.type === 'STOP_ON_KO' && r.products && r.products.length) return 'Ferma tutto se KO su: ' + r.products.map(function (p) { return Model.productName(data, p); }).join(', ');
      return t.label;
    }
  };
  window.Model = Model;

  /* ---------------- Store ---------------- */
  window.Store = {
    load: function () {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const d = JSON.parse(raw);
          if (Store.isValid(d)) return Model.normalize(d);
        }
      } catch (e) { console.warn('Impossibile leggere localStorage', e); }
      return Model.normalize(clone(window.SEED));
    },
    save: function (d) {
      try { localStorage.setItem(KEY, JSON.stringify(d)); }
      catch (e) { toast('Salvataggio non riuscito: ' + e.message, 'error'); }
    },
    reset: function () { localStorage.removeItem(KEY); return Model.normalize(clone(window.SEED)); },
    isValid: function (d) { return !!d && Array.isArray(d.products) && Array.isArray(d.tasks) && Array.isArray(d.offers); },
    download: function (obj, filename) {
      Store.downloadText(JSON.stringify(obj, null, 2), filename, 'application/json');
    },
    downloadText: function (text, filename, mime) {
      const blob = new Blob([text], { type: mime || 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    },
    readFile: function (file) {
      return new Promise(function (resolve, reject) {
        const r = new FileReader();
        r.onload = function () { try { resolve(JSON.parse(r.result)); } catch (e) { reject(e); } };
        r.onerror = reject;
        r.readAsText(file);
      });
    },
    /* Bottoni comuni della topbar: export / import / reset. */
    bindTopbar: function (getData, setData) {
      const exp = document.getElementById('btn-export');
      const imp = document.getElementById('file-import');
      const rst = document.getElementById('btn-reset');
      if (exp) exp.addEventListener('click', function () {
        Store.download(getData(), 'offer-dashboard-config.json');
      });
      if (imp) imp.addEventListener('change', function (e) {
        const f = e.target.files[0];
        if (!f) return;
        Store.readFile(f).then(function (d) {
          if (!Store.isValid(d)) throw new Error('Formato non valido (attesi products, tasks, offers)');
          const nd = Model.normalize(d);
          Store.save(nd);
          setData(nd);
          toast('Configurazione importata', 'ok');
        }).catch(function (err) { toast('Import fallito: ' + err.message, 'error'); });
        e.target.value = '';
      });
      if (rst) rst.addEventListener('click', function () {
        if (!confirm('Ripristinare i dati demo? Le modifiche locali verranno perse.')) return;
        setData(Store.reset());
        toast('Dati demo ripristinati', 'ok');
      });
    }
  };
  const Store = window.Store;
})();
