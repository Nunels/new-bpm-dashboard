/*
 * Grafo dell'Execution Plan (SVG, senza dipendenze): inizio → blocchi e gate → … → fine.
 * Colonne = livelli di esecuzione (i nodi nella stessa colonna sono paralleli), il gate è un rombo,
 * le condizioni (SE …) e gli instradamenti (ritorni indietro, salti, stop) sono archi etichettati.
 * Legge solo l'Execution Plan.
 */
(function () {
  const h = Util.h;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const FONT = 'Segoe UI, system-ui, sans-serif';
  const C = { blue: '#2c5d7c', async: '#46598a', orange: '#e07b39', orangeD: '#b85d22', orangeL: '#fdebdc', line: '#7f93a3', text: '#1d2733', muted: '#6b7785',
    band: ['#f7f9fb', '#eef3f7'], ok: '#2e8b57', ko: '#c0392b', route: '#0445b8' };
  const NW = 168, NH = 54, GW = 128, GH = 76, PW = 150, PH = 28, CG = 72, VG = 26, TOP = 64, LEFT = 24;

  function s(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] != null) el.setAttribute(k, attrs[k]); });
    Array.prototype.slice.call(arguments, 2).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function trunc(str, n) { str = String(str || ''); return str.length > n ? str.slice(0, n - 1) + '…' : str; }

  function policyTag(pol) {
    const t = [];
    if (pol.stopOnKo) t.push('ferma se KO');
    else t.push(pol.koProducts === 'CONTINUE' ? 'prosegui con KO' : 'solo OK');
    if (pol.dontWait.length) t.push('non attende ' + pol.dontWait.length);
    return t;
  }

  /* Costruisce nodi e archi dal piano: colonna = livello nel grafo delle dipendenze. */
  function buildGraph(data, plan) {
    const nodes = [], edges = [];
    const mk = function (n) { n.id = 'n' + nodes.length; nodes.push(n); return n; };
    const start = mk({ kind: 'start', col: 0, w: 150, h: 40, lines: [trunc(plan.offer.name, 20), plan.products.length + ' prodotti'], products: null });
    const acts = {}, gates = {};
    plan.activities.forEach(function (a) { acts[a.activityId] = a; });
    plan.gates.forEach(function (g) { gates[g.gateId] = g; });
    const depsOf = function (id) { return (acts[id] ? acts[id].dependsOn : gates[id].dependsOn).filter(function (d) { return acts[d] || gates[d]; }); };
    const level = {};
    const levelOf = function (id, seen) {
      if (level[id] != null) return level[id];
      if (seen[id]) return 0;
      seen[id] = true;
      const ds = depsOf(id);
      level[id] = ds.length ? Math.max.apply(null, ds.map(function (d) { return levelOf(d, seen); })) + 1 : 0;
      return level[id];
    };
    plan.order.forEach(function (id) { levelOf(id, {}); });
    const byId = {};
    let maxCol = 0;
    plan.order.forEach(function (id) {
      const col = level[id] + 1;
      maxCol = Math.max(maxCol, col);
      const a = acts[id];
      if (a) {
        const lines = [trunc(a.taskName, 22)];
        const tags = [];
        if (a.products.length > 1) tags.push(a.invocation.mode === 'SINGLE_CALL_FOR_N_PRODUCTS' ? '1 chiamata × ' + a.products.length : a.products.length + ' chiamate');
        if (a.executionType === 'ASYNC_CALLBACK') tags.push('async');
        if (a.outcomes.KO_WITH_TASK) tags.push('KO→task');
        lines.push(trunc(a.products.map(function (p) { return Model.productName(data, p); }).join(', '), 28));
        if (tags.length) lines.push(trunc(tags.join(' · '), 30));
        const title = a.taskName + '\n' + a.service.method + ' ' + a.service.path + '\nProdotti: ' + a.products.join(', ') + (a.when ? '\nSE ' + a.when.text : '');
        byId[id] = mk({ kind: 'block', col: col, w: NW, h: NH + (tags.length ? 12 : 0) + (a.when ? 15 : 0), lines: lines, cond: a.when ? trunc('SE ' + a.when.text, 32) : null, async: a.executionType === 'ASYNC_CALLBACK', products: a.products, title: title, activity: a });
        return;
      }
      const g = gates[id];
      const pol = g.effectivePolicy;
      const stopCauses = [];
      if (pol.stopOnKo) stopCauses.push('KO');
      g.routes.forEach(function (r) {
        if (r.to === 'STOP') stopCauses.push(r.condition);
        else if (r.backward && r.onExceed === 'STOP') stopCauses.push('oltre ' + r.maxIterations + ' ritorni');
      });
      byId[id] = mk({ kind: 'gate', col: col, w: GW, h: GH, lines: [g.kind === 'JOIN' ? 'GATE ⋈' : 'GATE', policyTag(pol)[0]], sub: policyTag(pol).slice(1), products: g.products, title: 'Gate ' + g.gateId + (g.note ? ' · ' + g.note : '') + '\n' + pol.description.join('\n') });
      if (stopCauses.length) byId[id].stop = mk({ kind: 'stop', col: col, w: PW, h: PH, lines: ['⛔ offerta fermata'], products: null, causes: stopCauses });
    });
    const end = mk({ kind: 'end', col: maxCol + 1, w: PW, h: PH + 6, lines: ['✔ Offerta completata'], products: null });

    /* ---- archi ---- */
    const edge = function (from, to, kind, label, extra) { edges.push(Object.assign({ from: from, to: to, kind: kind, label: label || null }, extra || {})); };
    const hasSucc = {};
    plan.order.forEach(function (id) {
      const ds = depsOf(id);
      if (!ds.length) edge(start, byId[id], 'flow');
      ds.forEach(function (d) {
        hasSucc[d] = true;
        const wait = gates[id] && gates[id].effectivePolicy.dontWait.indexOf(d) >= 0;
        edge(byId[d], byId[id], wait ? 'async' : 'flow', wait ? 'non attesa' : null);
      });
    });
    plan.order.forEach(function (id) { if (!hasSucc[id]) edge(byId[id], end, 'flow'); });
    if (!plan.order.length) edge(start, end, 'flow');
    plan.gates.forEach(function (g) {
      const n = byId[g.gateId];
      if (n.stop) edge(n, n.stop, 'stop', trunc(n.stop.causes.join(' / '), 30));
      g.routes.forEach(function (r) {
        if (r.to === 'STOP' || !byId[r.to]) return;
        edge(n, byId[r.to], r.backward ? 'back' : 'skip', trunc(r.condition + (r.backward ? ' · max ' + r.maxIterations : ''), 40), { full: r.text });
      });
    });
    return { nodes: nodes, edges: edges, steps: [], cols: maxCol + 2 };
  }
  function layout(g) {
    const byCol = {};
    g.nodes.forEach(function (n) { (byCol[n.col] = byCol[n.col] || []).push(n); });
    const colH = function (list) { return list.reduce(function (a, n) { return a + n.h + VG; }, -VG); };
    const maxH = Math.max.apply(null, Object.keys(byCol).map(function (k) { return colH(byCol[k]); }));
    Object.keys(byCol).forEach(function (k) {
      const list = byCol[k];
      let y = TOP + (maxH - colH(list)) / 2;
      list.forEach(function (n) {
        n.x = LEFT + n.col * (NW + CG) + (NW - n.w) / 2;
        n.y = y;
        y += n.h + VG;
      });
    });
    g.width = LEFT * 2 + g.cols * (NW + CG) - CG + 10;
    g.height = TOP + maxH + 70;
    g.bodyBottom = TOP + maxH;
  }

  function renderGraph(data, plan) {
    const g = buildGraph(data, plan);
    layout(g);
    const backCount = g.edges.filter(function (e) { return e.kind === 'back' || e.kind === 'skip'; }).length;
    const W = g.width, H = g.height + backCount * 14 + 40;
    const uid = 'g' + Math.floor(Math.random() * 1e6);

    const kinds = { flow: { color: C.line, dash: null }, async: { color: C.line, dash: '6 4' }, back: { color: C.route, dash: '7 4' }, skip: { color: C.orangeD, dash: '7 4' }, stop: { color: C.ko, dash: '4 3' } };
    const defs = s('defs');
    Object.keys(kinds).forEach(function (k) {
      defs.appendChild(s('marker', { id: uid + '-' + k, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        s('path', { d: 'M0,0 L10,5 L0,10 z', fill: kinds[k].color })));
    });

    const edgeLayer = s('g'), labelLayer = s('g'), nodeLayer = s('g');

    // archi: ritorni e salti passano sotto il grafo, uno per "corsia", per non attraversare i nodi
    let lanes = 0;
    const pts = function (e) {
      const a = e.from, b = e.to;
      return { x1: a.x + a.w, y1: a.y + a.h / 2, x2: b.x, y2: b.y + b.h / 2 };
    };
    const edgeEls = [];
    g.edges.forEach(function (e) {
      const k = kinds[e.kind];
      let d, lx, ly;
      const a = e.from, b = e.to;
      if (e.kind === 'back' || e.kind === 'skip') {
        const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y + b.h;
        const yb = g.bodyBottom + 30 + lanes++ * 14;
        d = 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + yb + ' ' + x2 + ',' + yb + ' ' + x2 + ',' + y2;
        lx = (x1 + x2) / 2; ly = yb - 6;
      } else if (e.kind === 'stop') {
        const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
        d = 'M' + x1 + ',' + y1 + ' L' + x2 + ',' + y2;
        lx = x1 + 6; ly = (y1 + y2) / 2 + 3;
      } else {
        const p = pts(e);
        const mx = (p.x1 + p.x2) / 2;
        d = 'M' + p.x1 + ',' + p.y1 + ' C' + mx + ',' + p.y1 + ' ' + mx + ',' + p.y2 + ' ' + p.x2 + ',' + p.y2;
        lx = mx; ly = (p.y1 + p.y2) / 2 - 4;
      }
      const path = s('path', { d: d, fill: 'none', stroke: k.color, 'stroke-width': e.kind === 'flow' ? 2 : 2.2, 'stroke-dasharray': k.dash, 'marker-end': 'url(#' + uid + '-' + e.kind + ')', class: 'pg-edge' });
      if (e.full) path.appendChild(s('title', null, e.full));
      edgeLayer.appendChild(path);
      if (e.label) {
        const t = s('text', { x: lx, y: ly, 'text-anchor': e.kind === 'stop' ? 'start' : 'middle', 'font-size': 10.5, 'font-family': FONT, fill: e.kind === 'back' ? C.route : e.kind === 'stop' ? C.ko : e.kind === 'skip' ? C.orangeD : C.muted, 'font-weight': e.kind === 'flow' || e.kind === 'async' ? 400 : 600, stroke: '#fff', 'stroke-width': 3, 'paint-order': 'stroke' }, e.label);
        labelLayer.appendChild(t);
        edgeEls.push({ e: e, els: [path, t] });
      } else edgeEls.push({ e: e, els: [path] });
    });

    // nodi
    const nodeEls = {};
    g.nodes.forEach(function (n) {
      const grp = s('g', { class: 'pg-node', 'data-id': n.id });
      if (n.title) grp.appendChild(s('title', null, n.title));
      const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
      if (n.kind === 'block') {
        grp.appendChild(s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 9, fill: n.async ? C.async : C.blue, stroke: n.cond ? C.orange : null, 'stroke-width': n.cond ? 2.5 : null, 'stroke-dasharray': n.cond ? '6 3' : null }));
        let y = n.y + 19;
        n.lines.forEach(function (l, i) {
          grp.appendChild(s('text', { x: cx, y: y, 'text-anchor': 'middle', 'font-size': i === 0 ? 13 : 10.5, 'font-weight': i === 0 ? 700 : 400, fill: i === 0 ? '#fff' : '#d6e4ef', 'font-family': FONT }, l));
          y += i === 0 ? 16 : 13;
        });
        if (n.cond) grp.appendChild(s('text', { x: cx, y: y + 1, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 700, fill: '#ffd6b8', 'font-family': FONT }, n.cond));
      } else if (n.kind === 'gate') {
        grp.appendChild(s('polygon', { points: [cx + ',' + n.y, (n.x + n.w) + ',' + cy, cx + ',' + (n.y + n.h), n.x + ',' + cy].join(' '), fill: C.orange, stroke: C.orangeD, 'stroke-width': 1.5 }));
        grp.appendChild(s('text', { x: cx, y: cy - 3, 'text-anchor': 'middle', 'font-size': 11.5, 'font-weight': 700, fill: '#fff', 'font-family': FONT }, n.lines[0]));
        grp.appendChild(s('text', { x: cx, y: cy + 11, 'text-anchor': 'middle', 'font-size': 10, fill: '#fff', 'font-family': FONT }, n.lines[1]));
      } else {
        const fill = n.kind === 'start' ? C.blue : n.kind === 'end' ? C.ok : '#fff';
        const color = n.kind === 'stop' ? C.ko : '#fff';
        grp.appendChild(s('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: n.h / 2, fill: fill, stroke: n.kind === 'stop' ? C.ko : null, 'stroke-width': 1.5 }));
        if (n.kind === 'start') {
          grp.appendChild(s('text', { x: cx, y: n.y + 17, 'text-anchor': 'middle', 'font-size': 12.5, 'font-weight': 700, fill: '#fff', 'font-family': FONT }, n.lines[0]));
          grp.appendChild(s('text', { x: cx, y: n.y + 31, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#cfe0ec', 'font-family': FONT }, n.lines[1]));
        } else grp.appendChild(s('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: color, 'font-family': FONT }, n.lines[0]));
      }
      nodeLayer.appendChild(grp);
      nodeEls[n.id] = grp;
    });

    // legenda
    const ly = H - 22, legend = s('g');
    let lx = 14;
    [['flow', 'sequenza / parallelo'], ['async', 'non attesa'], ['back', 'ritorno indietro (se …)'], ['skip', 'salto in avanti (se …)'], ['stop', 'stop']].forEach(function (it) {
      legend.appendChild(s('line', { x1: lx, y1: ly, x2: lx + 28, y2: ly, stroke: kinds[it[0]].color, 'stroke-width': 2.2, 'stroke-dasharray': kinds[it[0]].dash }));
      legend.appendChild(s('text', { x: lx + 34, y: ly + 4, 'font-size': 11, fill: C.text, 'font-family': FONT }, it[1]));
      lx += 34 + it[1].length * 6.2 + 22;
    });
    legend.appendChild(s('rect', { x: lx, y: ly - 6, width: 22, height: 12, rx: 3, fill: C.blue, stroke: C.orange, 'stroke-width': 2, 'stroke-dasharray': '4 2' }));
    legend.appendChild(s('text', { x: lx + 28, y: ly + 4, 'font-size': 11, fill: C.text, 'font-family': FONT }, 'blocco condizionato (SE …)'));

    const svg = s('svg', { xmlns: SVGNS, width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'plan-graph-svg' },
      s('rect', { x: 0, y: 0, width: W, height: H, fill: '#fff' }), defs, edgeLayer, labelLayer, nodeLayer, legend);

    // interazione: filtro per prodotto, evidenzia connessioni, zoom, trascinamento
    let scale = 1;
    const apply = function () { svg.setAttribute('width', W * scale); svg.setAttribute('height', H * scale); };
    const scroller = h('div', { class: 'plan-tree plan-graph-scroll' }, svg);
    let selected = null;
    const refresh = function (product) {
      g.nodes.forEach(function (n) {
        const dim = (product && n.products && n.products.indexOf(product) < 0) || (selected && !connected(n));
        nodeEls[n.id].setAttribute('opacity', dim ? 0.22 : 1);
      });
      edgeEls.forEach(function (x) {
        const dimP = product && ((x.e.from.products && x.e.from.products.indexOf(product) < 0) || (x.e.to.products && x.e.to.products.indexOf(product) < 0));
        const dimS = selected && x.e.from !== selected && x.e.to !== selected;
        x.els.forEach(function (el) { el.setAttribute('opacity', dimP || dimS ? 0.15 : 1); });
      });
    };
    const connected = function (n) {
      return n === selected || g.edges.some(function (e) { return (e.from === selected && e.to === n) || (e.to === selected && e.from === n); });
    };
    let product = '';
    g.nodes.forEach(function (n) {
      nodeEls[n.id].style.cursor = 'pointer';
      nodeEls[n.id].addEventListener('click', function (ev) { ev.stopPropagation(); selected = selected === n ? null : n; refresh(product); });
    });
    svg.addEventListener('click', function () { selected = null; refresh(product); });
    let drag = null;
    scroller.addEventListener('mousedown', function (e) { drag = { x: e.clientX, y: e.clientY, sl: scroller.scrollLeft, st: scroller.scrollTop }; });
    window.addEventListener('mousemove', function (e) { if (drag) { scroller.scrollLeft = drag.sl - (e.clientX - drag.x); scroller.scrollTop = drag.st - (e.clientY - drag.y); } });
    window.addEventListener('mouseup', function () { drag = null; });

    const prodSelect = h('select', { onchange: function (e) { product = e.target.value; refresh(product); } },
      h('option', { value: '' }, 'Tutti i prodotti'), plan.products.map(function (p) { return h('option', { value: p.id }, p.name); }));
    const bar = h('div', { class: 'plan-graph-bar' },
      h('span', { class: 'muted' }, 'Clic su un nodo = evidenzia i collegamenti · trascina per spostarti'),
      h('div', { class: 'spacer' }),
      h('label', null, 'Prodotto ', prodSelect),
      h('button', { class: 'small', onclick: function () { scale = Math.max(0.4, scale - 0.15); apply(); } }, '−'),
      h('button', { class: 'small', onclick: function () { scale = Math.min(2.5, scale + 0.15); apply(); } }, '+'),
      h('button', { class: 'small', onclick: function () { scale = 1; apply(); } }, '100%'));
    const root = h('div', { class: 'plan-graph' }, bar, scroller);
    return root;
  }

  window.ExecutionPlan.renderGraph = renderGraph;
})();
