/* Generazione dell'Execution Plan: configurazione consumabile dal motore e documento per i team backend. */
(function () {
  const h = Util.h;

  function activity(data, offer, b) {
    const t = Model.task(data, b.taskId) || { name: b.taskId, inputs: [], outputs: [], outcomes: [], api: {}, extensions: {} };
    const c = b.config;
    const perOffer = c.callMode === 'perOffer';
    const outcomes = {
      OK: { action: 'CONTINUE', notifyCustomer: !!c.notify.onOk }
    };
    if (t.outcomes.indexOf('KO') >= 0) outcomes.KO = { action: c.onKo === 'IGNORE' ? 'CONTINUE_NON_BLOCKING' : 'MARK_PRODUCT_KO', notifyCustomer: !!c.notify.onKo };
    if (t.outcomes.indexOf('KO_TASK') >= 0 && c.koTask.enabled) outcomes.KO_WITH_TASK = { action: 'OPEN_MANUAL_TASK', queue: c.koTask.queue, slaHours: Number(c.koTask.slaHours) || null, resumeOn: 'MANUAL_TASK_COMPLETED' };
    const a = {
      activityId: b.id,
      taskId: b.taskId,
      taskName: t.name,
      service: { method: t.api.method, path: t.api.path },
      executionType: t.type === 'async' ? 'ASYNC_CALLBACK' : 'SYNC',
      invocation: perOffer
        ? { mode: 'SINGLE_CALL_FOR_N_PRODUCTS', calls: 1 }
        : { mode: 'ONE_CALL_PER_PRODUCT', calls: b.products.length },
      products: b.products.slice(),
      dependsOn: b.dependsOn.slice(),
      input: t.inputs.map(function (i) { return { name: i.name, type: i.type || 'string', required: !!i.required, source: (c.inputMapping[i.name] || '').trim() || null }; }),
      output: t.outputs.map(function (o) { return { name: o.name, type: o.type || 'string', target: 'esiti.' + b.id + '.' + o.name }; }),
      retry: { maxAttempts: Number(c.retry.count) || 0, intervalSec: Number(c.retry.intervalSec) || 0 },
      outcomes: outcomes
    };
    if (c.notify.onOk || c.notify.onKo) a.notification = { channel: 'EMAIL', template: c.notify.template, onOk: !!c.notify.onOk, onKo: !!c.notify.onKo };
    if (t.type === 'async') a.async = { callbackTopic: c.async.callbackTopic, timeoutHours: Number(c.async.timeoutHours) || null };
    if (t.extensions && (t.extensions.request || t.extensions.ko)) a.extensionPoints = { pluggableRequest: !!t.extensions.request, pluggableKo: !!t.extensions.ko };
    return a;
  }

  function describePolicy(data, offer, pol) {
    const parts = [];
    if (pol.dontWait.length) parts.push('Non attendere: ' + pol.dontWait.map(function (id) { return Model.blockLabel(data, offer, id); }).join('; '));
    else parts.push('Attendi l\'esito di tutti i blocchi');
    if (pol.stopOnKo) parts.push(pol.stopOnKo === 'ALL' ? 'Ferma tutta l\'offerta se c\'è almeno un KO' : 'Ferma tutta l\'offerta se KO su ' + pol.stopOnKo.map(function (p) { return Model.productName(data, p); }).join(', '));
    parts.push(pol.koPolicy === 'CONTINUE_ON_KO' && !pol.conflict ? 'I prodotti KO proseguono comunque' : 'Proseguono solo i prodotti OK' + (pol.explicit ? '' : ' (default)'));
    return parts;
  }

  function build(data, offer) {
    const validation = Validation.validateOffer(data, offer);
    const services = {};
    const steps = data.steps.map(function (s, i) {
      const blocks = Model.blocksInStep(offer, s.id);
      const lv = Model.levels(blocks).levels;
      const stages = lv.map(function (level, j) {
        return {
          stage: j + 1,
          execution: level.length > 1 ? 'PARALLEL' : 'SINGLE',
          activities: level.map(function (b) {
            const a = activity(data, offer, b);
            const t = Model.task(data, b.taskId);
            if (t) {
              services[t.id] = services[t.id] || {
                taskId: t.id, name: t.name, description: t.description || '', scope: t.scope, executionType: a.executionType,
                service: a.service, compatibleProducts: t.compatibleProducts.slice(),
                inputs: t.inputs.map(function (x) { return { name: x.name, type: x.type || 'string', required: !!x.required }; }),
                outputs: t.outputs.map(function (x) { return { name: x.name, type: x.type || 'string', description: x.description || '' }; }),
                outcomes: t.outcomes.slice(), extensionPoints: a.extensionPoints || null, usedIn: []
              };
              services[t.id].usedIn.push({ step: s.id, activityId: b.id, products: b.products.slice(), invocation: a.invocation.mode });
            }
            return a;
          })
        };
      });
      const st = { order: i + 1, stepId: s.id, name: s.name, stages: stages };
      if (i < data.steps.length - 1) {
        const gates = Model.gatesAfter(offer, s.id);
        const pol = Model.effectivePolicy(gates);
        st.exitGate = {
          to: data.steps[i + 1].id,
          gates: gates.map(function (g) { return { gateId: g.id, note: g.note || undefined, rules: g.rules.map(function (r) { const o = { type: r.type }; if (r.blockId) o.blockId = r.blockId; if (r.products && r.products.length) o.products = r.products.slice(); return o; }) }; }),
          effectivePolicy: {
            waitFor: blocks.filter(function (b) { return pol.dontWait.indexOf(b.id) < 0; }).map(function (b) { return b.id; }),
            dontWait: pol.dontWait,
            stopOnKo: pol.stopOnKo,
            koProducts: pol.koPolicy === 'CONTINUE_ON_KO' && !pol.conflict ? 'CONTINUE' : 'EXCLUDE',
            description: describePolicy(data, offer, pol)
          }
        };
      }
      return st;
    });

    const activitiesCount = offer.blocks.length;
    return {
      planVersion: '1.0',
      generatedAt: new Date().toISOString(),
      offer: { id: offer.id, name: offer.name, description: offer.description || '' },
      // input generale del processo: campi della pratica (e radici, per riconoscere i percorsi nelle mappature)
      practice: { fields: (data.practice && data.practice.fields || []).map(function (f) { return { name: f.name, type: f.type || 'string', required: !!f.required }; }),
        roots: Fields.rootsOf(data.practice && data.practice.fields) },
      products: offer.products.map(function (p) { const x = Model.product(data, p) || { id: p, name: p }; return { id: x.id, name: x.name, category: x.category || '' }; }),
      summary: {
        products: offer.products.length,
        activities: activitiesCount,
        services: Object.keys(services).length,
        gates: offer.gates.length,
        valid: validation.ok
      },
      steps: steps,
      servicesToDevelop: Object.keys(services).map(function (k) { return services[k]; }),
      // configurazione originale: permette agli exporter di scrivere metadata da cui ricostruire l'offerta (DSL → dashboard)
      source: { format: 1, offer: Model.canonicalOffer(offer) },
      validation: {
        errors: validation.errors.map(function (e) { return e.msg; }),
        warnings: validation.warnings.map(function (e) { return e.msg; }),
        infos: validation.infos.map(function (e) { return e.msg; })
      }
    };
  }

  /* Vista leggibile (HTML) dell'Execution Plan. */
  function render(data, plan) {
    const pn = function (ids) { return ids.map(function (p) { return Model.productName(data, p); }).join(', '); };
    const invLabel = { SINGLE_CALL_FOR_N_PRODUCTS: '1 chiamata per N prodotti', ONE_CALL_PER_PRODUCT: '1 chiamata per prodotto' };
    const outcomeText = function (o) {
      const r = [];
      Object.keys(o).forEach(function (k) {
        const v = o[k];
        let s = k.replace('KO_WITH_TASK', 'KO con task') + ' → ' + ({ CONTINUE: 'prosegui', MARK_PRODUCT_KO: 'prodotto KO', CONTINUE_NON_BLOCKING: 'prosegui (non bloccante)', OPEN_MANUAL_TASK: 'task manuale' }[v.action] || v.action);
        if (v.queue) s += ' su coda ' + v.queue + (v.slaHours ? ' (SLA ' + v.slaHours + 'h)' : '');
        if (v.notifyCustomer) s += ' + mail';
        r.push(s);
      });
      return r.join(' · ');
    };
    const v = plan.validation;
    return h('div', { class: 'plan' },
      h('div', { class: 'plan-head' },
        h('h3', null, plan.offer.name),
        h('div', { class: 'muted' }, plan.offer.description),
        h('div', { class: 'plan-kpi' },
          kpi('Prodotti', plan.summary.products), kpi('Attività', plan.summary.activities),
          kpi('Servizi', plan.summary.services), kpi('Gate', plan.summary.gates),
          kpi('Validazione', plan.summary.valid ? 'OK' : v.errors.length + ' errori')),
        h('div', null, 'Prodotti: ', plan.products.map(function (p) { return h('span', { class: 'chip' }, p.name); }))),
      (v.errors.length || v.warnings.length) ? h('div', { class: 'plan-validation' },
        v.errors.map(function (e) { return h('div', { class: 'msg error' }, '✖ ' + e); }),
        v.warnings.map(function (e) { return h('div', { class: 'msg warning' }, '⚠ ' + e); })) : null,
      plan.steps.map(function (s) {
        return h('section', { class: 'plan-step' },
          h('h4', null, s.order + '. ' + s.name),
          s.stages.length ? s.stages.map(function (st) {
            return h('div', { class: 'plan-stage' },
              h('div', { class: 'plan-stage-label' }, 'Stage ' + st.stage + (st.execution === 'PARALLEL' ? ' — in parallelo' : '')),
              h('table', { class: 'tbl' },
                h('thead', null, h('tr', null, ['Attività', 'Prodotti', 'Servizio', 'Invocazione', 'Input', 'Output', 'Esiti', 'Retry'].map(function (x) { return h('th', null, x); }))),
                h('tbody', null, st.activities.map(function (a) {
                  return h('tr', null,
                    h('td', null, h('b', null, a.taskName), a.dependsOn.length ? h('div', { class: 'muted' }, 'dopo: ' + a.dependsOn.join(', ')) : null, a.executionType === 'ASYNC_CALLBACK' ? h('div', { class: 'badge async' }, 'async · ' + (a.async.callbackTopic || 'topic?')) : null),
                    h('td', null, pn(a.products)),
                    h('td', null, h('code', null, (a.service.method || '') + ' ' + (a.service.path || ''))),
                    h('td', null, invLabel[a.invocation.mode] + ' (' + a.invocation.calls + ')'),
                    h('td', null, a.input.map(function (i) { return h('div', null, h('code', null, i.name), ' ← ', i.source ? h('span', null, i.source) : h('span', { class: 'missing' }, 'non mappato')); })),
                    h('td', null, a.output.map(function (o) { return h('div', null, h('code', null, o.name)); })),
                    h('td', null, outcomeText(a.outcomes)),
                    h('td', null, a.retry.maxAttempts ? a.retry.maxAttempts + ' × ' + a.retry.intervalSec + 's' : '—'));
                }))));
          }) : h('div', { class: 'muted' }, 'Nessuna attività: i prodotti attraversano lo step.'),
          s.exitGate ? h('div', { class: 'plan-gate' },
            h('div', { class: 'plan-gate-title' }, 'Gate → ' + plan.steps[s.order].name),
            h('ul', null, s.exitGate.effectivePolicy.description.map(function (d) { return h('li', null, d); }))) : null);
      }),
      h('section', { class: 'plan-step' },
        h('h4', null, 'Servizi da sviluppare / esporre'),
        h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, ['Task', 'Servizio', 'Tipo', 'Input', 'Output', 'Esiti', 'Estensioni', 'Utilizzo'].map(function (x) { return h('th', null, x); }))),
          h('tbody', null, plan.servicesToDevelop.map(function (s) {
            return h('tr', null,
              h('td', null, h('b', null, s.name), h('div', { class: 'muted' }, s.description)),
              h('td', null, h('code', null, s.service.method + ' ' + s.service.path)),
              h('td', null, (s.scope === 'common' ? 'Common' : 'Verticale') + ' · ' + (s.executionType === 'ASYNC_CALLBACK' ? 'async' : 'sync')),
              h('td', null, s.inputs.map(function (i) { return h('div', null, h('code', null, i.name), i.required ? ' *' : ''); })),
              h('td', null, s.outputs.map(function (o) { return h('div', null, h('code', null, o.name)); })),
              h('td', null, s.outcomes.map(function (o) { return Model.OUTCOMES[o] || o; }).join(', ')),
              h('td', null, s.extensionPoints ? [s.extensionPoints.pluggableRequest ? 'request pluggable' : null, s.extensionPoints.pluggableKo ? 'KO pluggable' : null].filter(Boolean).join(', ') : '—'),
              h('td', null, s.usedIn.map(function (u) { return h('div', null, Model.step(data, u.step).name + ': ' + pn(u.products)); })));
          })))));
  }

  function kpi(label, value) { return h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, String(value)), h('div', { class: 'kpi-l' }, label)); }

  /* ---------------- Vista ad albero (SVG) ---------------- */
  const SVGNS = 'http://www.w3.org/2000/svg';
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

  /*
   * Albero verticale: radice = offerta, si dirama in una corsia per prodotto; i blocchi condivisi
   * congiungono più corsie e poi le ridiramano; i gate sono barre orizzontali che tagliano l'albero.
   */
  function renderTree(data, plan) {
    const C = { blue: '#2c5d7c', async: '#46598a', orange: '#e07b39', orangeD: '#b85d22', line: '#7f93a3', text: '#1d2733', muted: '#6b7785', band: ['#f7f9fb', '#eef3f7'], ok: '#2e8b57' };
    const lanes = plan.products.map(function (p) { return p.id; });
    const n = Math.max(lanes.length, 1);
    const GUT = 180, LW = 175, NH = 50, VG = 30, GH = 34, PAD = 12;
    const W = GUT + n * LW + 20;
    const laneX = function (i) { return GUT + i * LW + LW / 2; };
    const bands = s('g'), lines = s('g'), nodes = s('g'), bars = s('g'), labels = s('g');
    const lastY = {}, dashed = {};
    const font = 'Segoe UI, system-ui, sans-serif';

    const vline = function (i, y1, y2, dash, color) {
      if (y2 <= y1) return;
      lines.appendChild(s('line', { x1: laneX(i), y1: y1, x2: laneX(i), y2: y2, stroke: color || C.line, 'stroke-width': 2, 'stroke-dasharray': dash ? '6 4' : null }));
    };
    const curve = function (x1, y1, x2, y2) {
      const my = (y1 + y2) / 2;
      lines.appendChild(s('path', { d: 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + my + ' ' + x2 + ',' + my + ' ' + x2 + ',' + y2, fill: 'none', stroke: C.line, 'stroke-width': 2 }));
    };
    const pill = function (cx, y, w, h, fill, text, color, bold) {
      nodes.appendChild(s('rect', { x: cx - w / 2, y: y, width: w, height: h, rx: h / 2, fill: fill, stroke: color === '#fff' ? null : C.blue, 'stroke-width': 1.5 }));
      nodes.appendChild(s('text', { x: cx, y: y + h / 2 + 4, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': bold ? 700 : 600, fill: color, 'font-family': font }, text));
    };

    let y = 20;
    // Radice: offerta
    const rootW = Math.min(Math.max(n * LW - 40, 220), 420), rootX = GUT + (n * LW) / 2;
    nodes.appendChild(s('rect', { x: rootX - rootW / 2, y: y, width: rootW, height: 46, rx: 10, fill: C.blue }));
    nodes.appendChild(s('text', { x: rootX, y: y + 20, 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 700, fill: '#fff', 'font-family': font }, trunc(plan.offer.name, 48)));
    nodes.appendChild(s('text', { x: rootX, y: y + 37, 'text-anchor': 'middle', 'font-size': 11, fill: '#cfe0ec', 'font-family': font }, 'Offerta · ' + plan.products.length + ' prodotti · ' + plan.summary.activities + ' attività'));
    y += 46;
    const laneTop = y + 40;
    lanes.forEach(function (pid, i) {
      curve(rootX, y, laneX(i), laneTop);
      pill(laneX(i), laneTop, Math.min(LW - 30, 140), 24, '#e7f0f6', trunc(plan.products[i].name, 18), C.blue, true);
      lastY[i] = laneTop + 24; dashed[i] = false;
    });
    y = laneTop + 24 + 10;

    plan.steps.forEach(function (st, si) {
      const stepStart = y;
      y += 26;
      if (!st.stages.length) {
        labels.appendChild(s('text', { x: GUT + 8, y: y + 4, 'font-size': 11, 'font-style': 'italic', fill: C.muted, 'font-family': font }, 'nessuna attività: i prodotti attraversano lo step'));
        y += 14;
      }
      st.stages.forEach(function (stage) {
        // le attività dello stesso stage che condividono corsie vanno su sotto-righe
        const rows = [];
        stage.activities.forEach(function (a) {
          const idx = a.products.map(function (p) { return lanes.indexOf(p); }).filter(function (i) { return i >= 0; });
          const lo = idx.length ? Math.min.apply(null, idx) : 0, hi = idx.length ? Math.max.apply(null, idx) : 0;
          let r = 0;
          while (rows[r] && rows[r].some(function (x) { return !(hi < x.lo || lo > x.hi); })) r++;
          (rows[r] = rows[r] || []).push({ a: a, idx: idx, lo: lo, hi: hi });
        });
        const stageTop = y;
        rows.forEach(function (row, ri) {
          if (ri > 0) y += 12;
          row.forEach(function (it) {
            const a = it.a;
            const x1 = GUT + it.lo * LW + PAD, x2 = GUT + (it.hi + 1) * LW - PAD;
            it.idx.forEach(function (i) { vline(i, lastY[i], y, dashed[i]); });
            const contiguous = it.idx.length === it.hi - it.lo + 1;
            const isAsync = a.executionType === 'ASYNC_CALLBACK';
            const title = a.taskName + '\n' + a.service.method + ' ' + a.service.path + '\nProdotti: ' + a.products.join(', ') +
              '\nInvocazione: ' + a.invocation.mode + ' (' + a.invocation.calls + ')' + (a.dependsOn.length ? '\nDopo: ' + a.dependsOn.join(', ') : '');
            const g = s('g', null, s('title', null, title));
            g.appendChild(s('rect', { x: x1, y: y, width: x2 - x1, height: NH, rx: 8, fill: isAsync ? C.async : C.blue }));
            const maxChars = Math.floor((x2 - x1) / 7.5);
            g.appendChild(s('text', { x: (x1 + x2) / 2, y: y + 21, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 700, fill: '#fff', 'font-family': font }, trunc(a.taskName, maxChars)));
            const sub = [];
            if (a.products.length > 1) sub.push(a.invocation.mode === 'SINGLE_CALL_FOR_N_PRODUCTS' ? '1 chiamata × ' + a.products.length : a.products.length + ' chiamate');
            if (!contiguous) sub.push('solo ' + a.products.map(function (p) { return Model.productName(data, p); }).join(', '));
            if (isAsync) sub.push('async');
            if (a.outcomes.KO_WITH_TASK) sub.push('KO→task');
            g.appendChild(s('text', { x: (x1 + x2) / 2, y: y + 38, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#d6e4ef', 'font-family': font }, trunc(sub.join(' · '), Math.floor((x2 - x1) / 6))));
            nodes.appendChild(g);
            const dontWait = st.exitGate && st.exitGate.effectivePolicy.dontWait.indexOf(a.activityId) >= 0;
            it.idx.forEach(function (i) { lastY[i] = y + NH; dashed[i] = dontWait; });
          });
          y += NH;
        });
        if (stage.execution === 'PARALLEL') {
          labels.appendChild(s('line', { x1: GUT - 10, y1: stageTop, x2: GUT - 10, y2: y,                     stroke: C.orange, 'stroke-width': 3 }));
                    labels.appendChild(s('text', { x: GUT - 16, y: (stageTop + y) / 2 + 4, 'text-anchor': 'end', 'font-size': 10.5, fill: C.orangeD, 'font-family': font }, 'in parallelo'));
        }
        y += 18;
      });
      y += 8;
      const fill = C.band[si % 2];
      bands.appendChild(s('rect', { x: 0, y: stepStart, width: W, height: y - stepStart, fill: fill }));
      bands.appendChild(s('text', { x: 12, y: stepStart + 18, 'font-size': 12.5, 'font-weight': 700, fill: C.blue, 'font-family': font }, (st.order) + '. ' + st.name));

      if (st.exitGate) {
        const gy = y + 8;
        lanes.forEach(function (pid, i) { vline(i, lastY[i], gy, dashed[i]); });
        const desc = st.exitGate.effectivePolicy.description.join(' · ');
        const bar = s('g', null, s('title', null, 'Gate ' + st.name + ' → ' + plan.steps[si + 1].name + '\n' + st.exitGate.effectivePolicy.description.join('\n')));
        bar.appendChild(s('rect', { x: 6, y: gy, width: W - 12, height: GH, rx: 6,                 fill: C.orange, stroke: C.orangeD, 'stroke-width': 1.5 }));
        const gateLabel = '◆ GATE → ' + plan.steps[si + 1].name.toUpperCase();
        const descX = Math.max(GUT + 10, 16 + gateLabel.length * 7.6 + 14);
                bar.appendChild(s('text', { x: 16, y: gy + GH / 2 + 4, 'font-size': 11.5, 'font-weight': 700, fill: '#fff', 'font-family': font }, gateLabel));
                bar.appendChild(s('text', { x: descX, y: gy + GH / 2 + 4, 'font-size': 11.5, fill: '#fff', 'font-family': font }, trunc(desc, Math.floor((W - descX - 10) / 6.3))));
        bars.appendChild(bar);
        lanes.forEach(function (pid, i) { lastY[i] = gy + GH; dashed[i] = false; });
        y = gy + GH + 8;
      }
    });

    // Congiunzione finale
    y += 30;
    const endY = y;
    lanes.forEach(function (pid, i) { vline(i, lastY[i], endY - 30, dashed[i]); curve(laneX(i), endY - 30, rootX, endY); });
    pill(rootX, endY, 200, 30, C.ok, '✔ Offerta completata', '#fff', true);
    y = endY + 30 + 20;

    // Legenda
    const ly = y;
    const legend = s('g');
    legend.appendChild(s('rect', { x: 12, y: ly, width: 16, height: 12, rx: 3, fill: C.blue }));
    legend.appendChild(s('text', { x: 34, y: ly + 10, 'font-size': 11, fill: C.text, 'font-family': font }, 'attività sync'));
    legend.appendChild(s('rect', { x: 120, y: ly, width: 16, height: 12, rx: 3, fill: C.async }));
    legend.appendChild(s('text', { x: 142, y: ly + 10, 'font-size': 11, fill: C.text, 'font-family': font }, 'attività async (callback)'));
    legend.appendChild(s('rect', { x: 300, y: ly, width: 16, height: 12, rx: 3, fill: C.orange }));
    legend.appendChild(s('text', { x: 322, y: ly + 10, 'font-size': 11, fill: C.text, 'font-family': font }, 'gate / milestone'));
    legend.appendChild(s('line', { x1: 430, y1: ly + 6, x2: 466, y2: ly + 6, stroke: C.line, 'stroke-width': 2, 'stroke-dasharray': '6 4' }));
    legend.appendChild(s('text', { x: 472, y: ly + 10, 'font-size': 11, fill: C.text, 'font-family': font }, 'esito non atteso (Non attendere)'));
    y += 24;

    const svgEl = s('svg', { xmlns: SVGNS, width: Math.max(W, 680), height: y, viewBox: '0 0 ' + Math.max(W, 680) + ' ' + y, class: 'plan-tree-svg' },
      s('rect', { x: 0, y: 0, width: Math.max(W, 680), height: y, fill: '#fff' }), bands, lines, nodes, bars, labels, legend);
    return h('div', { class: 'plan-tree' }, svgEl);
  }

  window.ExecutionPlan = { build: build, render: render, describePolicy: describePolicy, toYaml: function (v) { return Exporters.toYaml(v); }, renderTree: renderTree };
})();
