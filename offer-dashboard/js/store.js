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
  /* Step del vecchio modello, solo per portare al modello attuale le offerte salvate prima. */
  const LEGACY_STEPS = ['PRELIMINARI', 'VERTICALI', 'BO', 'ATTIVAZIONI', 'POST_ATTIVAZIONI'];

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

    /* ---------- nodi: blocchi e gate sono mattoncini dello stesso grafo (dependsOn = "Esegui dopo") ---------- */
    block: function (o, id) { return o.blocks.find(function (b) { return b.id === id; }) || null; },
    gate: function (o, id) { return o.gates.find(function (g) { return g.id === id; }) || null; },
    node: function (o, id) { return Model.block(o, id) || Model.gate(o, id); },
    isGate: function (o, id) { return o.gates.some(function (g) { return g.id === id; }); },
    nodes: function (o) {
      return o.blocks.map(function (b) { return { id: b.id, kind: 'block', ref: b, dependsOn: b.dependsOn || [] }; })
        .concat(o.gates.map(function (g) { return { id: g.id, kind: 'gate', ref: g, dependsOn: g.dependsOn || [] }; }));
    },
    blockLabel: function (data, offer, nodeId) {
      const b = Model.block(offer, nodeId);
      if (!b) return Model.isGate(offer, nodeId) ? 'Gate ' + nodeId : nodeId + ' (?)';
      const t = Model.task(data, b.taskId);
      return (t ? t.name : b.taskId) + ' [' + b.products.map(function (p) { return Model.productName(data, p); }).join(', ') + ']';
    },
    /* Nome breve di un nodo: il task del blocco, oppure "Gate <id>". */
    nodeName: function (data, offer, nodeId) {
      const b = Model.block(offer, nodeId);
      if (b) { const t = Model.task(data, b.taskId); return t ? t.name : b.taskId; }
      return Model.isGate(offer, nodeId) ? 'Gate ' + nodeId : nodeId + ' (?)';
    },

    /*
     * Grafo delle dipendenze: `deps` (genitori validi), `kids`, `order` (ordine topologico), `cycle` (nodi in un ciclo),
     * `anc[id]` (tutti gli antenati) e `reduced` (dipendenze senza quelle implicite: a→b→c rende inutile a→c).
     */
    graph: function (o) {
      const nodes = Model.nodes(o);
      const ids = nodes.map(function (n) { return n.id; });
      const deps = {}, kids = {};
      nodes.forEach(function (n) { deps[n.id] = []; kids[n.id] = []; });
      nodes.forEach(function (n) {
        (n.dependsOn || []).forEach(function (d) { if (d !== n.id && deps[d] && deps[n.id].indexOf(d) < 0) { deps[n.id].push(d); kids[d].push(n.id); } });
      });
      const order = [], placed = {};
      let remaining = ids.slice(), progress = true;
      while (remaining.length && progress) {
        progress = false;
        remaining = remaining.filter(function (id) {
          if (deps[id].every(function (d) { return placed[d]; })) { order.push(id); placed[id] = true; progress = true; return false; }
          return true;
        });
      }
      const anc = {};
      order.forEach(function (id) {
        const s = {};
        deps[id].forEach(function (d) { s[d] = true; Object.keys(anc[d]).forEach(function (k) { s[k] = true; }); });
        anc[id] = s;
      });
      const reduced = {};
      ids.forEach(function (id) {
        reduced[id] = anc[id] ? deps[id].filter(function (d) { return !deps[id].some(function (d2) { return d2 !== d && anc[d2] && anc[d2][d]; }); }) : deps[id].slice();
      });
      return { ids: ids, deps: deps, kids: kids, order: order, cycle: remaining, anc: anc, reduced: reduced };
    },

    /* `id` può dipendere da `depId` senza creare un ciclo? */
    canDepend: function (o, id, depId) {
      if (id === depId || !Model.node(o, id) || !Model.node(o, depId)) return false;
      const g = Model.graph(o);
      return !(g.anc[depId] && g.anc[depId][id]);
    },
    /* Antenati (anche indiretti) di un nodo. */
    ancestors: function (o, id) { return Object.keys(Model.graph(o).anc[id] || {}); },

    /* Prodotti che un gate "governa": quelli dei blocchi a monte (nel suo ramo). */
    scopeProducts: function (o, id, g) {
      g = g || Model.graph(o);
      const set = {};
      const add = function (nid) { const b = Model.block(o, nid); if (b) b.products.forEach(function (p) { set[p] = true; }); };
      Object.keys(g.anc[id] || {}).forEach(add);
      return o.products.filter(function (p) { return set[p]; });
    },

    /* Righe prodotto occupate da un gate nella griglia: quelle dei nodi a cui è collegato (come sono alti i blocchi che precedono). */
    gateSpan: function (o, id, seen) {
      seen = seen || {};
      const set = {};
      if (seen[id]) return [];
      seen[id] = true;
      const n = Model.node(o, id);
      ((n && n.dependsOn) || []).forEach(function (d) {
        const b = Model.block(o, d);
        (b ? b.products : Model.gateSpan(o, d, seen)).forEach(function (p) { set[p] = true; });
      });
      return o.products.filter(function (p) { return set[p]; });
    },

    /*
     * Struttura serie/parallelo del grafo: l'unica forma che il DSL sa esprimere (sequenze + fork annidati).
     * tree = { type: 'seq'|'par', items } con foglie { type: 'node', id }. Un nodo che precede o segue tutti gli altri
     * di un gruppo connesso spezza la serie; i gruppi non connessi sono rami in parallelo. Se non c'è un tale nodo
     * (forma a "N": A→C, A→D, B→D) il grafo non è esprimibile: errore 'nonSeriesParallel'.
     * top = nodi della sequenza principale (gli unici raggiungibili da un instradamento).
     */
    structure: function (o) {
      const g = Model.graph(o);
      const res = { tree: null, top: [], order: [], errors: [], graph: g };
      if (g.cycle.length) { res.errors.push({ kind: 'cycle', ids: g.cycle.slice() }); return res; }
      if (!g.ids.length) return res;
      const topo = {};
      g.order.forEach(function (id, i) { topo[id] = i; });
      const leaf = function (id) { return { type: 'node', id: id }; };
      const flat = function (items) {
        const out = [];
        items.forEach(function (it) { if (it.type === 'seq') it.items.forEach(function (x) { out.push(x); }); else out.push(it); });
        return out;
      };
      const build = function (set) {
        if (set.length === 1) return leaf(set[0]);
        const inSet = {};
        set.forEach(function (id) { inSet[id] = true; });
        const comp = {};
        set.forEach(function (id) { comp[id] = id; });
        const find = function (x) { while (comp[x] !== x) { comp[x] = comp[comp[x]]; x = comp[x]; } return x; };
        set.forEach(function (id) { g.reduced[id].forEach(function (d) { if (inSet[d]) comp[find(id)] = find(d); }); });
        const groups = {}, list = [];
        set.forEach(function (id) { const r = find(id); if (!groups[r]) { groups[r] = []; list.push(groups[r]); } groups[r].push(id); });
        if (list.length > 1) return { type: 'par', items: list.map(build) };
        const v = set.slice().sort(function (a, z) { return topo[a] - topo[z]; }).find(function (c) {
          return set.every(function (u) { return u === c || g.anc[c][u] || g.anc[u][c]; });
        });
        if (!v) {
          res.errors.push({ kind: 'nonSeriesParallel', ids: set.slice() });
          return { type: 'seq', items: set.slice().sort(function (a, z) { return topo[a] - topo[z]; }).map(leaf) };
        }
        const before = set.filter(function (u) { return g.anc[v][u]; }), after = set.filter(function (u) { return g.anc[u][v]; });
        const items = [];
        if (before.length) items.push(build(before));
        items.push(leaf(v));
        if (after.length) items.push(build(after));
        return { type: 'seq', items: flat(items) };
      };
      res.tree = build(g.ids.slice());
      const walk = function (n) { if (n.type === 'node') res.order.push(n.id); else n.items.forEach(walk); };
      walk(res.tree);
      res.top = res.tree.type === 'node' ? [res.tree.id] : res.tree.type === 'seq' ? res.tree.items.filter(function (x) { return x.type === 'node'; }).map(function (x) { return x.id; }) : [];
      return res;
    },

    /* Descrizione degli errori di struttura (per validazione e piano). */
    structureErrors: function (data, o, st) {
      const nm = function (ids) { return ids.map(function (i) { return Model.nodeName(data, o, i) + ' [' + i + ']'; }).join(', '); };
      return (st || Model.structure(o)).errors.map(function (e) {
        return e.kind === 'cycle'
          ? 'Dipendenze circolari tra: ' + nm(e.ids) + '.'
          : 'Le dipendenze tra ' + nm(e.ids) + ' non si possono esprimere nel DSL (rami che si incrociano). Aggiungi un gate "join" che riunisca i rami, oppure separa i percorsi.';
      });
    },

    /* Raggruppa i nodi in livelli secondo le dipendenze: stesso livello = stessa colonna. */
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
     * Griglia libera: colonne = livelli di esecuzione di tutta l'offerta (blocchi e gate). I nodi paralleli stanno nella stessa
     * colonna. Corsie: ogni ramo ha la propria; un figlio sta sulla corsia del genitore se è libera, un join (più genitori)
     * si allunga sulle corsie di tutti i suoi genitori quando sono libere nella sua colonna. Dentro una riga prodotto le
     * corsie realmente usate diventano sotto-righe (rankTop/rankBot = inizio/fine del nodo); con una sola corsia il nodo
     * occupa tutta la riga. `laneCount[r]` = corsie usate nella riga prodotto r.
     */
    layout: function (o) {
      const g = Model.graph(o);
      const items = Model.nodes(o).map(function (n) {
        return { id: n.id, kind: n.kind, ref: n.ref, dependsOn: g.deps[n.id], products: n.kind === 'block' ? n.ref.products : Model.gateSpan(o, n.id) };
      });
      const levels = Model.levels(items).levels.map(function (l) { return l.slice(); });
      const parentsOf = function (b) { return b.dependsOn; };
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
          if (ps.length >= 1) {
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
          placements.push({ id: b.id, kind: b.kind, block: b.kind === 'block' ? b.ref : null, gate: b.kind === 'gate' ? b.ref : null, lane: li, rs: rs, re: re, k0: k0, k1: k1, products: b.products });
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
      return { lanes: Math.max(levels.length, 1), placements: placements, laneCount: laneCount, levels: levels.map(function (l) { return l.map(function (b) { return b.id; }); }) };
    },

    /* Politica effettiva di un gate (o di più gate in sequenza), combinando le regole in ordine. */
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

    /* Regole ROUTE di un gate, con la chiave del contatore dei giri. */
    routesOf: function (g) {
      const r = [];
      g.rules.forEach(function (x, i) { if (x.type === 'ROUTE') r.push({ gate: g, rule: x, index: i, key: g.id + '-' + i }); });
      return r;
    },
    allRoutes: function (o) {
      return [].concat.apply([], o.gates.map(function (g) { return Model.routesOf(g); }));
    },

    ruleText: function (data, offer, r) {
      const t = RULE_TYPES[r.type];
      if (!t) return r.type;
      if (r.type === 'ROUTE') {
        const dest = r.to === 'STOP' ? 'ferma l\'offerta' : (r.to ? Model.nodeName(data, offer, r.to) : '(destinazione?)');
        return 'Se ' + (window.Conditions.describe(data, offer, r.when) || '(condizione?)') + ' → ' + dest + (r.to === 'STOP' ? '' : ' (max ' + r.maxIterations + ' volte)');
      }
      if (r.type === 'DONT_WAIT') return 'Non attendere: ' + (r.blockId ? Model.blockLabel(data, offer, r.blockId) : '(blocco?)');
      if (r.type === 'STOP_ON_KO' && r.products && r.products.length) return 'Ferma tutto se KO su: ' + r.products.map(function (p) { return Model.productName(data, p); }).join(', ');
      return t.label;
    },

    /* Forma canonica dell'offerta (solo i dati di configurazione, in ordine stabile): usata da DSL e confronti. */
    canonicalOffer: function (offer) {
      const o = {
        id: offer.id, name: offer.name, description: offer.description || '',
        products: (offer.products || []).slice(),
        blocks: (offer.blocks || []).map(function (b) {
          return { id: b.id, taskId: b.taskId, products: (b.products || []).slice(), dependsOn: (b.dependsOn || []).slice(), config: clone(b.config || {}) };
        }),
        gates: (offer.gates || []).map(function (g) {
          return { id: g.id, dependsOn: (g.dependsOn || []).slice(), note: g.note || '', rules: clone(g.rules || []) };
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

    /*
     * Offerte salvate con il vecchio modello (step fissi + barre in uscita): ogni step diventa un gruppo di blocchi seguito da un
     * gate "join" con le regole delle sue barre; i blocchi radice dello step successivo dipendono da quel gate. Il comportamento
     * è lo stesso del modello a step. Gli instradamenti puntano al primo blocco radice dello step di destinazione.
     */
    migrateOffer: function (o) {
      const legacy = o.blocks.some(function (b) { return b.stepId; }) || o.gates.some(function (g) { return g.afterStep; });
      if (!legacy) return false;
      const gates = [];
      const rootOf = {};
      let prev = null;
      LEGACY_STEPS.forEach(function (sid, i) {
        const blocks = o.blocks.filter(function (b) { return b.stepId === sid; });
        const ids = blocks.map(function (b) { return b.id; });
        const roots = [];
        blocks.forEach(function (b) {
          const inStep = (b.dependsOn || []).filter(function (d) { return ids.indexOf(d) >= 0; });
          b.dependsOn = inStep.slice();
          if (!inStep.length) { roots.push(b); if (prev) b.dependsOn.push(prev); }
        });
        if (roots.length) rootOf[sid] = roots[0].id;
        if (i === LEGACY_STEPS.length - 1) return;
        const tails = blocks.filter(function (b) { return !blocks.some(function (x) { return (x.dependsOn || []).indexOf(b.id) >= 0 && ids.indexOf(x.id) >= 0; }); }).map(function (b) { return b.id; });
        const deps = tails.length ? tails : (prev ? [prev] : []);
        if (!deps.length) return;
        const mine = o.gates.filter(function (g) { return g.afterStep === sid; });
        const later = LEGACY_STEPS.slice(i + 1).some(function (x) { return o.blocks.some(function (b) { return b.stepId === x; }); });
        if (!mine.length && (!blocks.length || !later)) return;
        let gid = mine.length ? mine[0].id : 'G_' + sid;
        while (gates.some(function (x) { return x.id === gid; }) || o.blocks.some(function (b) { return b.id === gid; })) gid += '_';
        gates.push({ id: gid, dependsOn: deps, note: mine.map(function (g) { return g.note; }).filter(Boolean).join(' · '), rules: [].concat.apply([], mine.map(function (g) { return clone(g.rules || []); })) });
        prev = gid;
      });
      gates.forEach(function (g) {
        g.rules.forEach(function (r) { if (r.type === 'ROUTE' && r.to && r.to !== 'STOP' && rootOf[r.to]) r.to = rootOf[r.to]; });
      });
      o.blocks.forEach(function (b) { delete b.stepId; });
      o.gates = gates;
      return true;
    },

    /* Completa i campi mancanti (es. blocchi seed senza config) e porta al modello attuale i dati salvati prima. */
    normalize: function (data) {
      delete data.steps;
      data.products = data.products || [];
      data.tasks = data.tasks || [];
      data.offers = data.offers || [];
      // dati salvati prima del modello della pratica: lo ricavo dai percorsi usati dai task
      if (!data.practice || !Array.isArray(data.practice.fields)) data.practice = window.Fields.inferPractice(data.tasks);
      data.tasks.forEach(function (t) {
        t.inputs = t.inputs || []; t.outputs = t.outputs || []; t.outcomes = t.outcomes || ['OK', 'KO'];
        t.inputs.forEach(function (i) { i.type = i.type || 'string'; });
        t.outputs.forEach(function (o) { o.type = o.type || 'string'; });
        t.compatibleProducts = t.compatibleProducts || [];
        delete t.scope; delete t.allowedSteps;
        t.api = t.api || { method: 'POST', path: '' }; t.extensions = t.extensions || { request: false, ko: false };
        t.defaults = t.defaults || {}; t.defaults.retry = t.defaults.retry || { count: 0, intervalSec: 0 };
        // lista dei risultati per prodotto: la risposta contiene una lista con un elemento per prodotto (campo prodotto + campo esito)
        t.productResults = t.productResults && t.productResults.list ? Object.assign({ productField: 'prodotto', outcomeField: 'esito', ok: ['OK'], koTask: [] }, t.productResults) : null;
      });
      data.offers.forEach(function (o) {
        o.products = o.products || []; o.blocks = o.blocks || []; o.gates = o.gates || [];
        Model.migrateOffer(o);
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
          g.rules = g.rules || []; g.note = g.note || ''; g.dependsOn = g.dependsOn || [];
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
