/* Dashboard di configurazione offerta: griglia prodotti × step, blocchi, gate, simulazione. */
(function () {
  const h = Util.h, toast = Util.toast;
  const RT = Model.RULE_TYPES;

  let data = Store.load();
  let offerId = data.offers.length ? data.offers[0].id : null;
  let selection = null;           // { type: 'block' | 'gate', id }
  let simMode = false;
  const simOutcomes = {};         // offerId -> blockId -> productId -> esito
  const simScenario = {};         // offerId -> { practice, outputs }: dati usati dalle condizioni nella simulazione
  const simRecover = {};          // offerId -> true: dopo un ritorno indietro tutti i blocchi rieseguiti rispondono OK
  let validation = null;
  let lastSim = null;
  let dragPayload = null;         // { kind: 'task' | 'block', id }
  let paletteFilter = '';
  let view = 'visual';            // 'visual' | 'graph' | 'diagram' | 'model'
  let diagramFile = 0;            // file DSL mostrato nella scheda Diagramma (0 = workflow principale)

  /* stato dell'interfaccia (barra task, pannello dettagli): solo preferenze, non fanno parte dei dati dell'offerta */
  const UI_KEY = 'offerDashboard.ui.v1';
  const ui = (function () {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (e) { s = {}; }
    return { paletteCollapsed: !!s.paletteCollapsed, panelCollapsed: s.panelCollapsed !== false, panelHeight: Number(s.panelHeight) > 0 ? Number(s.panelHeight) : 300, diagramTheme: ['light', 'dark', 'system'].indexOf(s.diagramTheme) >= 0 ? s.diagramTheme : 'light' };
  })();
  function saveUi() {
    try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* preferenze non salvate */ }
  }
  let panelAutoOpen = false;      // pannello aperto da una nuova selezione, a prescindere dalla preferenza salvata
  let lastSelKey = null;

  function panelIsCollapsed() { return ui.panelCollapsed && !(panelAutoOpen && selection); }

  /* altezza massima del pannello: la timeline conserva almeno ~330px */
  function panelMax() { return Math.max(160, Math.min(Math.round(window.innerHeight * 0.7), window.innerHeight - 330)); }

  function applyPanelState() {
    const key = selection ? selection.type + ':' + selection.id : null;
    if (key && key !== lastSelKey) panelAutoOpen = true;   // una nuova selezione (clic o drop) apre il pannello
    if (!key) panelAutoOpen = false;
    lastSelKey = key;
    const w = $('panelwrap');
    const max = panelMax();
    w.classList.toggle('collapsed', panelIsCollapsed());
    w.style.setProperty('--panel-h', Math.min(Math.max(ui.panelHeight, 120), max) + 'px');
    renderPanelBar();
  }

  function togglePanel() {
    if (panelIsCollapsed()) { ui.panelCollapsed = false; } else { ui.panelCollapsed = true; panelAutoOpen = false; }
    saveUi(); applyPanelState();
  }

  function renderPanelBar() {
    const bar = $('panelbar'); bar.innerHTML = '';
    const o = offer();
    if (!o) return;
    let title = 'Offerta: ' + o.name;
    if (selection) {
      const x = selection.type === 'block' ? o.blocks.find(function (b) { return b.id === selection.id; }) : o.gates.find(function (g) { return g.id === selection.id; });
      if (x) title = selection.type === 'block' ? 'Blocco: ' + (Model.task(data, x.taskId) || { name: x.taskId }).name : 'Gate ' + x.id;
    }
    const v = validation;
    const status = !v ? null : v.errors.length ? h('span', { class: 'pb-status err' }, '✖ ' + v.errors.length + (v.errors.length === 1 ? ' errore' : ' errori'))
      : v.warnings.length ? h('span', { class: 'pb-status warn' }, '⚠ ' + v.warnings.length + (v.warnings.length === 1 ? ' avviso' : ' avvisi'))
      : h('span', { class: 'pb-status ok' }, '✔ Nessun problema');
    bar.append(
      h('span', { class: 'pb-title' }, (panelIsCollapsed() ? '▸ ' : '▾ ') + 'Dettagli'), h('span', { class: 'muted' }, title), status,
      h('div', { class: 'spacer' }),
      h('button', { class: 'small', title: panelIsCollapsed() ? 'Espandi i dettagli' : 'Comprimi i dettagli', onclick: function (e) { e.stopPropagation(); togglePanel(); } }, panelIsCollapsed() ? '▴ Espandi' : '▾ Comprimi'));
    bar.onclick = togglePanel;
  }

  /* maniglia per l'altezza del pannello */
  function initPanelGrip() {
    const grip = $('panel-resize');
    grip.addEventListener('mousedown', function (e) {
      e.preventDefault();
      const move = function (ev) {
        const max = panelMax();
        ui.panelHeight = Math.min(Math.max(window.innerHeight - ev.clientY, 120), max);
        $('panelwrap').style.setProperty('--panel-h', ui.panelHeight + 'px');
      };
      const up = function () { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); saveUi(); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    window.addEventListener('resize', function () { applyPanelState(); });
  }

  const $ = function (id) { return document.getElementById(id); };
  const offer = function () { return data.offers.find(function (o) { return o.id === offerId; }); };
  const pname = function (pid) { return Model.productName(data, pid); };

  /* ---------------- rendering ---------------- */
  function render() {
    if (!offer()) offerId = data.offers.length ? data.offers[0].id : null;
    const o = offer();
    validation = o ? Validation.validateOffer(data, o) : null;
    renderOfferbar(); renderBanner(); paintSimButton();
    $('visualview').classList.toggle('hidden', view !== 'visual');
    $('graphview').classList.toggle('hidden', view !== 'graph');
    $('diagramview').classList.toggle('hidden', view !== 'diagram');
    $('modelview').classList.toggle('hidden', view !== 'model');
    if (view === 'model' && !modelOutput(o)) view = 'visual';
    if (view === 'graph') { renderGraphView(); return; }
    if (view === 'diagram') { renderDiagramView(); return; }
    if (view === 'model') { renderModelJson(); return; }
    renderPalette(); renderBoard(); renderPanel(); applyPanelState(); renderSimLog();
  }

  function commit(level) {
    Store.save(data);
    const o = offer();
    validation = o ? Validation.validateOffer(data, o) : null;
    if (level === 'all') { renderOfferbar(); renderBanner(); renderPalette(); renderPanel(); applyPanelState(); }
    else renderPanelBar();
    renderBoard(); renderSimLog();
  }

  function setView(v) {
    if (v === view) return;
    if (v !== 'visual' && simMode) simMode = false;
    view = v;
    render();
  }

  function select(type, id) {
    selection = type ? { type: type, id: id } : null;
    applyPanelState();
    renderBoard(); renderPanel();
  }

  /* ---------- barra offerta ---------- */
  function renderOfferbar() {
    const bar = $('offerbar'); bar.innerHTML = '';
    const o = offer();
    const available = o ? data.products.filter(function (p) { return o.products.indexOf(p.id) < 0; }) : [];
    const items = [
      h('span', { class: 'lbl' }, 'Offerta'),
      h('select', { class: 'offer-select', value: offerId || '', onchange: function (e) { offerId = e.target.value; selection = null; render(); } },
        data.offers.map(function (x) { return h('option', { value: x.id }, x.name); })),
      h('button', { onclick: newOffer }, '+ Nuova'),
      o ? h('button', { onclick: duplicateOffer }, '⧉ Duplica') : null,
      o ? h('button', { class: 'danger-outline', onclick: deleteOffer }, '🗑 Elimina') : null,
      o ? h('div', { class: 'sep' }) : null,
      o ? h('span', { class: 'lbl' }, 'Prodotti') : null,
      o ? o.products.map(function (pid) {
        return h('span', { class: 'chip' }, pname(pid), simMode ? null : h('button', { class: 'chip-x', title: 'Rimuovi dall\'offerta', onclick: function () { removeProduct(pid); } }, '×'));
      }) : null,
      o && available.length && !simMode ? h('select', { class: 'add-product', value: '', onchange: function (e) { if (e.target.value) { o.products.push(e.target.value); commit('all'); } } },
        h('option', { value: '' }, '+ Aggiungi prodotto…'),
        available.map(function (p) { return h('option', { value: p.id }, p.name + (p.category ? ' (' + p.category + ')' : '')); })) : null,
      h('div', { class: 'spacer' }),
      o ? h('div', { class: 'viewtabs' },
        h('button', { class: 'tab' + (view === 'visual' ? ' active' : ''), onclick: function () { setView('visual'); } }, '▦ Visuale'),
        h('button', { class: 'tab' + (view === 'graph' ? ' active' : ''), title: 'Grafo del processo (sola lettura)', onclick: function () { setView('graph'); } }, '⬡ Grafo'),
        h('button', { class: 'tab' + (view === 'diagram' ? ' active' : ''), title: 'Diagramma del DSL generato, con il viewer ufficiale Open Workflow (sola lettura)', onclick: function () { setView('diagram'); } }, '◇ Diagramma DSL'),
        modelOutput(o) ? h('button', { class: 'tab' + (view === 'model' ? ' active' : ''), title: 'Risposta JSON del modello (sola lettura)', onclick: function () { setView('model'); } }, '🤖 JSON modello') : null) : null
    ];
    items.flat(Infinity).forEach(function (x) { if (x) bar.append(x); });
  }

  /* ---------- palette task ---------- */
  function renderPalette() {
    const p = $('palette'); p.innerHTML = '';
    p.classList.toggle('collapsed', ui.paletteCollapsed);
    const list = h('div', { class: 'palette-list' });
    const help = 'Trascina un task sulla riga di un prodotto: parte dopo il nodo che lo precede su quella riga (oppure all\'inizio se la riga è vuota); nell\'ultima colonna va in coda. Se nella stessa colonna c\'è già lo stesso task su un altro prodotto, il prodotto viene aggiunto al blocco esistente (Alt = blocco separato). Il gate si trascina allo stesso modo: si inserisce dopo il nodo che lo precede (rami) oppure, dal pannello, riunisce più nodi (join).';
    p.append(
      h('div', { class: 'palette-bar' },
        h('h3', null, 'Task del catalogo'),
        ui.paletteCollapsed ? null : h('input', { type: 'search', placeholder: 'Cerca task…', value: paletteFilter, oninput: function (e) { paletteFilter = e.target.value; fillPalette(list); } }),
        ui.paletteCollapsed ? null : h('button', { class: 'help-q', title: help, onclick: function () { toast(help, 'ok'); } }, '?'),
        simMode ? h('span', { class: 'palette-note' }, 'Modalità simulazione: scegli gli esiti dentro i blocchi.') : null,
        h('a', { href: 'catalog.html', class: 'link' }, 'Gestisci catalogo →'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'small', title: ui.paletteCollapsed ? 'Mostra i task' : 'Nascondi i task', onclick: function () { ui.paletteCollapsed = !ui.paletteCollapsed; saveUi(); renderPalette(); } }, ui.paletteCollapsed ? '▾ Mostra' : '▴ Nascondi')),
      list);
    fillPalette(list);
  }

  function fillPalette(list) {
    list.innerHTML = '';
    const o = offer();
    const f = paletteFilter.trim().toLowerCase();
    list.append(h('div', {
      class: 'palette-item gate-item' + (o && !simMode ? '' : ' disabled'), draggable: !!o && !simMode, title: 'Gate: regole di passaggio (solo OK, stop su KO, ritorno/salto, non attendere). Trascinalo su una riga: si inserisce dopo il nodo che la precede.',
      ondragstart: function (e) { hideTaskTip(); startDrag(e, { kind: 'gate' }); }, ondragend: endDrag
    }, h('div', { class: 'pi-name' }, '⛩ Gate'), h('div', { class: 'pi-meta' }, h('span', { class: 'badge' }, 'regole'))));
    data.tasks.filter(function (t) {
      return !f || (t.name + ' ' + t.id + ' ' + (t.description || '')).toLowerCase().indexOf(f) >= 0;
    }).forEach(function (t) {
      const usable = !!o && t.compatibleProducts.some(function (p) { return o.products.indexOf(p) >= 0; });
      list.append(h('div', {
        class: 'palette-item' + (usable ? '' : ' disabled'), draggable: usable && !simMode,
        onmouseenter: function (e) { showTaskTip(e.currentTarget, t, o, usable); },
        onmouseleave: hideTaskTip,
        ondragstart: function (e) { hideTaskTip(); startDrag(e, { kind: 'task', id: t.id }); }, ondragend: endDrag
      },
        h('div', { class: 'pi-name' }, t.name),
        h('div', { class: 'pi-meta' },
          h('span', { class: 'badge ' + t.type }, t.type),
          h('span', { class: 'badge' }, t.callMode === 'perOffer' ? '1×N' : '1×prod'))));
    });
  }

  /* tooltip del task: descrizione, modalità e prodotti compatibili (in verde quelli presenti nell'offerta) */
  let taskTip = null;
  function hideTaskTip() { if (taskTip) { taskTip.remove(); taskTip = null; } }
  function showTaskTip(anchor, t, o, usable) {
    hideTaskTip();
    const inOffer = function (pid) { return !!o && o.products.indexOf(pid) >= 0; };
    taskTip = h('div', { class: 'task-tip' },
      h('div', { class: 'tt-title' }, t.name),
      t.description ? h('div', { class: 'tt-desc' }, t.description) : null,
      h('div', { class: 'tt-row' }, h('b', null, 'Tipo: '), (t.type === 'async' ? 'asincrono (callback)' : 'sincrono') + ' · ' + (t.callMode === 'perOffer' ? '1 chiamata per N prodotti' : '1 chiamata per prodotto')),
      h('div', { class: 'tt-row' }, h('b', null, 'Prodotti compatibili:'),
        h('div', { class: 'tt-prods' }, t.compatibleProducts.map(function (pid) {
          return h('span', { class: 'tt-prod' + (inOffer(pid) ? ' on' : '') }, (inOffer(pid) ? '✓ ' : '') + pname(pid));
        }))),
      t.api ? h('div', { class: 'tt-row' }, h('code', null, t.api.method + ' ' + t.api.path)) : null,
      usable ? null : h('div', { class: 'tt-warn' }, 'Nessun prodotto compatibile nell\'offerta'));
    document.body.appendChild(taskTip);
    const r = anchor.getBoundingClientRect(), w = taskTip.offsetWidth;
    taskTip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    taskTip.style.top = (r.bottom + 6) + 'px';
  }

  /* ---------- griglia ---------- */
  function simulate(o) {
    return Simulator.run(data, o, simOutcomes[o.id] || {}, ensureScenario(o), { recoverAfterLoop: !!simRecover[o.id] });
  }

  /* Riferimenti a pratica e output usati dalle condizioni dell'offerta (blocchi e instradamenti). */
  function conditionLefts(o) {
    const lefts = [];
    const add = function (when) { if (Conditions.isActive(when)) when.clauses.forEach(function (c) { if (c.left && lefts.indexOf(c.left) < 0) lefts.push(c.left); }); };
    o.blocks.forEach(function (b) { add(b.config.when); });
    o.gates.forEach(function (g) { g.rules.forEach(function (r) { if (r.type === 'ROUTE') add(r.when); }); });
    return lefts;
  }

  /* Dati dello scenario: parte da ciò che l'utente ha scritto e aggiunge i campi letti dalle condizioni (vuoti). */
  function ensureScenario(o) {
    const sc = simScenario[o.id] = simScenario[o.id] || { practice: {}, outputs: {} };
    conditionLefts(o).forEach(function (left) {
      const k = Conditions.leftKind(left);
      const type = Conditions.leftType(data, o, left);
      const blank = type === 'number' || type === 'integer' ? 0 : type === 'boolean' ? false : type === 'array' ? [] : '';
      if (k.kind === 'path' && Fields.getPath(sc.practice, k.path) === undefined) Fields.setPath(sc.practice, k.path, blank);
      if (k.kind === 'result') {
        const src = Fields.resolveBlock(o, k.ref);
        if (src) {
          sc.outputs[src.id] = sc.outputs[src.id] || {};
          if (Fields.getPath(sc.outputs[src.id], k.field) === undefined) Fields.setPath(sc.outputs[src.id], k.field, blank);
        }
      }
    });
    return sc;
  }

  const PRODUCT_STATUS = { OK: ['✔ completato', 'ok'], KO: ['✖ escluso', 'ko'], PENDING: ['⏸ in attesa', 'pending'], STOPPED: ['⛔ fermato', 'ko'] };
  const VERDICT_LABEL = { PASS: '➜ passa', WAIT: '⏸ attesa', STOP: '⛔ stop', ROUTE: '↩ ritorna', NONE: '⛔ nessun prodotto', SKIPPED: '⤳ saltato' };

  function renderBoard() {
    const board = $('board'); board.innerHTML = '';
    board.className = 'board' + (simMode ? ' sim' : '') + (selection && !simMode ? ' focus' : '');
    const o = offer();
    lastSim = null;
    if (!o) {
      board.style.gridTemplateColumns = '1fr'; board.style.gridTemplateRows = 'auto';
      board.append(h('div', { class: 'empty' }, 'Nessuna offerta. Crea una nuova offerta con "+ Nuova".'));
      return;
    }
    if (simMode) lastSim = simulate(o);
    const prods = o.products, n = Math.max(prods.length, 1);
    const refSet = function (list, type) { return new Set(list.filter(function (e) { return e.ref && e.ref.type === type; }).map(function (e) { return e.ref.id; })); };
    const errBlocks = refSet(validation.errors, 'block'), warnBlocks = refSet(validation.warnings, 'block');
    const errGates = refSet(validation.errors, 'gate');

    const L = Model.layout(o);
    const nLv = o.blocks.length + o.gates.length ? L.lanes : 0;
    const focusSel = !!(selection && !simMode);
    const cols = ['170px'];
    for (let k = 0; k < nLv; k++) {
      const onlyGates = L.levels[k].every(function (id) { return Model.isGate(o, id); });
      cols.push(onlyGates ? (focusSel ? '170px' : '135px') : (focusSel ? '250px' : '200px'));
    }
    cols.push(nLv ? '110px' : '240px');     // ultima colonna: rilascia qui per mettere in coda
    board.style.gridTemplateColumns = cols.join(' ');
    const addCol = nLv + 2;

    // ogni riga prodotto ha tante sotto-righe quante sono le corsie usate dai rami
    const sub = [];
    for (let r = 0; r < n; r++) sub.push(Math.max(1, L.laneCount[r] || 1));
    const rowStart = [];
    let totalRows = 0;
    sub.forEach(function (x) { rowStart.push(2 + totalRows); totalRows += x; });
    const grid = { sub: sub, rowStart: rowStart };
    board.style.gridTemplateRows = 'auto repeat(' + totalRows + ', minmax(' + (simMode ? 112 : 92) + 'px, auto))';

    board.append(h('div', { class: 'corner', style: { gridRow: 1, gridColumn: 1 } }, 'Prodotti'));
    board.append(h('div', { class: 'col-head', style: { gridRow: 1, gridColumn: addCol }, title: 'Rilascia qui un task o un gate per metterlo in coda alla riga del prodotto' }, nLv ? '＋ in coda' : 'Trascina qui il primo task'));
    for (let k = 0; k < nLv; k++) board.append(h('div', { class: 'col-head', style: { gridRow: 1, gridColumn: 2 + k } }, String(k + 1)));

    prods.forEach(function (pid, r) {
      for (let c = 0; c <= nLv; c++) {
        board.append(h('div', {
          class: 'cell' + (r % 2 ? ' odd' : '') + (c === nLv ? ' tail' : ''),
          style: { gridRow: rowStart[r] + ' / span ' + sub[r], gridColumn: String(2 + c) },
          ondragover: allowDrop, ondragleave: leaveDrop, ondrop: function (e) { dropOnCell(e, pid, c); }
        }));
      }
    });

    L.placements.forEach(function (pl) {
      (pl.kind === 'block' ? renderBlock(o, pl, errBlocks, warnBlocks, grid) : renderGate(o, pl, errGates, grid)).forEach(function (el) { board.append(el); });
    });

    prods.forEach(function (pid, r) {
      let badge = null;
      if (simMode && lastSim) {
        const ps = PRODUCT_STATUS[lastSim.productStatus[pid]] || PRODUCT_STATUS.OK;
        badge = h('div', { class: 'prod-status ' + ps[1] }, ps[0]);
      }
      board.append(h('div', { class: 'prod-label' + (r % 2 ? ' odd' : ''), style: { gridRow: rowStart[r] + ' / span ' + sub[r], gridColumn: 1 } },
        h('div', { class: 'prod-name' }, pname(pid)),
        simMode ? badge : h('div', { class: 'prod-actions' },
          h('button', { class: 'icon', title: 'Su', disabled: r === 0, onclick: function () { moveProduct(pid, -1); } }, '▲'),
          h('button', { class: 'icon', title: 'Giù', disabled: r === prods.length - 1, onclick: function () { moveProduct(pid, 1); } }, '▼'),
          h('button', { class: 'icon danger', title: 'Rimuovi dall\'offerta', onclick: function () { removeProduct(pid); } }, '×'))));
    });

    if (!prods.length) board.append(h('div', { class: 'empty-row', style: { gridRow: 2, gridColumn: '1 / -1' } }, 'L\'offerta non ha prodotti: aggiungili dalla barra in alto ("+ Aggiungi prodotto…").'));
    drawArrows();
  }

  /* Ruolo di un nodo rispetto a quello selezionato: 'parent' (da cui dipende), 'child' (dipende da lui) oppure 'other'; null senza selezione. */
  function roleToSelection(id) {
    if (!selection || simMode) return null;
    if (selection.id === id) return 'self';
    const o = offer();
    const sel = o && Model.node(o, selection.id);
    const me = o && Model.node(o, id);
    if (!sel || !me) return null;
    if ((sel.dependsOn || []).indexOf(id) >= 0) return 'parent';
    if ((me.dependsOn || []).indexOf(sel.id) >= 0) return 'child';
    return 'other';
  }

  /* Frecce tra il nodo selezionato, i suoi genitori (arancioni) e i suoi figli (verdi): overlay SVG calcolato sulle posizioni reali delle schede. */
  function drawArrows() {
    const board = $('board');
    const old = board.querySelector('.rel-arrows');
    if (old) old.remove();
    if (!selection || simMode) return;
    const o = offer();
    const sel = o && Model.node(o, selection.id);
    if (!sel) return;
    const base = board.getBoundingClientRect();
    const cardsOf = function (id) { return Array.prototype.slice.call(board.querySelectorAll('[data-node="' + id + '"]')); };
    const selCards = cardsOf(sel.id);
    if (!selCards.length) return;
    const mid = function (r) { return r.top + r.height / 2; };
    const nearest = function (cards, y) {
      return cards.map(function (c) { return c.getBoundingClientRect(); }).sort(function (a, z) { return Math.abs(mid(a) - y) - Math.abs(mid(z) - y); })[0];
    };
    const paths = [];
    const used = {};
    // gomito ortogonale: esce dal lato destro del genitore, corre nel varco tra le colonne ed entra dal lato sinistro del figlio
    const link = function (from, to, color, marker) {
      const x1 = from.right - base.left, y1 = mid(from) - base.top, x2 = to.left - base.left, y2 = mid(to) - base.top;
      let d;
      if (x2 - x1 < 16) {
        const dx = 30;
        d = 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2;
      } else if (Math.abs(y2 - y1) < 3) {
        d = 'M' + x1 + ',' + y1 + ' L' + (x2 - 2) + ',' + y2;
      } else {
        const key = Math.round((x1 + x2) / 2 / 20);
        const k = used[key] = (used[key] || 0) + 1;
        const gap = x2 - x1;
        const shift = Math.max(-gap / 2 + 14, Math.min(gap / 2 - 14, (k % 2 ? 1 : -1) * Math.ceil((k - 1) / 2) * 8));
        const mx = (x1 + x2) / 2 + shift;
        const sgn = y2 > y1 ? 1 : -1;
        const r = Math.min(10, Math.abs(y2 - y1) / 2, Math.abs(mx - x1), Math.abs(x2 - mx));
        d = 'M' + x1 + ',' + y1 + ' H' + (mx - r) + ' Q' + mx + ',' + y1 + ' ' + mx + ',' + (y1 + sgn * r) +
          ' V' + (y2 - sgn * r) + ' Q' + mx + ',' + y2 + ' ' + (mx + r) + ',' + y2 + ' H' + (x2 - 2);
      }
      paths.push('<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" marker-end="url(#' + marker + ')"/>' +
        '<circle cx="' + x1 + '" cy="' + y1 + '" r="4.5" fill="' + color + '" stroke="#fff" stroke-width="1.5"/>');
    };
    (sel.dependsOn || []).forEach(function (d) {
      const pc = cardsOf(d); if (!pc.length) return;
      const to = nearest(selCards, mid(pc[0].getBoundingClientRect()));
      link(nearest(pc, mid(to)), to, '#e07b39', 'arr-o');
    });
    Model.nodes(o).filter(function (x) { return (x.dependsOn || []).indexOf(sel.id) >= 0; }).forEach(function (ch) {
      const cc = cardsOf(ch.id); if (!cc.length) return;
      const from = nearest(selCards, mid(cc[0].getBoundingClientRect()));
      link(from, nearest(cc, mid(from)), '#2e8b57', 'arr-g');
    });
    if (!paths.length) return;
    const w = board.scrollWidth, hh = board.scrollHeight;
    board.insertAdjacentHTML('beforeend', '<svg class="rel-arrows" xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + hh + '" viewBox="0 0 ' + w + ' ' + hh + '"><defs>' +
      '<marker id="arr-o" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#e07b39"/></marker>' +
      '<marker id="arr-g" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#2e8b57"/></marker></defs>' + paths.join('') + '</svg>');
  }

  /* Righe della griglia occupate da un nodo tra le righe prodotto rs..re: con una sola corsia tutta la riga, altrimenti le sue sotto-righe. */
  function rowsOf(pl, grid, from, to) {
    const full = function (r) { return !(pl.laneCount[r] > 1); };
    const top = function (r) { return full(r) ? 0 : pl.rankTop[r]; };
    const bot = function (r) { return full(r) ? grid.sub[r] - 1 : pl.rankBot[r]; };
    return { top: top, bot: bot, span: (grid.rowStart[from] + top(from)) + ' / ' + (grid.rowStart[to] + bot(to) + 1) };
  }

  function renderBlock(o, pl, errBlocks, warnBlocks, grid) {
    const b = pl.block, t = Model.task(data, b.taskId);
    const c = b.config;
    const sel = selection && selection.type === 'block' && selection.id === b.id;
    const inOffer = b.products.filter(function (pid) { return o.products.indexOf(pid) >= 0; });
    const depNames = b.dependsOn.map(function (d) { return Model.nodeName(data, o, d); });
    const role = roleToSelection(b.id);

    // Un blocco occupa per intero la riga prodotto se la riga ha una sola corsia; altrimenti sta nelle sotto-righe della sua corsia
    // (più corsie per un join). Le righe adiacenti si fondono in una sola scheda solo se i bordi combaciano.
    const idx = inOffer.map(function (pid) { return o.products.indexOf(pid); }).sort(function (a, z) { return a - z; });
    const inSet = {};
    idx.forEach(function (i) { inSet[i] = true; });
    const rr = rowsOf(pl, grid, pl.rs, pl.re);
    const runs = [];
    for (let r = pl.rs; r <= pl.re; r++) {
      const card = !idx.length || !!inSet[r];
      const last = runs[runs.length - 1];
      if (last && last.card === card && rr.bot(r - 1) === grid.sub[r - 1] - 1 && rr.top(r) === 0) {
        last.end = r;
        if (card && inSet[r]) last.products.push(o.products[r]);
      } else runs.push({ card: card, start: r, end: r, products: card && inSet[r] ? [o.products[r]] : [] });
    }
    const rows = function (g) { return rowsOf(pl, grid, g.start, g.end).span; };
    const cards = runs.filter(function (g) { return g.card; });

    const col = String(2 + pl.lane);
    const out = [];
    runs.forEach(function (g) {
      if (!g.card) {
        // ponte tratteggiato nelle righe dei prodotti esclusi: stessa larghezza delle schede, le unisce
        out.push(h('div', {
          class: 'block-bridge' + (sel ? ' selected' : '') + (role === 'other' ? ' dimmed' : '') + (t && t.type === 'async' ? ' async' : ''),
          style: { gridRow: rows(g), gridColumn: col },
          title: 'Stesso blocco ' + (t ? t.name : b.taskId) + ': non include ' + o.products.slice(g.start, g.end + 1).map(pname).join(', ')
        }));
        return;
      }
      const first = g === cards[0];
      const cls = ['block'];
      if (sel) cls.push('selected');
      if (first) { if (errBlocks.has(b.id)) cls.push('has-error'); else if (warnBlocks.has(b.id)) cls.push('has-warning'); }
      else cls.push('continued');
      if (t && t.type === 'async') cls.push('async');
      const cond = Conditions.isActive(c.when);
      if (cond) cls.push('conditional');
      if (role === 'parent' || role === 'child') cls.push('rel-' + role);
      else if (role === 'other') cls.push('dimmed');
      const isJoin = b.dependsOn.length > 1;
      const detached = lastSim && lastSim.blocks[b.id] && lastSim.blocks[b.id].detached;
      const showProducts = g.products.length && (!simMode && (inOffer.length > 1));
      out.push(h('div', {
        class: cls.join(' '), 'data-node': b.id,
        style: { gridRow: rows(g), gridColumn: col },
        title: cards.length > 1 ? 'Stesso blocco su ' + inOffer.map(pname).join(', ') : null,
        draggable: !simMode,
        ondragstart: function (e) { e.stopPropagation(); startDrag(e, { kind: 'block', id: b.id }); },
        ondragend: endDrag,
        onclick: function (e) { if (/SELECT|OPTION/.test(e.target.tagName)) return; select('block', b.id); }
      },
        h('div', { class: 'block-title' }, t ? t.name : b.taskId + ' (?)'),
        first ? h('div', { class: 'block-badges' },
          isJoin ? h('span', { class: 'bb join', title: 'Parte quando tutti i nodi da cui dipende hanno finito' }, '⋈ JOIN') : null,
          inOffer.length > 1 ? h('span', { class: 'bb' }, c.callMode === 'perOffer' ? '1 chiamata × ' + inOffer.length : inOffer.length + ' chiamate') : null,
          t && t.type === 'async' ? h('span', { class: 'bb' }, 'async') : null,
          Number(c.retry.count) > 0 ? h('span', { class: 'bb' }, 'retry ' + c.retry.count) : null,
          c.koTask.enabled && t && t.outcomes.indexOf('KO_TASK') >= 0 ? h('span', { class: 'bb' }, 'KO→task') : null,
          c.onKo === 'IGNORE' ? h('span', { class: 'bb' }, 'KO non bloccante') : null,
          detached ? h('span', { class: 'bb', title: 'Un gate ha "Non attendere" su questo blocco' }, '⏩ non atteso') : null,
          cond ? h('span', { class: 'bb cond', title: 'Eseguito solo se ' + Conditions.describe(data, o, c.when) }, 'SE …') : null,
          c.notify.onOk || c.notify.onKo ? h('span', { class: 'bb' }, '✉') : null) : h('div', { class: 'block-cont' }, '↑ stesso blocco'),
        first && depNames.length ? h('div', { class: 'block-deps' }, '↳ dopo ' + depNames.join(', ')) : null,
        showProducts ? h('div', { class: 'block-products' }, g.products.map(function (pid) { return h('span', { class: 'mini on' }, pname(pid)); })) : null,
        simMode ? simControls(o, b, t, g.products) : null));
    });
    return out;
  }

  /* Gate: mattoncino arancione che copre le righe dei prodotti che governa (quelli dei blocchi a monte). */
  function renderGate(o, pl, errGates, grid) {
    const g = pl.gate;
    const sel = selection && selection.type === 'gate' && selection.id === g.id;
    const role = roleToSelection(g.id);
    const st = Model.structure(o);
    const gi = st.top.indexOf(g.id);
    const v = lastSim && lastSim.gates[g.id];
    const cls = ['gatebrick'];
    if (sel) cls.push('selected');
    if (errGates.has(g.id)) cls.push('has-error');
    if (role === 'parent' || role === 'child') cls.push('rel-' + role);
    else if (role === 'other') cls.push('dimmed');
    const routeText = function (r) {
      if (r.to === 'STOP') return '⛔ stop';
      const di = st.top.indexOf(r.to);
      return (di >= 0 && gi >= 0 && di <= gi ? '↩ ' : '⤳ ') + Model.nodeName(data, o, r.to);
    };
    const chips = g.rules.map(function (r) {
      const label = r.type === 'ROUTE' ? routeText(r) : RT[r.type] ? RT[r.type].short : r.type;
      return h('span', { class: 'gb' + (r.type === 'ROUTE' ? ' route' : '') }, label);
    });
    return [h('div', {
      class: cls.join(' '), 'data-node': g.id,
      style: { gridRow: rowsOf(pl, grid, pl.rs, pl.re).span, gridColumn: String(2 + pl.lane) },
      title: (g.note ? g.note + '\n' : '') + (g.rules.map(function (r) { return Model.ruleText(data, o, r); }).join('\n') || 'Nessuna regola: passano solo i prodotti OK'),
      draggable: !simMode,
      ondragstart: function (e) { e.stopPropagation(); startDrag(e, { kind: 'gatenode', id: g.id }); },
      ondragend: endDrag,
      onclick: function () { select('gate', g.id); }
    },
      h('div', { class: 'gate-title' }, '⛩ GATE'),
      h('div', { class: 'gate-chips' }, chips.length ? chips : h('span', { class: 'gb muted' }, 'solo OK')),
      g.dependsOn.length > 1 ? h('div', { class: 'gate-deps' }, 'attende ' + g.dependsOn.map(function (d) { return Model.nodeName(data, o, d); }).join(' + ')) : null,
      v ? h('div', { class: 'verdict v-' + String(v.verdict).toLowerCase(), title: v.text }, VERDICT_LABEL[v.verdict] || v.verdict) : null)];
  }

  const OUT_LABEL = { OK: 'OK', KO: 'KO', KO_TASK: 'KO + task', PENDING: 'In attesa' };
  const EFF_LABEL = { SKIPPED: 'non eseguito (dip. KO)', SKIPPED_BY_CONDITION: 'saltato (condizione)', WAITING: 'attende dipendenza', NOT_ACTIVE: 'escluso prima', KO_IGNORED: 'KO ignorato' };

  function simControls(o, b, t, inOffer) {
    const entry = lastSim && lastSim.blocks[b.id];
    const res = entry && entry.results || {};
    return h('div', { class: 'sim-ctrl' }, inOffer.map(function (pid) {
      const chosen = ((simOutcomes[o.id] || {})[b.id] || {})[pid] || 'OK';
      const opts = ['OK'];
      if (!t || t.outcomes.indexOf('KO') >= 0) opts.push('KO');
      if (t && t.outcomes.indexOf('KO_TASK') >= 0 && b.config.koTask.enabled) opts.push('KO_TASK');
      opts.push('PENDING');
      const eff = res[pid];
      const reached = !!entry && !entry.skipped && entry.reached.indexOf(pid) >= 0;
      return h('div', { class: 'sim-row' + (reached ? '' : ' unreached') },
        h('span', { class: 'sim-p' }, pname(pid)),
        h('select', { class: 'sim-sel o-' + chosen.toLowerCase(), value: chosen, onchange: function (e) { setOutcome(o.id, b.id, pid, e.target.value); } },
          opts.map(function (x) { return h('option', { value: x }, OUT_LABEL[x]); })),
        eff && EFF_LABEL[eff] ? h('span', { class: 'sim-eff' }, EFF_LABEL[eff]) : (!reached ? h('span', { class: 'sim-eff' }, 'non raggiunto') : null));
    }));
  }

  /* ---------- drag & drop ---------- */
  function startDrag(e, payload) {
    dragPayload = payload;
    e.dataTransfer.effectAllowed = payload.kind === 'task' || payload.kind === 'gate' ? 'copy' : 'move';
    e.dataTransfer.setData('text/plain', payload.id || payload.kind);
    setTimeout(function () { $('board').classList.add('dragging'); }, 0);
  }
  function endDrag() {
    dragPayload = null;
    $('board').classList.remove('dragging');
    Array.prototype.forEach.call(document.querySelectorAll('.drop-over'), function (el) { el.classList.remove('drop-over'); });
  }
  function allowDrop(e) {
    if (!dragPayload || simMode) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragPayload.kind === 'task' || dragPayload.kind === 'gate' ? 'copy' : 'move';
    e.currentTarget.classList.add('drop-over');
  }
  function leaveDrop(e) { e.currentTarget.classList.remove('drop-over'); }

  /* Nodi della riga di un prodotto nella colonna più vicina a sinistra di `col`: da questi parte ciò che si rilascia. */
  function anchorsFor(o, pid, col) {
    const covers = Model.layout(o).placements.filter(function (p) {
      if (p.lane >= col) return false;
      return p.products.indexOf(pid) >= 0;
    });
    if (!covers.length) return [];
    const best = Math.max.apply(null, covers.map(function (p) { return p.lane; }));
    return covers.filter(function (p) { return p.lane === best; }).map(function (p) { return p.id; });
  }

  function dropOnCell(e, pid, col) {
    e.preventDefault();
    const p = dragPayload; endDrag();
    if (!p) return;
    const o = offer();
    const anchors = anchorsFor(o, pid, col);
    if (p.kind === 'gate') return addGateAfter(anchors);
    if (p.kind === 'gatenode') return reparent(p.id, anchors, 'Gate spostato');
    if (p.kind === 'block') return moveBlock(p.id, pid, anchors);
    const t = Model.task(data, p.id);
    if (t.compatibleProducts.indexOf(pid) < 0) return toast(t.name + ' non è compatibile con ' + pname(pid), 'error');
    // stesso task già in questa colonna su un altro prodotto: il prodotto si aggiunge al blocco (una chiamata per N prodotti); Alt = blocco separato
    const same = !e.altKey && Model.layout(o).placements.find(function (pl) { return pl.kind === 'block' && pl.lane === col && pl.block.taskId === t.id && pl.block.products.indexOf(pid) < 0; });
    if (same) {
      same.block.products.push(pid);
      sortProducts(o, same.block);
      toast(pname(pid) + ' aggiunto al blocco condiviso ' + t.name, 'ok');
      selection = { type: 'block', id: same.block.id };
      return commit('all');
    }
    addBlock(t, [pid], anchors);
  }

  /* ---------------- azioni ---------------- */
  function sortProducts(o, b) { b.products.sort(function (a, c) { return o.products.indexOf(a) - o.products.indexOf(c); }); }
  function allIds(o) { return Model.nodes(o).map(function (n) { return n.id; }); }

  function addBlock(t, products, dependsOn) {
    const o = offer();
    const b = { id: Util.uniqueId('B_' + t.id, allIds(o)), taskId: t.id, products: products.slice(), dependsOn: (dependsOn || []).slice(), config: Model.defaultBlockConfig(t) };
    sortProducts(o, b);
    o.blocks.push(b);
    selection = { type: 'block', id: b.id };
    commit('all');
  }

  /* Toglie un nodo e ricollega chi ne dipendeva ai suoi genitori; ripulisce le regole che lo citano. */
  function removeNode(id) {
    const o = offer();
    const n = Model.node(o, id);
    if (!n) return;
    const deps = (n.dependsOn || []).slice();
    Model.nodes(o).forEach(function (x) {
      if (x.id === id || (x.ref.dependsOn || []).indexOf(id) < 0) return;
      const next = x.ref.dependsOn.filter(function (d) { return d !== id; });
      deps.forEach(function (d) { if (next.indexOf(d) < 0) next.push(d); });
      x.ref.dependsOn = next;
    });
    o.gates.forEach(function (g) {
      g.rules = g.rules.filter(function (r) { return !(r.type === 'DONT_WAIT' && r.blockId === id); });
      g.rules.forEach(function (r) { if (r.type === 'ROUTE' && r.to === id) r.to = ''; });
    });
    o.blocks = o.blocks.filter(function (b) { return b.id !== id; });
    o.gates = o.gates.filter(function (g) { return g.id !== id; });
    if (simOutcomes[o.id]) delete simOutcomes[o.id][id];
  }

  /* Cambia da chi dipende un nodo (senza creare cicli). */
  function reparent(id, anchors, msg) {
    const o = offer();
    const n = Model.node(o, id);
    if (!n) return;
    const deps = anchors.filter(function (a) { return a !== id && Model.canDepend(o, id, a); });
    n.dependsOn = deps;
    selection = { type: Model.isGate(o, id) ? 'gate' : 'block', id: id };
    toast((msg || 'Spostato') + (deps.length ? ': dopo ' + deps.map(function (d) { return Model.nodeName(data, o, d); }).join(' + ') : ': ora parte all\'inizio'), 'ok');
    commit('all');
  }

  function moveBlock(id, pid, anchors) {
    const o = offer();
    const b = Model.block(o, id);
    if (!b) return;
    const t = Model.task(data, b.taskId);
    if (b.products.indexOf(pid) < 0) {
      if (t && t.compatibleProducts.indexOf(pid) >= 0) {
        b.products.push(pid); sortProducts(o, b);
        toast(pname(pid) + ' aggiunto al blocco', 'ok');
        return commit('all');
      }
      return toast((t ? t.name : b.taskId) + ' non è compatibile con ' + pname(pid), 'error');
    }
    reparent(id, anchors, 'Blocco spostato');
  }

  function removeBlock(id) {
    removeNode(id);
    selection = null;
    commit('all');
  }

  function duplicateBlock(b) {
    const o = offer();
    const nb = Util.clone(b);
    nb.id = Util.uniqueId(b.id, allIds(o));
    o.blocks.push(nb);
    selection = { type: 'block', id: nb.id };
    commit('all');
  }

  /*
   * Aggiunge un gate dopo i nodi indicati. Con un solo nodo il gate si inserisce nel percorso: chi dipendeva da quel nodo
   * ora dipende dal gate. Con più nodi nasce un join; senza nodi un gate scollegato (da collegare dal pannello).
   */
  function addGateAfter(anchors) {
    const o = offer();
    const g = { id: Util.uniqueId('G', allIds(o)), dependsOn: (anchors || []).slice(), note: '', rules: [] };
    if (g.dependsOn.length === 1) {
      const a = g.dependsOn[0];
      Model.nodes(o).forEach(function (x) {
        if (x.ref.dependsOn.indexOf(a) >= 0) x.ref.dependsOn = x.ref.dependsOn.map(function (d) { return d === a ? g.id : d; });
      });
    }
    o.gates.push(g);
    selection = { type: 'gate', id: g.id };
    commit('all');
  }

  function removeGate(id) {
    removeNode(id);
    selection = null;
    commit('all');
  }

  function removeProduct(pid) {
    const o = offer();
    const affected = o.blocks.filter(function (b) { return b.products.indexOf(pid) >= 0; });
    const orphan = affected.filter(function (b) { return b.products.length === 1; });
    if (affected.length && !confirm('Rimuovere ' + pname(pid) + ' dall\'offerta?\n' + affected.length + ' blocchi lo usano' + (orphan.length ? ', ' + orphan.length + ' resteranno vuoti e saranno eliminati.' : '.'))) return;
    o.products = o.products.filter(function (p) { return p !== pid; });
    affected.forEach(function (b) { b.products = b.products.filter(function (p) { return p !== pid; }); });
    orphan.forEach(function (b) { removeNode(b.id); });
    o.gates.forEach(function (g) { g.rules.forEach(function (r) { if (r.products) r.products = r.products.filter(function (p) { return p !== pid; }); }); });
    if (selection && selection.type === 'block' && !o.blocks.some(function (b) { return b.id === selection.id; })) selection = null;
    commit('all');
  }

  function moveProduct(pid, dir) {
    const o = offer();
    const i = o.products.indexOf(pid), j = i + dir;
    if (j < 0 || j >= o.products.length) return;
    o.products[i] = o.products[j]; o.products[j] = pid;
    o.blocks.forEach(function (b) { sortProducts(o, b); });
    commit('all');
  }

  function newOffer() {
    const name = prompt('Nome della nuova offerta');
    if (!name) return;
    const id = Util.uniqueId('OFF_' + Util.slug(name), data.offers.map(function (o) { return o.id; }));
    data.offers.push({ id: id, name: name, description: '', products: [], blocks: [], gates: [] });
    offerId = id; selection = null;
    Store.save(data); render();
  }

  function duplicateOffer() {
    const o = offer();
    const c = Util.clone(o);
    c.id = Util.uniqueId(o.id + '_COPIA', data.offers.map(function (x) { return x.id; }));
    c.name = o.name + ' (copia)';
    data.offers.push(c);
    offerId = c.id; selection = null;
    Store.save(data); render();
  }

  function deleteOffer() {
    const o = offer();
    if (!confirm('Eliminare l\'offerta "' + o.name + '"?')) return;
    data.offers = data.offers.filter(function (x) { return x !== o; });
    offerId = data.offers.length ? data.offers[0].id : null; selection = null;
    Store.save(data); render();
  }

  function toggleSim() { simMode = !simMode; render(); }

  function paintSimButton() {
    const b = $('btn-sim');
    b.classList.toggle('active', simMode);
    b.textContent = simMode ? '■ Esci dalla simulazione' : '▶ Simulazione';
  }

  function setOutcome(oid, bid, pid, val) {
    simOutcomes[oid] = simOutcomes[oid] || {};
    simOutcomes[oid][bid] = simOutcomes[oid][bid] || {};
    simOutcomes[oid][bid][pid] = val;
    renderBoard(); renderSimLog();
  }

  function randomScenario() {
    const o = offer();
    const s = simOutcomes[o.id] = {};
    o.blocks.forEach(function (b) {
      const t = Model.task(data, b.taskId);
      s[b.id] = {};
      b.products.forEach(function (pid) {
        const r = Math.random();
        let v = r < 0.72 ? 'OK' : r < 0.86 ? 'KO' : r < 0.94 ? 'PENDING' : 'KO_TASK';
        if (v === 'KO_TASK' && !(t && t.outcomes.indexOf('KO_TASK') >= 0 && b.config.koTask.enabled)) v = 'KO';
        s[b.id][pid] = v;
      });
    });
    renderBoard(); renderSimLog();
  }

  /* ---------------- pannello laterale ---------------- */
  function field(label, control, hint) {
    return h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), control, hint ? h('div', { class: 'field-hint' }, hint) : null);
  }
  function section(title) {
    return h('div', { class: 'psection' }, h('h4', null, title), Array.prototype.slice.call(arguments, 1));
  }
  function issuesFor(type, id) {
    if (!validation) return null;
    const m = function (e) { return e.ref && e.ref.type === type && e.ref.id === id; };
    const list = validation.errors.filter(m).map(function (e) { return h('div', { class: 'msg error' }, '✖ ' + e.msg); })
      .concat(validation.warnings.filter(m).map(function (e) { return h('div', { class: 'msg warning' }, '⚠ ' + e.msg); }));
    return list.length ? h('div', { class: 'issues' }, list) : null;
  }
  function toggleIn(arr, v, on) { const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); }

  function renderPanel() {
    const p = $('panel'); p.innerHTML = '';
    const o = offer();
    if (!o) { p.append(h('div', { class: 'muted pad' }, 'Nessuna offerta selezionata.')); return; }
    if (selection && selection.type === 'block') {
      const b = o.blocks.find(function (x) { return x.id === selection.id; });
      if (b) return p.append(blockPanel(o, b));
    }
    if (selection && selection.type === 'gate') {
      const g = o.gates.find(function (x) { return x.id === selection.id; });
      if (g) return p.append(gatePanel(o, g));
    }
    selection = null;
    p.append(offerPanel(o));
  }

  function offerPanel(o) {
    const v = validation;
    const item = function (cls, icon) {
      return function (e) {
        return h('div', { class: 'msg ' + cls + (e.ref && e.ref.type !== 'offer' ? ' clickable' : ''), onclick: function () { if (e.ref && (e.ref.type === 'block' || e.ref.type === 'gate')) select(e.ref.type, e.ref.id); } }, icon + ' ' + e.msg);
      };
    };
    return h('div', null,
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-kicker' }, 'Offerta'), h('h3', null, o.name), h('div', { class: 'muted' }, o.id)),
      section('Dati offerta',
        field('Nome', h('input', { type: 'text', value: o.name, onchange: function (e) { o.name = e.target.value || o.name; commit('all'); } })),
        field('Descrizione', h('textarea', { rows: 2, value: o.description || '', onchange: function (e) { o.description = e.target.value; Store.save(data); } }))),
      section('Riepilogo',
        h('div', { class: 'kpis' },
          kpi(o.products.length, 'prodotti'), kpi(o.blocks.length, 'blocchi'), kpi(o.gates.length, 'gate'),
          kpi(new Set(o.blocks.map(function (b) { return b.taskId; })).size, 'servizi'))),
      section('Validazione',
        v.ok && !v.warnings.length ? h('div', { class: 'msg ok' }, '✔ Nessun problema rilevato') : null,
        v.errors.map(item('error', '✖')), v.warnings.map(item('warning', '⚠')), v.infos.map(item('info', 'ℹ'))),
      section('Come si usa',
        h('ul', { class: 'help' },
          h('li', null, 'Righe = prodotti dell\'offerta, colonne = ordine di esecuzione (calcolato dalle dipendenze, senza step fissi).'),
          h('li', null, 'Trascina i task dalla palette su una riga: partono dopo il nodo che li precede su quella riga; un blocco può coprire più prodotti.'),
          h('li', null, 'Nodi senza dipendenze, o con lo stesso genitore, sono paralleli (rami); "Dopo" nel pannello li mette in sequenza o li riunisce (join).'),
          h('li', null, 'I gate arancioni sono mattoncini come gli altri: uno solo per un ramo oppure un join dei rami; contengono le regole (solo OK, stop, ritorno/salto, non attendere).'),
          h('li', null, 'Il DSL esprime solo sequenze e rami paralleli: rami che si incrociano vanno riuniti con un gate.'),
          h('li', null, '"▶ Simulazione" per provare gli esiti, "⚙ Execution Plan" per generare l\'output per i team backend.'))));
  }

  function kpi(v, l) { return h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, String(v)), h('div', { class: 'kpi-l' }, l)); }

  /* Mappatura degli input del blocco: ogni input ha una sorgente (pratica, output di un blocco precedente, sistema o valore fisso) con stato. */
  const STATUS_ICON = { none: '○', ok: '✔', fixed: '＝', warn: '⚠', error: '✖' };
  let mapFilter = '', mapOnlyOpen = false;

  function mappingSection(o, b, t) {
    const c = b.config;
    const src = Fields.sources(data, o, b);
    const listId = 'map-src-' + b.id;
    const opt = function (s, group) { return h('option', { value: s.path, label: group + (s.label ? ' · ' + s.label : '') }); };
    const datalist = h('datalist', { id: listId },
      src.practice.map(function (s) { return opt(s, 'pratica'); }),
      src.lists.map(function (s) { return opt(s, 'lista'); }),
      src.results.map(function (s) { return opt(s, 'output'); }),
      src.system.map(function (s) { return opt(s, 'sistema'); }));
    // dentro una lista servono anche i campi dell'elemento (@.campo) e i dati del prodotto corrente
    const rowList = function (i) {
      if (!Fields.hasList(i.name)) return { id: listId, el: null };
      const s = Fields.sources(data, o, b, i);
      const id = listId + '-' + i.name.replace(/\W/g, '_');
      return { id: id, el: h('datalist', { id: id },
        s.items.map(function (x) { return opt(x, 'elemento'); }), s.perProduct.map(function (x) { return opt(x, 'prodotto'); }),
        s.practice.map(function (x) { return opt(x, 'pratica'); }), s.lists.map(function (x) { return opt(x, 'lista'); }),
        s.results.map(function (x) { return opt(x, 'output'); }), s.system.map(function (x) { return opt(x, 'sistema'); })) };
    };
    const statusOf = function (i) { return Fields.status(data, o, b, i); };
    const total = t.inputs.length;
    const open = t.inputs.filter(function (i) { return statusOf(i).level === 'none'; }).length;
    const q = function () { return mapFilter.trim().toLowerCase(); };
    const MAX_ROWS = 60;
    const listEl = h('div', { class: 'map-list' });
    const fill = function () {
      const f = q();
      const rows = t.inputs.filter(function (i) {
        if (mapOnlyOpen && statusOf(i).level !== 'none') return false;
        return !f || i.name.toLowerCase().indexOf(f) >= 0 || String(c.inputMapping[i.name] || '').toLowerCase().indexOf(f) >= 0;
      });
      listEl.innerHTML = '';
      rows.slice(0, MAX_ROWS).forEach(function (i) { const rl = rowList(i); if (rl.el) listEl.append(rl.el); listEl.append(mappingRow(i, c, statusOf, rl.id)); });
      if (rows.length > MAX_ROWS) listEl.append(h('div', { class: 'muted' }, 'Altri ' + (rows.length - MAX_ROWS) + ' input: usa il filtro per cercarli.'));
      if (!rows.length) listEl.append(h('div', { class: 'muted' }, total ? 'Nessun input corrisponde al filtro.' : 'Nessun input definito nel catalogo.'));
    };
    fill();
    const hasLists = t.inputs.some(function (i) { return Fields.isListRow(i.name); });
    return h('div', { class: 'psection' },
      h('h4', null, 'Input', total ? h('span', { class: 'muted' }, ' · ' + (total - open) + '/' + total + ' mappati') : null),
      total > 8 ? h('div', { class: 'map-tools' },
        h('input', { type: 'search', placeholder: 'Filtra input…', value: mapFilter, oninput: function (e) { mapFilter = e.target.value; fill(); } }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: mapOnlyOpen, onchange: function (e) { mapOnlyOpen = e.target.checked; fill(); } }), 'solo non mappati')) : null,
      total ? h('button', { class: 'small', title: 'Mappa gli input vuoti con i campi della pratica o degli output precedenti che hanno lo stesso nome (solo se univoci)', onclick: function () {
        const done = Fields.autoMap(data, o, b, t);
        commit('all');
        toast(done.length ? done.length + ' input mappati automaticamente' : 'Nessuna corrispondenza univoca trovata');
      } }, '⚡ Mappa automaticamente') : null,
      datalist, listEl,
      hasLists ? h('details', { class: 'body-preview' }, h('summary', null, 'Struttura del body inviato'),
        h('pre', { class: 'json' }, JSON.stringify(Fields.bodyShape(t, c.inputMapping), null, 2)),
        h('div', { class: 'field-hint' }, 'Le liste hanno un elemento per ogni prodotto o per ogni elemento della lista d\'origine; qui è mostrato un solo elemento d\'esempio con la sorgente di ogni campo.')) : null,
      h('div', { class: 'field-hint' }, 'Sorgente: campo della pratica (es. cliente.codiceFiscale), output di un blocco già eseguito (esiti.<blocco>.<campo>), sorgente di sistema (offerta.prodotti, prodotto.id) oppure valore fisso. Liste: la riga della lista indica l\'origine (offerta.prodotti = un elemento per prodotto, oppure es. pratica.spedizioni[]); dentro la lista @.campo è un campo dell\'elemento e prodotti.{prodotto}.campo il dato del prodotto.'));
  }

  function mappingRow(i, c, statusOf, listId) {
    const icon = h('span', { class: 'map-status' });
    const paint = function () { const st = statusOf(i); icon.className = 'map-status ' + st.level; icon.textContent = STATUS_ICON[st.level]; icon.title = st.msg; };
    paint();
    const isList = Fields.isListRow(i.name);
    const depth = (i.name.match(/\[\]/g) || []).length - (isList ? 1 : 0);
    return h('div', { class: 'map-row' + (isList ? ' map-list-row' : ''), style: depth ? { marginLeft: depth * 14 + 'px' } : null },
      h('div', { class: 'map-name' }, isList ? h('span', { class: 'bb list-badge' }, 'lista') : null, h('code', null, i.name), i.required ? h('span', { class: 'req' }, ' *') : null, h('span', { class: 'muted map-type' }, ' ' + (i.type || 'string'))),
      h('div', { class: 'map-input' },
        h('input', { type: 'text', list: listId, value: c.inputMapping[i.name] || '', placeholder: isList ? 'origine: offerta.prodotti o un campo lista (es. pratica.spedizioni[])' : (Fields.hasList(i.name) ? '@.campo, prodotto.id, prodotti.{prodotto}.campo o valore fisso' : 'campo, esiti.<blocco>.<campo> o valore fisso'), onchange: function (e) { c.inputMapping[i.name] = e.target.value.trim(); paint(); commit('board'); } }),
        icon));
  }

  /* Editor di una condizione `holder[key]`: righe riferimento / operatore / valore, unite da E oppure OPPURE.
   * ctx = { block } per un blocco, { gate: id } per un gate: decide quali riferimenti sono disponibili. */
  function conditionEditor(o, holder, key, ctx, required) {
    const when = holder[key];
    const refs = Conditions.references(data, o, ctx);
    const groups = [['Dati della pratica', refs.practice], ['Esito di un blocco', refs.outcomes], ['Output di un blocco', refs.results], ['Sistema', refs.system]];
    const known = function (path) { return groups.some(function (g) { return g[1].some(function (x) { return x.path === path; }); }); };
    const clauses = when && when.clauses || [];
    const ensure = function () { if (!holder[key]) holder[key] = Conditions.emptyWhen(); return holder[key]; };
    const refSelect = function (c) {
      return h('select', { class: 'cond-ref', value: c.left || '', onchange: function (e) {
        c.left = e.target.value;
        const isOutcome = Conditions.leftKind(c.left).kind === 'outcome';
        const allowed = Conditions.opsFor(c.left, isOutcome);
        if (allowed.indexOf(c.op) < 0) c.op = allowed[0];
        if (isOutcome && Conditions.OUTCOME_VALUES.indexOf(c.value) < 0) c.value = 'KO';
        commit('all');
      } },
        h('option', { value: '' }, '— riferimento —'),
        c.left && !known(c.left) ? h('option', { value: c.left }, c.left + ' (non disponibile)') : null,
        groups.filter(function (g) { return g[1].length; }).map(function (g) {
          return h('optgroup', { label: g[0] }, g[1].map(function (x) { return h('option', { value: x.path }, x.type === 'outcome' ? x.label : x.path); }));
        }));
    };
    const row = function (c, i) {
      const outcome = Conditions.leftKind(c.left).kind === 'outcome';
      const op = Conditions.OPS[c.op] || {};
      const ops = Conditions.opsFor(c.left, outcome);
      if (ops.indexOf(c.op) < 0) ops.unshift(c.op);
      return h('div', { class: 'cond-row' },
        refSelect(c),
        h('select', { class: 'cond-op', value: c.op, onchange: function (e) { c.op = e.target.value; commit('all'); } },
          ops.map(function (k) { return h('option', { value: k }, Conditions.OPS[k].label); })),
        outcome
          ? h('select', { class: 'cond-val', value: c.value || 'KO', onchange: function (e) { c.value = e.target.value; commit('all'); } }, Conditions.OUTCOME_VALUES.map(function (v) { return h('option', { value: v }, v); }))
          : (op.unary ? h('span', { class: 'cond-val muted' }) : h('input', { type: 'text', class: 'cond-val', value: c.value == null ? '' : c.value, placeholder: op.list ? 'A, B, C' : (op.count ? 'numero' : 'valore'), onchange: function (e) { c.value = e.target.value; commit('all'); } })),
        h('button', { class: 'icon danger', title: 'Rimuovi la clausola', onclick: function () {
          clauses.splice(i, 1);
          if (!clauses.length && !required) delete holder[key];
          commit('all');
        } }, '✕'));
    };
    const text = Conditions.describe(data, o, when);
    return h('div', { class: 'cond' },
      clauses.length ? clauses.map(row) : h('div', { class: 'muted' }, required ? 'Nessuna clausola: aggiungine almeno una.' : 'Nessuna condizione: il blocco viene sempre eseguito.'),
      h('div', { class: 'cond-tools' },
        h('button', { class: 'small', onclick: function () { ensure().clauses.push(Conditions.emptyClause()); commit('all'); } }, '+ Condizione'),
        clauses.length > 1 ? h('select', { class: 'cond-join', value: when.join, onchange: function (e) { when.join = e.target.value; commit('all'); } },
          h('option', { value: 'AND' }, 'devono valere tutte (E)'), h('option', { value: 'OR' }, 'basta una (OPPURE)')) : null),
      text ? h('div', { class: 'field-hint' }, text) : null);
  }

  function whenSection(o, b) {
    const active = Conditions.isActive(b.config.when);
    return section('Condizione (esegui solo se)',
      conditionEditor(o, b.config, 'when', { block: b }),
      h('div', { class: 'field-hint' }, 'Se la condizione non è vera il blocco viene saltato: non è un KO e i blocchi che dipendono da lui partono comunque.'),
      active ? h('button', { class: 'small', title: 'Duplica il blocco con la condizione opposta, per costruire un ramo A oppure B', onclick: function () { createElseBlock(o, b); } }, '↔ Crea il ramo «Altrimenti»') : null);
  }

  function createElseBlock(o, b) {
    const nb = Util.clone(b);
    nb.id = Util.uniqueId(b.id + '_ALTRIMENTI', o.blocks.map(function (x) { return x.id; }));
    nb.config.when = Conditions.negate(b.config.when);
    o.blocks.push(nb);
    selection = { type: 'block', id: nb.id };
    toast('Creato il ramo «Altrimenti» con la condizione opposta', 'ok');
    commit('all');
  }

  function blockPanel(o, b) {
    const t = Model.task(data, b.taskId) || { name: b.taskId, description: 'Task non presente nel catalogo', inputs: [], outputs: [], outcomes: ['OK', 'KO'], compatibleProducts: [], type: 'sync', scope: 'common', api: {} };
    const c = b.config;
    const num = function (obj, key) {
      return h('input', { type: 'number', min: 0, value: obj[key], onchange: function (e) { obj[key] = Math.max(0, Number(e.target.value) || 0); commit('board'); } });
    };
    const text = function (obj, key, ph) {
      return h('input', { type: 'text', value: obj[key] || '', placeholder: ph || '', onchange: function (e) { obj[key] = e.target.value; commit('board'); } });
    };
    return h('div', null,
      h('div', { class: 'panel-head block-head' },
        h('div', { class: 'panel-kicker' }, 'Blocco ' + b.id),
        h('h3', null, t.name),
        h('div', { class: 'muted' }, t.description || ''),
        h('div', { class: 'pi-meta' },
          h('span', { class: 'badge ' + t.type }, t.type),
          t.api && t.api.path ? h('code', { class: 'api' }, t.api.method + ' ' + t.api.path) : null)),
      issuesFor('block', b.id),
      section('Prodotti coinvolti',
        o.products.map(function (pid) {
          const comp = t.compatibleProducts.indexOf(pid) >= 0, on = b.products.indexOf(pid) >= 0;
          return h('label', { class: 'check' + (comp ? '' : ' incompatible') },
            h('input', { type: 'checkbox', checked: on, disabled: !comp && !on, onchange: function (e) { toggleIn(b.products, pid, e.target.checked); sortProducts(o, b); commit('all'); } }),
            pname(pid), comp ? '' : ' — non compatibile');
        })),
      section('Esecuzione',
        field('Modalità di chiamata', h('select', { value: c.callMode, onchange: function (e) { c.callMode = e.target.value; commit('board'); } },
          h('option', { value: 'perOffer' }, '1 chiamata per N prodotti'),
          h('option', { value: 'perProduct' }, '1 chiamata per prodotto')),
          'Es. Oracolo: una sola chiamata per Conto, Evo e Lib Min.'),
        dependsEditor(o, b, 'Senza collegamenti il blocco parte subito, in parallelo agli altri. Con più nodi aspetta tutti (join).'),
        h('div', { class: 'row2' }, field('Retry (tentativi)', num(c.retry, 'count')), field('Intervallo retry (s)', num(c.retry, 'intervalSec')))),
      whenSection(o, b),
      mappingSection(o, b, t),
      section('Output',
        t.outputs.length ? t.outputs.slice(0, 15).map(function (x) {
          return h('div', { class: 'out-row' }, h('code', null, x.name), ' → ', h('code', { class: 'muted' }, 'esiti.' + b.id + '.' + x.name), x.description ? h('span', { class: 'muted' }, ' ' + x.description) : null);
        }).concat(t.outputs.length > 15 ? [h('div', { class: 'muted' }, 'Altri ' + (t.outputs.length - 15) + ' output (elenco completo nel catalogo); sono tutti disponibili ai blocchi successivi.')] : []) : h('div', { class: 'muted' }, 'Nessun output definito.')),
      section('Gestione esiti',
        h('div', { class: 'outcome ok' }, h('b', null, 'OK'), ' → prosegui'),
        t.outcomes.indexOf('KO') >= 0 ? h('div', { class: 'outcome ko' }, h('b', null, 'KO'), ' → ',
          h('select', { value: c.onKo, onchange: function (e) { c.onKo = e.target.value; commit('board'); } },
            h('option', { value: 'MARK_KO' }, 'segna prodotto KO (decide la barra regole)'),
            h('option', { value: 'IGNORE' }, 'ignora, non bloccante'))) : null,
        t.outcomes.indexOf('KO_TASK') >= 0 ? h('div', { class: 'outcome kotask' },
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: !!c.koTask.enabled, onchange: function (e) { c.koTask.enabled = e.target.checked; commit('all'); } }),
            h('b', null, 'KO con task'), ' → apri task manuale'),
          c.koTask.enabled ? h('div', { class: 'row2' }, field('Coda task', text(c.koTask, 'queue', 'es. BO_ANTIFRODE')), field('SLA (ore)', num(c.koTask, 'slaHours'))) : null)
          : h('div', { class: 'muted' }, '"KO con task" non previsto da questo task (abilitalo nel catalogo).')),
      section('Notifiche',
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!c.notify.onOk, onchange: function (e) { c.notify.onOk = e.target.checked; commit('board'); } }), 'Mail al cliente su OK'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!c.notify.onKo, onchange: function (e) { c.notify.onKo = e.target.checked; commit('board'); } }), 'Mail al cliente su KO'),
        field('Template', text(c.notify, 'template', 'es. ESITO_VERIFICA'))),
      t.type === 'async' ? section('Asincrono (presa in carico + callback)',
        field('Topic di callback', text(c.async, 'callbackTopic', 'es. bo.pratiche.esiti')),
        field('Timeout (ore)', num(c.async, 'timeoutHours'))) : null,
      h('div', { class: 'panel-actions' },
        h('button', { onclick: function () { select(null); } }, '← Offerta'),
        h('button', { onclick: function () { duplicateBlock(b); } }, '⧉ Duplica'),
        h('button', { title: 'Inserisce un gate subito dopo questo blocco', onclick: function () { addGateAfter([b.id]); } }, '⛩ Gate dopo'),
        h('button', { class: 'danger', onclick: function () { removeBlock(b.id); } }, '🗑 Elimina')));
  }

  function newRule(type) {
    if (type === 'DONT_WAIT') return { type: type, blockId: '' };
    if (type === 'STOP_ON_KO') return { type: type, products: [] };
    if (type === 'ROUTE') return { type: type, when: Conditions.emptyWhen(), to: '', maxIterations: Model.MAX_ITERATIONS_DEFAULT, onExceed: 'STOP' };
    return { type: type };
  }

  /* Destinazione e limiti di un instradamento (la condizione è nell'editor condiviso). */
  function routeEditor(o, g, r, st) {
    const gi = st.top.indexOf(g.id);
    const dest = st.top.indexOf(r.to);
    const back = r.to !== 'STOP' && dest >= 0 && gi >= 0 && dest <= gi;
    const targets = gi >= 0 ? st.top : [];
    return h('div', { class: 'route' },
      h('div', { class: 'field-label' }, 'Se'),
      conditionEditor(o, r, 'when', { gate: g.id }, true),
      field('Allora',
        h('select', { value: r.to || '', onchange: function (e) {
          r.to = e.target.value;
          if (r.to === 'STOP') { delete r.maxIterations; delete r.onExceed; }
          else { r.maxIterations = r.maxIterations || Model.MAX_ITERATIONS_DEFAULT; r.onExceed = r.onExceed || 'STOP'; }
          commit('all');
        } },
          h('option', { value: '' }, '— destinazione —'),
          targets.map(function (id, i) { return h('option', { value: id }, (i <= gi ? '↩ torna a ' : '⤳ salta a ') + Model.nodeName(data, o, id) + ' [' + id + ']' + (id === g.id ? ' (solo il gate)' : '')); }),
          r.to && r.to !== 'STOP' && dest < 0 ? h('option', { value: r.to }, '⚠ ' + r.to + ' (non raggiungibile)') : null,
          h('option', { value: 'STOP' }, '⛔ ferma l\'offerta')),
        gi < 0 ? 'Questo gate è dentro rami paralleli: qui si può solo fermare l\'offerta. Ritorno e salto valgono per i gate della sequenza principale (nel DSL un salto non esce da un ramo).'
          : back ? 'Il ritorno riesegue i nodi dalla destinazione a questo gate (rami compresi) per i prodotti ancora in corsa, KO compresi. Si valuta prima delle altre regole del gate.'
          : r.to === 'STOP' ? 'L\'offerta si ferma con errore.' : 'Salta i nodi intermedi per i prodotti che superano il gate (dopo le regole sui KO). Destinazioni: blocchi e gate della sequenza principale.'),
      back ? h('div', { class: 'row2' },
        field('Massimo ritorni (1-' + Model.MAX_ITERATIONS_LIMIT + ')', h('input', { type: 'number', min: 1, max: Model.MAX_ITERATIONS_LIMIT, value: r.maxIterations, onchange: function (e) { r.maxIterations = Math.floor(Number(e.target.value)) || 0; commit('all'); } })),
        field('Oltre il massimo', h('select', { value: r.onExceed || 'STOP', onchange: function (e) { r.onExceed = e.target.value; commit('all'); } },
          h('option', { value: 'STOP' }, 'ferma l\'offerta'), h('option', { value: 'CONTINUE' }, 'prosegui con le altre regole')))) : null);
  }

  /* Checklist dei nodi da cui dipende `n` ("Dopo"): esclude i discendenti, che creerebbero un ciclo. */
  function dependsEditor(o, n, hint) {
    const others = Model.nodes(o).filter(function (x) { return x.id !== n.id && Model.canDepend(o, n.id, x.id); });
    return field('Dopo (esegui dopo…)', others.length ? h('div', null, others.map(function (x) {
      return h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: n.dependsOn.indexOf(x.id) >= 0, onchange: function (e) { toggleIn(n.dependsOn, x.id, e.target.checked); commit('all'); } }),
        (x.kind === 'gate' ? '⛩ ' : '') + Model.blockLabel(data, o, x.id) + (x.kind === 'block' ? ' [' + x.id + ']' : ''));
    })) : h('div', { class: 'muted' }, 'Nessun altro nodo collegabile.'), hint);
  }

  function gatePanel(o, g) {
    const pol = Model.effectivePolicy([g]);
    const st = Model.structure(o);
    const depBlocks = g.dependsOn.filter(function (id) { return !!Model.block(o, id); });
    const scope = Model.scopeProducts(o, g.id);
    return h('div', null,
      h('div', { class: 'panel-head gate-panel-head' },
        h('div', { class: 'panel-kicker' }, g.dependsOn.length > 1 ? 'Gate · attende ' + g.dependsOn.length + ' nodi' : 'Gate · attende 1 nodo'),
        h('h3', null, 'Gate ' + g.id),
        h('div', { class: 'muted' }, 'Si valuta quando tutti i nodi collegati hanno finito' + (scope.length ? ' · governa: ' + scope.map(pname).join(', ') : '') + '. Con più nodi "Dopo" riunisce i rami (join); con uno solo vale per quel ramo.')),
      issuesFor('gate', g.id),
      section('Collegamenti', dependsEditor(o, g, 'Un gate con un solo nodo vale solo per quel ramo; con più nodi aspetta tutti (join).')),
      section('Regole',
        g.rules.length ? g.rules.map(function (r, ri) {
          return h('div', { class: 'rule' },
            h('div', { class: 'rule-head' },
              h('select', { value: r.type, onchange: function (e) { g.rules[ri] = newRule(e.target.value); commit('all'); } },
                Object.keys(RT).map(function (k) { return h('option', { value: k }, RT[k].label); })),
              h('button', { class: 'icon danger', title: 'Rimuovi regola', onclick: function () { g.rules.splice(ri, 1); commit('all'); } }, '✕')),
            h('div', { class: 'field-hint' }, RT[r.type] ? RT[r.type].desc : ''),
            r.type === 'DONT_WAIT' ? field('Blocco da non attendere (uno dei collegati)', h('select', { value: r.blockId || '', onchange: function (e) { r.blockId = e.target.value; commit('all'); } },
              h('option', { value: '' }, '— seleziona —'),
              depBlocks.map(function (id) { return h('option', { value: id }, Model.blockLabel(data, o, id)); }))) : null,
            r.type === 'STOP_ON_KO' ? field('Solo se KO su (nessuno = qualsiasi prodotto)', h('div', null, o.products.map(function (pid) {
              return h('label', { class: 'check inline' },
                h('input', { type: 'checkbox', checked: (r.products || []).indexOf(pid) >= 0, onchange: function (e) { r.products = r.products || []; toggleIn(r.products, pid, e.target.checked); commit('all'); } }),
                pname(pid));
            }))) : null,
            r.type === 'ROUTE' ? routeEditor(o, g, r, st) : null);
        }) : h('div', { class: 'muted' }, 'Nessuna regola: passano solo i prodotti OK (default).'),
        h('div', { class: 'add-rule' }, Object.keys(RT).map(function (k) {
          return h('button', { class: 'small', onclick: function () { g.rules.push(newRule(k)); commit('all'); } }, '+ ' + RT[k].label);
        }))),
      section('Nota', h('textarea', { rows: 2, value: g.note || '', placeholder: 'Motivazione / riferimento requisito', onchange: function (e) { g.note = e.target.value; Store.save(data); } })),
      section('Comportamento effettivo',
        h('ul', { class: 'help' }, ExecutionPlan.describePolicy(data, o, pol, g).map(function (d) { return h('li', null, d); }))),
      h('div', { class: 'panel-actions' },
        h('button', { onclick: function () { select(null); } }, '← Offerta'),
        h('button', { title: 'Inserisce un altro gate subito dopo questo', onclick: function () { addGateAfter([g.id]); } }, '＋ Gate dopo'),
        h('button', { class: 'danger', onclick: function () { removeGate(g.id); } }, '🗑 Elimina gate')));
  }

  /* ---------------- simulazione: log ---------------- */
  let scenarioOpen = false;

  function renderSimLog() {
    const el = $('simlog'); el.innerHTML = '';
    if (!simMode || !lastSim) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const o = offer();
    const f = lastSim.final;
    const label = { COMPLETED: '✔ Completato', STOPPED: '⛔ Fermato', WAITING: '⏸ In attesa', FAILED: '✖ Nessun prodotto completato', NO_PRODUCTS: '— Nessun prodotto' }[f.status];
    const hasRoute = o.gates.some(function (g) { return g.rules.some(function (r) { return r.type === 'ROUTE'; }); });
    const lefts = conditionLefts(o);
    const scenarioArea = lefts.length ? h('details', { class: 'sim-scenario', open: scenarioOpen, ontoggle: function (e) { scenarioOpen = e.target.open; } },
      h('summary', null, 'Dati dello scenario per le condizioni (' + lefts.length + ' campi letti)'),
      h('textarea', { rows: 8, spellcheck: 'false', value: JSON.stringify(ensureScenario(o), null, 2), onchange: function (e) {
        try {
          const v = JSON.parse(e.target.value);
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('deve essere un oggetto { practice, outputs }');
          simScenario[o.id] = { practice: v.practice || {}, outputs: v.outputs || {} };
          renderBoard(); renderSimLog();
        } catch (err) { toast('JSON dello scenario non valido: ' + err.message, 'error'); }
      } }),
      h('div', { class: 'field-hint' }, 'practice = dati della pratica; outputs = output dei blocchi (per id blocco). Le condizioni sui campi non indicati risultano false.')) : null;
    el.append(
      h('div', { class: 'simlog-head' },
        h('b', null, 'Simulazione'),
        h('span', { class: 'sim-final f-' + f.status.toLowerCase() }, label),
        h('span', { class: 'sim-msg' }, f.message),
        h('div', { class: 'spacer' }),
        hasRoute ? h('label', { class: 'check', title: 'Dopo un ritorno indietro i blocchi rieseguiti rispondono tutti OK (simula la correzione del problema)' },
          h('input', { type: 'checkbox', checked: !!simRecover[o.id], onchange: function (e) { simRecover[o.id] = e.target.checked; renderBoard(); renderSimLog(); } }), 'dopo un ritorno: tutto OK') : null,
        h('button', { class: 'small', onclick: function () { delete simOutcomes[offerId]; renderBoard(); renderSimLog(); } }, 'Tutti OK'),
        h('button', { class: 'small', onclick: randomScenario }, '🎲 Scenario casuale')),
      scenarioArea,
      h('div', { class: 'simlog-body' }, lastSim.log.map(function (l) { return h('div', { class: 'log' + (l.kind ? ' log-' + l.kind : '') }, l.msg); })));
  }

  /* ---------------- execution plan ---------------- */
  function copyText(txt) {
    const fallback = function () {
      const ta = h('textarea', { value: txt, style: { position: 'fixed', top: '-1000px' } });
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copiato', 'ok'); } catch (e) { toast('Copia non riuscita', 'error'); }
      ta.remove();
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(function () { toast('Copiato', 'ok'); }, fallback);
    else fallback();
  }

  function showPlan() {
    const o = offer();
    if (!o) return;
    const plan = ExecutionPlan.build(data, o);
    let files = [], dslError = null;
    try { files = dslFiles(o); } catch (err) { dslError = err.message; }
    const dslEl = h('div', { class: 'plan-dsl' },
      h('div', { class: 'dsl-toolbar' },
        h('span', { class: 'muted' }, 'DSL Serverless Workflow 1.0 generato dalla dashboard (sola lettura). Per cambiarlo modifica l\'offerta.'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'small', disabled: !files.length, onclick: function () { copyText(files[fileIdx].content); } }, '⧉ Copia')),
      h('div', { class: 'engine-files' }),
      h('pre', { class: 'json plan-dsl-pre' }));
    let fileIdx = 0;
    const drawDsl = function () {
      const bar = dslEl.querySelector('.engine-files');
      bar.innerHTML = '';
      if (dslError) { dslEl.querySelector('pre').textContent = 'DSL non generato: ' + dslError; return; }
      files.forEach(function (f, i) { bar.append(h('button', { class: 'tab' + (i === fileIdx ? ' active' : ''), onclick: function () { fileIdx = i; drawDsl(); } }, f.name + (i ? ' (sotto-workflow)' : ''))); });
      dslEl.querySelector('pre').textContent = files[fileIdx].content;
    };
    drawDsl();
    const views = [
      { label: 'Vista leggibile', el: ExecutionPlan.render(data, plan) },
      { label: 'DSL', el: dslEl }
    ];
    const tabs = views.map(function (v, i) {
      return h('button', { class: 'tab' + (i === 0 ? ' active' : ''), onclick: function () {
        views.forEach(function (x, j) { x.el.classList.toggle('hidden', j !== i); tabs[j].classList.toggle('active', j === i); });
      } }, v.label);
    });
    views.forEach(function (v, i) { if (i) v.el.classList.add('hidden'); });
    Util.modal('Execution Plan — ' + o.name, [h('div', { class: 'tabs-inline' }, tabs)].concat(views.map(function (v) { return v.el; })), [
      { label: '⭳ Esporta DSL (' + files.length + ' file)', class: 'primary', onClick: function () { if (!files.length) return toast(dslError || 'Nessun DSL da esportare', 'error'); files.forEach(function (f, i) { setTimeout(function () { Store.downloadText(f.content, f.name, f.mime); }, i * 300); }); } },
      { label: '🖨 Stampa', onClick: function () { window.print(); } }
    ]);
    if (!plan.summary.valid) toast('Il piano contiene errori di validazione', 'warn');
  }

  /* ---------------- avvisi della generazione AI ---------------- */
  function renderBanner() {
    const el = $('genbanner'); el.innerHTML = '';
    const o = offer();
    const g = o && o.generation;
    if (!g || g.reviewed || !(g.warnings || []).length) return;
    el.append(h('div', { class: 'genbanner' },
      h('div', { class: 'genbanner-head' },
        h('b', null, '⚠ Offerta generata dall\'agente con ' + g.warnings.length + ' avvisi da verificare'),
        h('span', { class: 'muted' }, ' · ' + (g.model || '') + (g.source ? ' · da ' + g.source : '') + (g.at ? ' · ' + new Date(g.at).toLocaleString() : '')),
        h('div', { class: 'spacer' }),
        h('button', { class: 'small', onclick: function () { g.reviewed = true; commit('all'); toast('Avvisi segnati come verificati', 'ok'); } }, '✔ Segna come verificati')),
      h('details', null, h('summary', null, 'Mostra avvisi'),
        h('ul', null, g.warnings.map(function (w) { return h('li', null, w); })))));
  }

  /* ---------------- JSON del modello (sola lettura) ---------------- */
  function modelOutput(o) {
    return o && o.generation && o.generation.modelOutput || null;
  }

  function renderModelJson() {
    const el = $('modelview'); el.innerHTML = '';
    const o = offer();
    const out = modelOutput(o);
    if (!out) { el.append(h('div', { class: 'empty' }, 'Questa offerta non è stata generata dall\'agente.')); return; }
    const g = o.generation;
    const text = JSON.stringify(out, null, 2);
    const fileName = 'model-output-' + o.id + '.json';
    el.append(
      h('div', { class: 'dsl-main' },
        h('div', { class: 'dsl-toolbar' },
          h('b', null, 'JSON restituito dal modello'),
          h('span', { class: 'muted' }, (g.model || '') + (g.source ? ' · da ' + g.source : '') + (g.at ? ' · ' + new Date(g.at).toLocaleString() : '')),
          h('div', { class: 'spacer' }),
          h('button', { onclick: function () { copyText(text); } }, '⧉ Copia'),
          h('button', { onclick: function () { Store.downloadText(text, fileName, 'application/json'); } }, '⭳ Scarica .json')),
        h('textarea', { class: 'dsl-editor', readonly: true, spellcheck: 'false', value: text })),
      h('aside', { class: 'dsl-side' },
        h('h4', null, 'Snapshot della generazione'),
        h('div', { class: 'muted' }, 'È la risposta del modello (offerta + assunzioni) validata dall\'agente: serve per capire cosa ha prodotto l\'AI. Non si modifica e non viene aggiornata dalle modifiche successive. La fonte di verità è la dashboard, cioè il DSL: modifica da lì.'),
        h('div', { class: 'hint' }, 'Il testo delle specifiche caricate non è incluso.')));
  }

  /* ---------------- DSL e grafo ---------------- */
  function dslFiles(o) {
    return Exporters.get('temporal').files(ExecutionPlan.build(data, o));
  }

  /* Vista Grafo a tutta pagina: ridisegnata a ogni cambio di offerta. */
  function renderGraphView() {
    const el = $('graphview'); el.innerHTML = '';
    const o = offer();
    if (!o) { el.append(h('div', { class: 'empty' }, 'Nessuna offerta selezionata.')); return; }
    const plan = ExecutionPlan.build(data, o);
    const g = ExecutionPlan.renderGraph(data, plan);
    const bar = g.querySelector('.plan-graph-bar');
    bar.append(h('button', { class: 'small', onclick: function () {
      const svg = g.querySelector('svg');
      Store.downloadText('<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg), 'grafo-' + o.id + '.svg', 'image/svg+xml');
    } }, '⭳ SVG'));
    el.append(g);
  }

  /*
   * Scheda Diagramma DSL: il viewer ufficiale Open Workflow (js/vendor/open-workflow-editor, bundle classico) disegna il DSL generato.
   * Sta in un iframe: il suo CSS contiene un reset globale che altrimenti cambierebbe l'aspetto della dashboard.
   * I percorsi dello srcdoc si risolvono rispetto alla pagina, quindi funziona anche aprendo index.html da file://.
   */
  const VIEWER_DIR = 'js/vendor/open-workflow-editor/';
  function viewerDoc() {
    return '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="' + VIEWER_DIR + 'diagram-editor.css">' +
      '<style>html,body,#v{height:100%;margin:0}</style></head><body><div id="v"></div>' +
      '<script src="' + VIEWER_DIR + 'diagram-editor.iife.js"><\/script></body></html>';
  }

  function renderDiagramView() {
    const el = $('diagramview'); el.innerHTML = '';
    const o = offer();
    if (!o) { el.append(h('div', { class: 'empty' }, 'Nessuna offerta selezionata.')); return; }
    let files = [];
    try { files = dslFiles(o); } catch (err) {
      el.append(h('div', { class: 'diagram-msg' }, 'Il DSL non si può generare: ' + err.message + ' (vedi la vista Visuale).'));
      return;
    }
    if (diagramFile >= files.length) diagramFile = 0;
    const frame = h('iframe', { class: 'diagram-frame', title: 'Diagramma del DSL' });
    const show = function () {
      const w = frame.contentWindow;
      if (!w || !w.OpenWorkflowViewer) { frame.replaceWith(h('div', { class: 'diagram-msg' }, 'Viewer non disponibile: manca js/vendor/open-workflow-editor (vedi tools/open-workflow-viewer).')); return; }
      w.OpenWorkflowViewer.mount(w.document.getElementById('v'), { content: files[diagramFile].content, locale: 'en', colorMode: ui.diagramTheme });
    };
    frame.addEventListener('load', show);
    frame.srcdoc = viewerDoc();
    el.append(
      h('div', { class: 'dsl-toolbar' },
        h('b', null, 'Diagramma del DSL'),
        h('span', { class: 'muted' }, 'Viewer ufficiale Open Workflow, sola lettura: ogni modifica all\'offerta rigenera il DSL. Zoom con la rotella o i pulsanti (il riquadro ⛶ mostra tutto), trascina per spostarti.'),
        h('div', { class: 'spacer' }),
        h('label', { class: 'muted diagram-theme' }, 'Tema ', h('select', { value: ui.diagramTheme, onchange: function (e) { ui.diagramTheme = e.target.value; saveUi(); renderDiagramView(); } },
          h('option', { value: 'light' }, 'Chiaro'), h('option', { value: 'dark' }, 'Scuro'), h('option', { value: 'system' }, 'Come il sistema'))),
        files.length > 1 ? h('select', { value: String(diagramFile), onchange: function (e) { diagramFile = Number(e.target.value); renderDiagramView(); } },
          files.map(function (f, i) { return h('option', { value: String(i) }, f.name + (i ? ' (sotto-workflow)' : '')); })) : null),
      frame);
  }
  /* ---------------- bootstrap ---------------- */
  const requested = new URLSearchParams(location.search).get('offer');
  if (requested && data.offers.some(function (x) { return x.id === requested; })) offerId = requested;
  $('btn-plan').addEventListener('click', showPlan);
  $('btn-sim').addEventListener('click', function () { if (!offer()) return; if (view !== 'visual') { view = 'visual'; simMode = true; render(); return; } toggleSim(); });
  initPanelGrip();
  window.addEventListener('resize', function () { if (view === 'visual') drawArrows(); });
  $('btn-validate').addEventListener('click', function () {
    const o = offer(); if (!o) return;
    selection = null; render();
    const v = validation;
    toast(v.ok ? 'Validazione OK' + (v.warnings.length ? ' (' + v.warnings.length + ' avvisi)' : '') : v.errors.length + ' errori, ' + v.warnings.length + ' avvisi', v.ok ? 'ok' : 'error');
  });
  Store.bindTopbar(function () { return data; }, function (d) { data = d; offerId = data.offers.length ? data.offers[0].id : null; selection = null; render(); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (document.getElementById('modal')) Util.closeModal(); else if (selection) select(null); return; }
    if ((e.key === 'Delete') && selection && !simMode && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      if (selection.type === 'block') removeBlock(selection.id); else removeGate(selection.id);
    }
  });

  // Sincronizza se il catalogo viene modificato in un'altra scheda.
  window.addEventListener('storage', function () { data = Store.load(); render(); });

  render();
})();
