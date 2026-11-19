/* Dashboard di configurazione offerta: griglia prodotti × step, blocchi, gate, simulazione. */
(function () {
  const h = Util.h, toast = Util.toast;
  const RT = Model.RULE_TYPES;

  let data = Store.load();
  let offerId = data.offers.length ? data.offers[0].id : null;
  let selection = null;           // { type: 'block' | 'gate', id }
  let simMode = false;
  const simOutcomes = {};         // offerId -> blockId -> productId -> esito
  let validation = null;
  let lastSim = null;
  let dragPayload = null;         // { kind: 'task' | 'block', id }
  let paletteFilter = '';
  let view = 'visual';            // 'visual' | 'dsl' | 'model'
  const dslDrafts = {};           // offerId -> testo DSL modificato e non ancora applicato
  let dslMessages = null;         // { kind: 'error'|'ok', items: [] }

  /* stato dell'interfaccia (barra task, pannello dettagli): solo preferenze, non fanno parte dei dati dell'offerta */
  const UI_KEY = 'offerDashboard.ui.v1';
  const ui = (function () {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (e) { s = {}; }
    return { paletteCollapsed: !!s.paletteCollapsed, panelCollapsed: s.panelCollapsed !== false, panelHeight: Number(s.panelHeight) > 0 ? Number(s.panelHeight) : 300 };
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
      if (x) title = selection.type === 'block' ? 'Blocco: ' + (Model.task(data, x.taskId) || { name: x.taskId }).name : 'Barra regole';
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
    renderOfferbar(); renderBanner();
    $('visualview').classList.toggle('hidden', view !== 'visual');
    $('dslview').classList.toggle('hidden', view !== 'dsl');
    $('modelview').classList.toggle('hidden', view !== 'model');
    if (view === 'model' && !modelOutput(o)) view = 'visual';
    if (view === 'dsl') { renderDsl(); return; }
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
    if (v === 'dsl' && simMode) simMode = false;
    if (v === 'model' && simMode) simMode = false;
    view = v;
    dslMessages = null;
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
        h('button', { class: 'tab' + (view === 'dsl' ? ' active' : '') + (dslDrafts[offerId] ? ' draft' : ''), title: dslDrafts[offerId] ? 'Bozza DSL non applicata' : '', onclick: function () { setView('dsl'); } }, '{ } DSL' + (dslDrafts[offerId] ? ' •' : '')),
        modelOutput(o) ? h('button', { class: 'tab' + (view === 'model' ? ' active' : ''), title: 'Risposta JSON del modello (sola lettura)', onclick: function () { setView('model'); } }, '🤖 JSON modello') : null) : null,
      o && view === 'visual' ? h('button', { class: 'sim-toggle' + (simMode ? ' active' : ''), onclick: toggleSim }, simMode ? '■ Esci dalla simulazione' : '▶ Simulazione') : null
    ];
    items.flat(Infinity).forEach(function (x) { if (x) bar.append(x); });
  }

  /* ---------- palette task ---------- */
  function renderPalette() {
    const p = $('palette'); p.innerHTML = '';
    p.classList.toggle('collapsed', ui.paletteCollapsed);
    const list = h('div', { class: 'palette-list' });
    const help = 'Trascina un task sulla riga di un prodotto, dentro uno step. Rilascialo sull\'intestazione dello step per assegnarlo a tutti i prodotti compatibili. Se lo step contiene già lo stesso task, il prodotto viene aggiunto al blocco esistente (tieni premuto Alt per crearne uno separato).';
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
          h('span', { class: 'badge ' + t.scope }, t.scope === 'common' ? 'common' : 'verticale'),
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
    const steps = (t.allowedSteps && t.allowedSteps.length ? t.allowedSteps : data.steps.map(function (s) { return s.id; }))
      .map(function (id) { const s = Model.step(data, id); return s ? s.name : id; });
    taskTip = h('div', { class: 'task-tip' },
      h('div', { class: 'tt-title' }, t.name),
      t.description ? h('div', { class: 'tt-desc' }, t.description) : null,
      h('div', { class: 'tt-row' }, h('b', null, 'Tipo: '), (t.type === 'async' ? 'asincrono (callback)' : 'sincrono') + ' · ' + (t.scope === 'common' ? 'condiviso tra più prodotti' : 'verticale') + ' · ' + (t.callMode === 'perOffer' ? '1 chiamata per N prodotti' : '1 chiamata per prodotto')),
      h('div', { class: 'tt-row' }, h('b', null, 'Prodotti compatibili:'),
        h('div', { class: 'tt-prods' }, t.compatibleProducts.map(function (pid) {
          return h('span', { class: 'tt-prod' + (inOffer(pid) ? ' on' : '') }, (inOffer(pid) ? '✓ ' : '') + pname(pid));
        }))),
      h('div', { class: 'tt-row' }, h('b', null, 'Step ammessi: '), steps.join(', ')),
      t.api ? h('div', { class: 'tt-row' }, h('code', null, t.api.method + ' ' + t.api.path)) : null,
      usable ? null : h('div', { class: 'tt-warn' }, 'Nessun prodotto compatibile nell\'offerta'));
    document.body.appendChild(taskTip);
    const r = anchor.getBoundingClientRect(), w = taskTip.offsetWidth;
    taskTip.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    taskTip.style.top = (r.bottom + 6) + 'px';
  }

  /* ---------- griglia ---------- */
  function layoutStep(o, stepId) {
    const blocks = Model.blocksInStep(o, stepId);
    const levels = Model.levels(blocks).levels;
    const placements = [];
    let laneBase = 0;
    levels.forEach(function (level) {
      const lanes = [];
      level.forEach(function (b) {
        const idx = b.products.map(function (p) { return o.products.indexOf(p); }).filter(function (i) { return i >= 0; });
        const rs = idx.length ? Math.min.apply(null, idx) : 0;
        const re = idx.length ? Math.max.apply(null, idx) : 0;
        let k = 0;
        while (lanes[k] && lanes[k].some(function (r) { return !(re < r[0] || rs > r[1]); })) k++;
        (lanes[k] = lanes[k] || []).push([rs, re]);
        placements.push({ block: b, lane: laneBase + k, rs: rs, re: re });
      });
      laneBase += Math.max(lanes.length, 1);
    });
    return { lanes: Math.max(laneBase, 1), placements: placements };
  }

  function simStep(stepId) { return lastSim ? lastSim.steps.find(function (s) { return s.stepId === stepId; }) : null; }

  function renderBoard() {
    const board = $('board'); board.innerHTML = '';
    board.className = 'board' + (simMode ? ' sim' : '');
    const o = offer();
    lastSim = null;
    if (!o) {
      board.style.gridTemplateColumns = '1fr'; board.style.gridTemplateRows = 'auto';
      board.append(h('div', { class: 'empty' }, 'Nessuna offerta. Crea una nuova offerta con "+ Nuova".'));
      return;
    }
    if (simMode) lastSim = Simulator.run(data, o, simOutcomes[o.id] || {});
    const steps = data.steps, prods = o.products, n = Math.max(prods.length, 1);
    const refSet = function (list, type) { return new Set(list.filter(function (e) { return e.ref && e.ref.type === type; }).map(function (e) { return e.ref.id; })); };
    const errBlocks = refSet(validation.errors, 'block'), warnBlocks = refSet(validation.warnings, 'block');
    const errGates = refSet(validation.errors, 'gate');

    const cols = ['170px'], pos = {}, layouts = {};
    let c = 2;
    steps.forEach(function (s, i) {
      const L = layoutStep(o, s.id);
      layouts[s.id] = L;
      pos[s.id] = { start: c, span: L.lanes };
      for (let k = 0; k < L.lanes; k++) cols.push('minmax(165px, 1fr)');
      c += L.lanes;
      if (i < steps.length - 1) { pos['G:' + s.id] = c; cols.push('150px'); c++; }
    });
    board.style.gridTemplateColumns = cols.join(' ');
    board.style.gridTemplateRows = 'auto repeat(' + n + ', minmax(' + (simMode ? 112 : 92) + 'px, auto)) auto';
    const footRow = n + 2;

    board.append(h('div', { class: 'corner', style: { gridRow: 1, gridColumn: 1 } }, 'Prodotti \\ Step'));

    steps.forEach(function (s, i) {
      const p = pos[s.id];
      const ss = simStep(s.id);
      board.append(h('div', {
        class: 'step-head', style: { gridRow: 1, gridColumn: p.start + ' / span ' + p.span },
        title: 'Rilascia qui un task per assegnarlo a tutti i prodotti compatibili',
        ondragover: allowDrop, ondragleave: leaveDrop, ondrop: function (e) { dropOnStep(e, s.id); }
      }, h('span', { class: 'step-n' }, i + 1), s.name));

      prods.forEach(function (pid, r) {
        let st = '';
        if (simMode) {
          if (!ss || ss.entering.indexOf(pid) < 0) st = 'out';
          else st = ({ OK: 'ok', KO: 'ko', PENDING: 'pending', ASYNC: 'async' })[ss.productStatus[pid]] || 'ok';
        }
        board.append(h('div', {
          class: 'cell' + (r % 2 ? ' odd' : '') + (st ? ' st-' + st : ''),
          style: { gridRow: r + 2, gridColumn: p.start + ' / span ' + p.span },
          ondragover: allowDrop, ondragleave: leaveDrop, ondrop: function (e) { dropOnCell(e, s.id, pid); }
        }));
      });

      layouts[s.id].placements.forEach(function (pl) { renderBlock(o, pl, p, errBlocks, warnBlocks).forEach(function (el) { board.append(el); }); });

      if (i < steps.length - 1) {
        const gc = pos['G:' + s.id];
        const gates = Model.gatesAfter(o, s.id);
        const verdict = ss && ss.gate;
        board.append(h('div', { class: 'gate-head', style: { gridRow: 1, gridColumn: gc } },
          simMode ? null : h('button', { class: 'small', onclick: function () { addGate(s.id); }, title: 'Aggiungi una barra di regole' }, '+ barra')));
        board.append(h('div', { class: 'gate-col', style: { gridRow: '2 / span ' + n, gridColumn: gc } },
          gates.length ? gates.map(function (g, gi) {
            const sel = selection && selection.type === 'gate' && selection.id === g.id;
            return h('div', {
              class: 'gate' + (sel ? ' selected' : '') + (errGates.has(g.id) ? ' has-error' : ''),
              title: g.rules.map(function (r) { return Model.ruleText(data, o, r); }).join('\n') || 'Nessuna regola',
              onclick: function () { select('gate', g.id); }
            }, h('span', { class: 'gate-n' }, gi + 1));
          }) : h('div', { class: 'gate ghost', title: 'Nessuna regola: default "Manda solo gli OK". Clicca per configurare', onclick: function () { if (!simMode) addGate(s.id); } }),
          verdict ? h('div', { class: 'verdict v-' + verdict.verdict.toLowerCase(), title: verdict.text },
            ({ PASS: '➜ passa', WAIT: '⏸ attesa', STOP: '⛔ stop' })[verdict.verdict]) : null));
        board.append(h('div', { class: 'gate-foot', style: { gridRow: footRow, gridColumn: gc } },
          gates.length ? gates.map(function (g, gi) {
            return h('div', { class: 'gate-rule-text', onclick: function () { select('gate', g.id); } },
              h('b', null, (gi + 1) + '. '),
              g.rules.length ? g.rules.map(function (r) { return Model.ruleText(data, o, r); }).join(' · ') : h('i', null, '(nessuna regola)'));
          }) : h('div', { class: 'muted' }, 'default: solo OK'),
          verdict ? h('div', { class: 'gate-verdict-text' }, verdict.text) : null));
      }
    });

    prods.forEach(function (pid, r) {
      let badge = null;
      if (simMode && lastSim) {
        const reached = lastSim.steps.filter(function (s) { return s.entering.indexOf(pid) >= 0 && !s.skipped; });
        const last = reached[reached.length - 1];
        const fin = lastSim.final;
        let txt, cls;
        if (fin.status === 'COMPLETED' && fin.active.indexOf(pid) >= 0) { txt = '✔ completato'; cls = 'ok'; }
        else if (fin.status === 'STOPPED') { txt = '⛔ fermato'; cls = 'ko'; }
        else if (fin.status === 'WAITING' && fin.active.indexOf(pid) >= 0) { txt = '⏸ in attesa'; cls = 'pending'; }
        else { txt = '✖ escluso in ' + (last ? Model.step(data, last.stepId).name : '—'); cls = 'ko'; }
        badge = h('div', { class: 'prod-status ' + cls }, txt);
      }
      board.append(h('div', { class: 'prod-label' + (r % 2 ? ' odd' : ''), style: { gridRow: r + 2, gridColumn: 1 } },
        h('div', { class: 'prod-name' }, pname(pid)),
        simMode ? badge : h('div', { class: 'prod-actions' },
          h('button', { class: 'icon', title: 'Su', disabled: r === 0, onclick: function () { moveProduct(pid, -1); } }, '▲'),
          h('button', { class: 'icon', title: 'Giù', disabled: r === prods.length - 1, onclick: function () { moveProduct(pid, 1); } }, '▼'),
          h('button', { class: 'icon danger', title: 'Rimuovi dall\'offerta', onclick: function () { removeProduct(pid); } }, '×'))));
    });

    if (!prods.length) board.append(h('div', { class: 'empty-row', style: { gridRow: 2, gridColumn: '1 / -1' } }, 'L\'offerta non ha prodotti: aggiungili dalla barra in alto ("+ Aggiungi prodotto…").'));
    board.append(h('div', { class: 'foot-label', style: { gridRow: footRow, gridColumn: 1 } }, 'Regole di passaggio'));
  }

  function renderBlock(o, pl, p, errBlocks, warnBlocks) {
    const b = pl.block, t = Model.task(data, b.taskId);
    const c = b.config;
    const sel = selection && selection.type === 'block' && selection.id === b.id;
    const inOffer = b.products.filter(function (pid) { return o.products.indexOf(pid) >= 0; });
    const depNames = b.dependsOn.map(function (d) { const x = o.blocks.find(function (y) { return y.id === d; }); const tt = x && Model.task(data, x.taskId); return tt ? tt.name : d; });

    // un segmento per ogni gruppo di righe adiacenti: le righe dei prodotti esclusi restano vuote
    const idx = inOffer.map(function (pid) { return o.products.indexOf(pid); }).sort(function (a, z) { return a - z; });
    const groups = [];
    idx.forEach(function (i) {
      const g = groups[groups.length - 1];
      if (g && i === g.end + 1) { g.end = i; g.products.push(o.products[i]); } else groups.push({ start: i, end: i, products: [o.products[i]] });
    });
    if (!groups.length) groups.push({ start: pl.rs, end: pl.re, products: [] });

    const col = String(p.start + pl.lane);
    const out = [];
    groups.forEach(function (g, gi) {
      const first = gi === 0;
      const cls = ['block'];
      if (sel) cls.push('selected');
      if (first) { if (errBlocks.has(b.id)) cls.push('has-error'); else if (warnBlocks.has(b.id)) cls.push('has-warning'); }
      else cls.push('continued');
      if (t && t.type === 'async') cls.push('async');
      const showProducts = g.products.length && (!simMode && (inOffer.length > 1));
      out.push(h('div', {
        class: cls.join(' '),
        style: { gridRow: (g.start + 2) + ' / ' + (g.end + 3), gridColumn: col },
        title: groups.length > 1 ? 'Stesso blocco su ' + inOffer.map(pname).join(', ') : null,
        draggable: !simMode,
        ondragstart: function (e) { e.stopPropagation(); startDrag(e, { kind: 'block', id: b.id }); },
        ondragend: endDrag,
        onclick: function (e) { if (/SELECT|OPTION/.test(e.target.tagName)) return; select('block', b.id); }
      },
        h('div', { class: 'block-title' }, t ? t.name : b.taskId + ' (?)'),
        first ? h('div', { class: 'block-badges' },
          inOffer.length > 1 ? h('span', { class: 'bb' }, c.callMode === 'perOffer' ? '1 chiamata × ' + inOffer.length : inOffer.length + ' chiamate') : null,
          t && t.type === 'async' ? h('span', { class: 'bb' }, 'async') : null,
          Number(c.retry.count) > 0 ? h('span', { class: 'bb' }, 'retry ' + c.retry.count) : null,
          c.koTask.enabled && t && t.outcomes.indexOf('KO_TASK') >= 0 ? h('span', { class: 'bb' }, 'KO→task') : null,
          c.onKo === 'IGNORE' ? h('span', { class: 'bb' }, 'KO non bloccante') : null,
          c.notify.onOk || c.notify.onKo ? h('span', { class: 'bb' }, '✉') : null) : h('div', { class: 'block-cont' }, '↑ stesso blocco'),
        first && depNames.length ? h('div', { class: 'block-deps' }, '↳ dopo ' + depNames.join(', ')) : null,
        showProducts ? h('div', { class: 'block-products' }, g.products.map(function (pid) { return h('span', { class: 'mini on' }, pname(pid)); })) : null,
        simMode ? simControls(o, b, t, g.products) : null));
      const next = groups[gi + 1];
      if (next) {
        // ponte tratteggiato nelle righe vuote tra due segmenti: stessa larghezza delle schede, le unisce
        out.push(h('div', {
          class: 'block-bridge' + (sel ? ' selected' : '') + (t && t.type === 'async' ? ' async' : ''),
          style: { gridRow: (g.end + 3) + ' / ' + (next.start + 2), gridColumn: col },
          title: 'Stesso blocco ' + (t ? t.name : b.taskId) + ': non include ' + o.products.slice(g.end + 1, next.start).map(pname).join(', ')
        }));
      }
    });
    return out;
  }

  const OUT_LABEL = { OK: 'OK', KO: 'KO', KO_TASK: 'KO + task', PENDING: 'In attesa' };
  const EFF_LABEL = { SKIPPED: 'non eseguito (dip. KO)', WAITING: 'attende dipendenza', NOT_ACTIVE: 'escluso prima', KO_IGNORED: 'KO ignorato' };

  function simControls(o, b, t, inOffer) {
    const ss = simStep(b.stepId);
    const res = ss && ss.blockResults[b.id] || {};
    return h('div', { class: 'sim-ctrl' }, inOffer.map(function (pid) {
      const chosen = ((simOutcomes[o.id] || {})[b.id] || {})[pid] || 'OK';
      const opts = ['OK'];
      if (!t || t.outcomes.indexOf('KO') >= 0) opts.push('KO');
      if (t && t.outcomes.indexOf('KO_TASK') >= 0 && b.config.koTask.enabled) opts.push('KO_TASK');
      opts.push('PENDING');
      const eff = res[pid];
      const reached = !!ss && !ss.skipped && ss.entering.indexOf(pid) >= 0;
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
    e.dataTransfer.effectAllowed = payload.kind === 'task' ? 'copy' : 'move';
    e.dataTransfer.setData('text/plain', payload.id);
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
    e.dataTransfer.dropEffect = dragPayload.kind === 'task' ? 'copy' : 'move';
    e.currentTarget.classList.add('drop-over');
  }
  function leaveDrop(e) { e.currentTarget.classList.remove('drop-over'); }

  function dropOnCell(e, stepId, pid) {
    e.preventDefault();
    const p = dragPayload; endDrag();
    if (!p) return;
    const o = offer();
    if (p.kind === 'block') return moveBlock(p.id, stepId, pid);
    const t = Model.task(data, p.id);
    if (t.compatibleProducts.indexOf(pid) < 0) return toast(t.name + ' non è compatibile con ' + pname(pid), 'error');
    const existing = !e.altKey && Model.blocksInStep(o, stepId).find(function (b) { return b.taskId === t.id; });
    if (existing) {
      if (existing.products.indexOf(pid) >= 0) return toast(pname(pid) + ' è già nel blocco ' + t.name, 'warn');
      existing.products.push(pid);
      sortProducts(o, existing);
      toast(pname(pid) + ' aggiunto al blocco condiviso ' + t.name, 'ok');
      selection = { type: 'block', id: existing.id };
      return commit('all');
    }
    addBlock(t, stepId, [pid]);
  }

  function dropOnStep(e, stepId) {
    e.preventDefault();
    const p = dragPayload; endDrag();
    if (!p) return;
    if (p.kind === 'block') return moveBlock(p.id, stepId);
    const o = offer();
    const t = Model.task(data, p.id);
    const prods = o.products.filter(function (pid) { return t.compatibleProducts.indexOf(pid) >= 0; });
    if (!prods.length) return toast(t.name + ' non è compatibile con nessun prodotto dell\'offerta', 'error');
    addBlock(t, stepId, prods);
  }

  /* ---------------- azioni ---------------- */
  function sortProducts(o, b) { b.products.sort(function (a, c) { return o.products.indexOf(a) - o.products.indexOf(c); }); }

  function addBlock(t, stepId, products) {
    const o = offer();
    if (t.allowedSteps.length && t.allowedSteps.indexOf(stepId) < 0)
      toast(t.name + ' non è previsto in ' + Model.step(data, stepId).name + ' (vedi catalogo)', 'warn');
    const b = { id: Util.uniqueId('B_' + t.id, o.blocks.map(function (x) { return x.id; })), taskId: t.id, stepId: stepId, products: products.slice(), dependsOn: [], config: Model.defaultBlockConfig(t) };
    sortProducts(o, b);
    o.blocks.push(b);
    selection = { type: 'block', id: b.id };
    commit('all');
  }

  function detachBlockRefs(o, id) {
    o.blocks.forEach(function (x) { x.dependsOn = x.dependsOn.filter(function (d) { return d !== id; }); });
    let removed = 0;
    o.gates.forEach(function (g) {
      const before = g.rules.length;
      g.rules = g.rules.filter(function (r) { return !(r.type === 'DONT_WAIT' && r.blockId === id); });
      removed += before - g.rules.length;
    });
    return removed;
  }

  function moveBlock(id, stepId, pid) {
    const o = offer();
    const b = o.blocks.find(function (x) { return x.id === id; });
    if (!b) return;
    if (b.stepId === stepId) {
      const t = Model.task(data, b.taskId);
      if (pid && b.products.indexOf(pid) < 0 && t && t.compatibleProducts.indexOf(pid) >= 0) {
        b.products.push(pid); sortProducts(o, b);
        toast(pname(pid) + ' aggiunto al blocco', 'ok');
        return commit('all');
      }
      return;
    }
    b.stepId = stepId;
    b.dependsOn = [];
    const removed = detachBlockRefs(o, id);
    selection = { type: 'block', id: id };
    toast('Blocco spostato in ' + Model.step(data, stepId).name + (removed ? ' (rimosse ' + removed + ' regole "Non attendere" collegate)' : ''), 'ok');
    commit('all');
  }

  function removeBlock(id) {
    const o = offer();
    o.blocks = o.blocks.filter(function (b) { return b.id !== id; });
    detachBlockRefs(o, id);
    if (simOutcomes[o.id]) delete simOutcomes[o.id][id];
    selection = null;
    commit('all');
  }

  function duplicateBlock(b) {
    const o = offer();
    const nb = Util.clone(b);
    nb.id = Util.uniqueId(b.id, o.blocks.map(function (x) { return x.id; }));
    nb.dependsOn = [];
    o.blocks.push(nb);
    selection = { type: 'block', id: nb.id };
    commit('all');
  }

  function addGate(stepId) {
    const o = offer();
    const g = { id: Util.uid('G'), afterStep: stepId, note: '', rules: [] };
    o.gates.push(g);
    selection = { type: 'gate', id: g.id };
    commit('all');
  }

  function removeGate(id) {
    const o = offer();
    o.gates = o.gates.filter(function (g) { return g.id !== id; });
    selection = null;
    commit('all');
  }

  function moveGate(g, dir) {
    const o = offer();
    const sib = Model.gatesAfter(o, g.afterStep);
    const other = sib[sib.indexOf(g) + dir];
    if (!other) return;
    const i = o.gates.indexOf(g), j = o.gates.indexOf(other);
    o.gates[i] = other; o.gates[j] = g;
    commit('all');
  }

  function removeProduct(pid) {
    const o = offer();
    const affected = o.blocks.filter(function (b) { return b.products.indexOf(pid) >= 0; });
    const orphan = affected.filter(function (b) { return b.products.length === 1; });
    if (affected.length && !confirm('Rimuovere ' + pname(pid) + ' dall\'offerta?\n' + affected.length + ' blocchi lo usano' + (orphan.length ? ', ' + orphan.length + ' resteranno vuoti e saranno eliminati.' : '.'))) return;
    o.products = o.products.filter(function (p) { return p !== pid; });
    affected.forEach(function (b) { b.products = b.products.filter(function (p) { return p !== pid; }); });
    orphan.forEach(function (b) { o.blocks = o.blocks.filter(function (x) { return x !== b; }); detachBlockRefs(o, b.id); });
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
          kpi(o.products.length, 'prodotti'), kpi(o.blocks.length, 'blocchi'), kpi(o.gates.length, 'barre regole'),
          kpi(new Set(o.blocks.map(function (b) { return b.taskId; })).size, 'servizi'))),
      section('Validazione',
        v.ok && !v.warnings.length ? h('div', { class: 'msg ok' }, '✔ Nessun problema rilevato') : null,
        v.errors.map(item('error', '✖')), v.warnings.map(item('warning', '⚠')), v.infos.map(item('info', 'ℹ'))),
      section('Come si usa',
        h('ul', { class: 'help' },
          h('li', null, 'Righe = prodotti dell\'offerta, colonne = step fissi del processo.'),
          h('li', null, 'Trascina i task dalla palette: un blocco può coprire più prodotti (task common).'),
          h('li', null, 'Blocchi nello stesso step senza dipendenze sono paralleli; usa "Esegui dopo" per metterli in sequenza.'),
          h('li', null, 'Le barre arancioni tra gli step contengono le regole di passaggio: clicca per configurarle.'),
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
      src.results.map(function (s) { return opt(s, 'output'); }),
      src.system.map(function (s) { return opt(s, 'sistema'); }));
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
      rows.slice(0, MAX_ROWS).forEach(function (i) { listEl.append(mappingRow(i, c, statusOf, listId)); });
      if (rows.length > MAX_ROWS) listEl.append(h('div', { class: 'muted' }, 'Altri ' + (rows.length - MAX_ROWS) + ' input: usa il filtro per cercarli.'));
      if (!rows.length) listEl.append(h('div', { class: 'muted' }, total ? 'Nessun input corrisponde al filtro.' : 'Nessun input definito nel catalogo.'));
    };
    fill();
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
      h('div', { class: 'field-hint' }, 'Sorgente: campo della pratica (es. cliente.codiceFiscale), output di un blocco già eseguito (esiti.<blocco>.<campo>), sorgente di sistema (offerta.prodotti, prodotto.id) oppure valore fisso.'));
  }

  function mappingRow(i, c, statusOf, listId) {
    const icon = h('span', { class: 'map-status' });
    const paint = function () { const st = statusOf(i); icon.className = 'map-status ' + st.level; icon.textContent = STATUS_ICON[st.level]; icon.title = st.msg; };
    paint();
    return h('div', { class: 'map-row' },
      h('div', { class: 'map-name' }, h('code', null, i.name), i.required ? h('span', { class: 'req' }, ' *') : null, h('span', { class: 'muted map-type' }, ' ' + (i.type || 'string'))),
      h('div', { class: 'map-input' },
        h('input', { type: 'text', list: listId, value: c.inputMapping[i.name] || '', placeholder: 'campo, esiti.<blocco>.<campo> o valore fisso', onchange: function (e) { c.inputMapping[i.name] = e.target.value.trim(); paint(); commit('board'); } }),
        icon));
  }

  function blockPanel(o, b) {
    const t = Model.task(data, b.taskId) || { name: b.taskId, description: 'Task non presente nel catalogo', inputs: [], outputs: [], outcomes: ['OK', 'KO'], compatibleProducts: [], type: 'sync', scope: 'common', api: {} };
    const c = b.config;
    const others = Model.blocksInStep(o, b.stepId).filter(function (x) { return x.id !== b.id; });
    const num = function (obj, key) {
      return h('input', { type: 'number', min: 0, value: obj[key], onchange: function (e) { obj[key] = Math.max(0, Number(e.target.value) || 0); commit('board'); } });
    };
    const text = function (obj, key, ph) {
      return h('input', { type: 'text', value: obj[key] || '', placeholder: ph || '', onchange: function (e) { obj[key] = e.target.value; commit('board'); } });
    };
    return h('div', null,
      h('div', { class: 'panel-head block-head' },
        h('div', { class: 'panel-kicker' }, 'Blocco · ' + Model.step(data, b.stepId).name),
        h('h3', null, t.name),
        h('div', { class: 'muted' }, t.description || ''),
        h('div', { class: 'pi-meta' },
          h('span', { class: 'badge ' + t.scope }, t.scope === 'common' ? 'common' : 'verticale'),
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
        field('Esegui dopo (stesso step)', others.length ? h('div', null, others.map(function (x) {
          return h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: b.dependsOn.indexOf(x.id) >= 0, onchange: function (e) { toggleIn(b.dependsOn, x.id, e.target.checked); commit('all'); } }),
            Model.blockLabel(data, o, x.id));
        })) : h('div', { class: 'muted' }, 'Nessun altro blocco nello step.'),
          'Senza dipendenze i blocchi dello step girano in parallelo.'),
        h('div', { class: 'row2' }, field('Retry (tentativi)', num(c.retry, 'count')), field('Intervallo retry (s)', num(c.retry, 'intervalSec')))),
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
        h('button', { class: 'danger', onclick: function () { removeBlock(b.id); } }, '🗑 Elimina')));
  }

  function newRule(type) {
    if (type === 'DONT_WAIT') return { type: type, blockId: '' };
    if (type === 'STOP_ON_KO') return { type: type, products: [] };
    return { type: type };
  }

  function gatePanel(o, g) {
    const si = Model.stepIndex(data, g.afterStep);
    const s = data.steps[si], nx = data.steps[si + 1];
    const siblings = Model.gatesAfter(o, g.afterStep);
    const idx = siblings.indexOf(g);
    const stepBlocks = Model.blocksInStep(o, g.afterStep);
    const pol = Model.effectivePolicy(siblings);
    return h('div', null,
      h('div', { class: 'panel-head gate-panel-head' },
        h('div', { class: 'panel-kicker' }, 'Barra regole ' + (idx + 1) + ' di ' + siblings.length),
        h('h3', null, s.name + ' → ' + nx.name),
        h('div', { class: 'muted' }, 'Le regole di tutte le barre tra questi due step vengono valutate insieme, nell\'ordine.')),
      issuesFor('gate', g.id),
      section('Regole',
        g.rules.length ? g.rules.map(function (r, ri) {
          return h('div', { class: 'rule' },
            h('div', { class: 'rule-head' },
              h('select', { value: r.type, onchange: function (e) { g.rules[ri] = newRule(e.target.value); commit('all'); } },
                Object.keys(RT).map(function (k) { return h('option', { value: k }, RT[k].label); })),
              h('button', { class: 'icon danger', title: 'Rimuovi regola', onclick: function () { g.rules.splice(ri, 1); commit('all'); } }, '✕')),
            h('div', { class: 'field-hint' }, RT[r.type] ? RT[r.type].desc : ''),
            r.type === 'DONT_WAIT' ? field('Blocco da non attendere', h('select', { value: r.blockId || '', onchange: function (e) { r.blockId = e.target.value; commit('all'); } },
              h('option', { value: '' }, '— seleziona —'),
              stepBlocks.map(function (b) { return h('option', { value: b.id }, Model.blockLabel(data, o, b.id)); }))) : null,
            r.type === 'STOP_ON_KO' ? field('Solo se KO su (nessuno = qualsiasi prodotto)', h('div', null, o.products.map(function (pid) {
              return h('label', { class: 'check inline' },
                h('input', { type: 'checkbox', checked: (r.products || []).indexOf(pid) >= 0, onchange: function (e) { r.products = r.products || []; toggleIn(r.products, pid, e.target.checked); commit('all'); } }),
                pname(pid));
            }))) : null);
        }) : h('div', { class: 'muted' }, 'Nessuna regola in questa barra.'),
        h('div', { class: 'add-rule' }, Object.keys(RT).map(function (k) {
          return h('button', { class: 'small', onclick: function () { g.rules.push(newRule(k)); commit('all'); } }, '+ ' + RT[k].label);
        }))),
      section('Nota', h('textarea', { rows: 2, value: g.note || '', placeholder: 'Motivazione / riferimento requisito', onchange: function (e) { g.note = e.target.value; Store.save(data); } })),
      section('Comportamento effettivo della transizione',
        h('ul', { class: 'help' }, ExecutionPlan.describePolicy(data, o, pol).map(function (d) { return h('li', null, d); }))),
      h('div', { class: 'panel-actions' },
        h('button', { onclick: function () { select(null); } }, '← Offerta'),
        idx > 0 ? h('button', { onclick: function () { moveGate(g, -1); } }, '◀ Prima') : null,
        idx < siblings.length - 1 ? h('button', { onclick: function () { moveGate(g, 1); } }, 'Dopo ▶') : null,
        h('button', { class: 'danger', onclick: function () { removeGate(g.id); } }, '🗑 Elimina barra')));
  }

  /* ---------------- simulazione: log ---------------- */
  function renderSimLog() {
    const el = $('simlog'); el.innerHTML = '';
    if (!simMode || !lastSim) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const f = lastSim.final;
    const label = { COMPLETED: '✔ Completato', STOPPED: '⛔ Fermato', WAITING: '⏸ In attesa', FAILED: '✖ Nessun prodotto completato', NO_PRODUCTS: '— Nessun prodotto' }[f.status];
    el.append(
      h('div', { class: 'simlog-head' },
        h('b', null, 'Simulazione'),
        h('span', { class: 'sim-final f-' + f.status.toLowerCase() }, label),
        h('span', { class: 'sim-msg' }, f.message),
        h('div', { class: 'spacer' }),
        h('button', { class: 'small', onclick: function () { delete simOutcomes[offerId]; renderBoard(); renderSimLog(); } }, 'Tutti OK'),
        h('button', { class: 'small', onclick: randomScenario }, '🎲 Scenario casuale')),
      h('div', { class: 'simlog-body' }, lastSim.log.map(function (l) { return h('div', { class: 'log' + (l.kind ? ' log-' + l.kind : '') }, l.msg); })));
  }

  /* ---------------- execution plan ---------------- */
  function copyText(txt) {
    const fallback = function () {
      const ta = h('textarea', { value: txt, style: { position: 'fixed', top: '-1000px' } });
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('JSON copiato', 'ok'); } catch (e) { toast('Copia non riuscita', 'error'); }
      ta.remove();
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(function () { toast('JSON copiato', 'ok'); }, fallback);
    else fallback();
  }

  /* Anteprima del BPMN generato (bpmn-js, importato alla prima apertura della scheda: serve un contenitore visibile). */
  function bpmnPreview(plan) {
    const canvas = h('div', { class: 'bpmn-canvas' });
    const status = h('div', { class: 'bpmn-status muted' });
    const el = h('div', { class: 'bpmn-preview' },
      h('div', { class: 'bpmn-toolbar' },
        h('span', { class: 'muted' }, 'Processo Camunda 8 generato dall\'Execution Plan · rotella = zoom, trascina = sposta'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'small', onclick: function () { if (viewer) viewer.get('canvas').zoom('fit-viewport', 'auto'); } }, '⤢ Adatta'),
        h('button', { class: 'small', onclick: function () { const f = Exporters.get('camunda').files(plan)[0]; Store.downloadText(f.content, f.name, f.mime); } }, '⭳ .bpmn')),
      canvas, status);
    let viewer = null;
    el._show = function () {
      if (viewer) return;
      if (typeof BpmnJS === 'undefined') { status.textContent = 'bpmn-js non caricato.'; return; }
      viewer = new BpmnJS({ container: canvas });
      viewer.importXML(Exporters.buildBpmn(plan)).then(function (r) {
        viewer.get('canvas').zoom('fit-viewport', 'auto');
        status.textContent = r.warnings && r.warnings.length ? r.warnings.length + ' avvisi di import: ' + r.warnings.map(function (w) { return w.message; }).join('; ') : '';
      }).catch(function (err) { status.textContent = 'Errore di import BPMN: ' + err.message; status.classList.add('missing'); });
    };
    return el;
  }

  /* Export verso i motori: scelta del motore, file generati, anteprima, download/copia. */
  function enginesView(plan) {
    const root = h('div', { class: 'engines' });
    let current = Exporters.list[0];
    let fileIdx = 0;
    function draw() {
      root.innerHTML = '';
      let files;
      try { files = current.files(plan); } catch (e) { files = [{ name: 'errore.txt', mime: 'text/plain', content: 'Errore di generazione: ' + e.message }]; }
      if (fileIdx >= files.length) fileIdx = 0;
      const f = files[fileIdx];
      root.append(
        h('div', { class: 'engine-list' }, Exporters.list.map(function (e) {
          return h('button', { class: 'engine' + (e === current ? ' active' : ''), onclick: function () { current = e; fileIdx = 0; draw(); } }, e.label);
        })),
        h('div', { class: 'engine-body' },
          h('ul', { class: 'help engine-notes' }, current.notes.map(function (n) { return h('li', null, n); })),
          h('div', { class: 'engine-files' },
            files.map(function (x, i) { return h('button', { class: 'tab' + (i === fileIdx ? ' active' : ''), onclick: function () { fileIdx = i; draw(); } }, x.name); }),
            h('div', { class: 'spacer' }),
            h('button', { class: 'small primary', onclick: function () { Store.downloadText(f.content, f.name, f.mime); } }, '⭳ Scarica'),
            files.length > 1 ? h('button', { class: 'small', onclick: function () { files.forEach(function (x, i) { setTimeout(function () { Store.downloadText(x.content, x.name, x.mime); }, i * 300); }); } }, '⭳ Tutti (' + files.length + ')') : null,
            h('button', { class: 'small', onclick: function () { copyText(f.content); } }, '⧉ Copia')),
          h('pre', { class: 'json engine-pre' }, f.content)));
    }
    draw();
    return root;
  }

  function showPlan() {
    const o = offer();
    if (!o) return;
    const plan = ExecutionPlan.build(data, o);
    const json = JSON.stringify(plan, null, 2);
    const yaml = ExecutionPlan.toYaml(plan);
    const views = [
      { label: 'Vista leggibile', el: ExecutionPlan.render(data, plan) },
      { label: 'Albero', el: ExecutionPlan.renderTree(data, plan) },
      { label: 'Diagramma BPMN', el: bpmnPreview(plan), onShow: function (el) { el._show(); } },
      { label: 'Export motori', el: enginesView(plan) },
      { label: 'JSON', el: h('pre', { class: 'json' }, json) },
      { label: 'YAML', el: h('pre', { class: 'json' }, yaml) }
    ];
    const tabs = views.map(function (v, i) {
      return h('button', { class: 'tab' + (i === 0 ? ' active' : ''), onclick: function () {
        views.forEach(function (x, j) { x.el.classList.toggle('hidden', j !== i); tabs[j].classList.toggle('active', j === i); });
        if (v.onShow) v.onShow(v.el);
      } }, v.label);
    });
    views.forEach(function (v, i) { if (i) v.el.classList.add('hidden'); });
    const svgText = function () {
      return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(views[1].el.querySelector('svg'));
    };
    Util.modal('Execution Plan — ' + o.name, [h('div', { class: 'tabs-inline' }, tabs)].concat(views.map(function (v) { return v.el; })), [
      { label: '⭳ JSON', class: 'primary', onClick: function () { Store.download(plan, 'execution-plan-' + o.id + '.json'); } },
      { label: '⭳ YAML', class: 'primary', onClick: function () { Store.downloadText(yaml, 'execution-plan-' + o.id + '.yaml', 'application/yaml'); } },
      { label: '⭳ Albero (SVG)', onClick: function () { Store.downloadText(svgText(), 'execution-plan-' + o.id + '.svg', 'image/svg+xml'); } },
      { label: '⧉ Copia JSON', onClick: function () { copyText(json); } },
      { label: '⧉ Copia YAML', onClick: function () { copyText(yaml); } },
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

  /* ---------------- vista DSL ---------------- */
  function dslFiles(o) {
    return Exporters.get('temporal').files(ExecutionPlan.build(data, o));
  }

  function currentDsl(o) {
    return Exporters.toYaml(DslImport.exportMain(data, o));
  }

  function applyDsl(text) {
    const o = offer();
    const res = DslImport.apply(data, text, o);
    if (!res.ok) {
      dslDrafts[o.id] = text;
      dslMessages = { kind: 'error', items: res.errors };
      renderOfferbar(); renderDsl();
      return;
    }
    const n = res.offer;
    if (n.id !== o.id && data.offers.some(function (x) { return x.id === n.id; })) {
      dslDrafts[o.id] = text;
      dslMessages = { kind: 'error', items: ['Esiste già un\'offerta con id ' + n.id + '.'] };
      renderDsl();
      return;
    }
    if (o.generation && !n.generation) n.generation = o.generation;
    data.offers[data.offers.indexOf(o)] = n;
    delete dslDrafts[o.id];
    offerId = n.id;
    selection = null;
    Store.save(data);
    validation = Validation.validateOffer(data, n);
    dslMessages = { kind: 'ok', items: ['DSL applicato: la dashboard è aggiornata.' + (validation.ok ? '' : ' Attenzione: ' + validation.errors.length + ' errori di validazione.')] };
    renderOfferbar(); renderBanner(); renderDsl();
  }

  function renderDsl() {
    const el = $('dslview'); el.innerHTML = '';
    const o = offer();
    if (!o) { el.append(h('div', { class: 'empty' }, 'Nessuna offerta selezionata.')); return; }
    const canonicalText = currentDsl(o);
    const draft = dslDrafts[o.id];
    const status = h('span', { class: 'dsl-status' });
    let timer = null;
    const area = h('textarea', {
      class: 'dsl-editor', spellcheck: 'false', value: draft != null ? draft : canonicalText,
      oninput: function () {
        dslDrafts[o.id] = area.value === canonicalText ? undefined : area.value;
        if (dslDrafts[o.id] === undefined) delete dslDrafts[o.id];
        clearTimeout(timer);
        timer = setTimeout(function () {
          const p = DslImport.parse(area.value);
          status.textContent = p.error ? '✖ ' + p.error : (area.value === canonicalText ? '✔ allineato alla dashboard' : '● modifiche non applicate');
          status.className = 'dsl-status ' + (p.error ? 'err' : area.value === canonicalText ? 'ok' : 'warn');
        }, 250);
      },
      onkeydown: function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); applyDsl(area.value); }
        if (e.key === 'Tab') { e.preventDefault(); const s = area.selectionStart; area.setRangeText('  ', s, area.selectionEnd, 'end'); }
      }
    });
    status.textContent = draft != null ? '● modifiche non applicate' : '✔ allineato alla dashboard';
    status.className = 'dsl-status ' + (draft != null ? 'warn' : 'ok');
    const files = dslFiles(o);
    el.append(
      h('div', { class: 'dsl-main' },
        h('div', { class: 'dsl-toolbar' },
          h('b', null, files[0].name), status, h('div', { class: 'spacer' }),
          h('button', { class: 'primary', title: 'Ctrl+S', onclick: function () { applyDsl(area.value); } }, '⟲ Applica alla dashboard'),
          h('button', { disabled: draft == null, onclick: function () { delete dslDrafts[o.id]; dslMessages = null; renderOfferbar(); renderDsl(); } }, '✕ Scarta modifiche'),
          h('button', { onclick: function () { copyText(area.value); } }, '⧉ Copia'),
          h('button', { title: 'Scarica il DSL da pubblicare su Temporal (principale + sotto-workflow)', onclick: function () {
            if (dslDrafts[o.id]) { toast('Applica o scarta le modifiche prima di esportare', 'warn'); return; }
            files.forEach(function (f) { Store.downloadText(f.content, f.name, f.mime); });
          } }, '⭳ Esporta DSL (' + files.length + ' file)')),
        dslMessages ? h('div', { class: 'dsl-messages ' + dslMessages.kind }, dslMessages.items.map(function (m) { return h('div', null, m); })) : null,
        area),
      h('aside', { class: 'dsl-side' },
        h('h4', null, 'Cosa si può modificare qui'),
        h('ul', { class: 'help' },
          h('li', null, h('code', null, 'document.title'), ': nome dell\'offerta'),
          h('li', null, h('code', null, 'document.metadata.offer'), ': id, descrizione, prodotti'),
          h('li', null, h('code', null, 'metadata.block'), ' di ogni blocco: prodotti, dipendenze, configurazione (input, esiti, KO con task, notifiche, callback)'),
          h('li', null, h('code', null, 'metadata.gates'), ' delle barre: regole di passaggio'),
          h('li', null, 'il retry dei blocchi (', h('code', null, 'catch.retry'), ')')),
        h('div', { class: 'muted' }, 'Il resto del DSL è generato: modificalo dalla vista visuale. Le modifiche non riportabili vengono segnalate con il punto esatto e restano come bozza.'),
        files.length > 1 ? h('h4', null, 'Sotto-workflow (generati)') : null,
        files.slice(1).map(function (f) { return h('details', null, h('summary', null, f.name), h('pre', { class: 'json' }, f.content)); })));
  }

  /* ---------------- bootstrap ---------------- */
  const requested = new URLSearchParams(location.search).get('offer');
  if (requested && data.offers.some(function (x) { return x.id === requested; })) offerId = requested;
  if (new URLSearchParams(location.search).get('view') === 'dsl') view = 'dsl';
  $('btn-plan').addEventListener('click', showPlan);
  initPanelGrip();
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
