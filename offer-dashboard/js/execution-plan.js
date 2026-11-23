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
    if (t.productResults) a.productResults = JSON.parse(JSON.stringify(t.productResults));
    if (c.notify.onOk || c.notify.onKo) a.notification = { channel: 'EMAIL', template: c.notify.template, onOk: !!c.notify.onOk, onKo: !!c.notify.onKo };
    if (Conditions.isActive(c.when)) a.when = { join: c.when.join, clauses: Conditions.clone(c.when.clauses), text: Conditions.describe(data, offer, c.when) };
    if (t.type === 'async') a.async = { callbackTopic: c.async.callbackTopic, timeoutHours: Number(c.async.timeoutHours) || null };
    if (t.extensions && (t.extensions.request || t.extensions.ko)) a.extensionPoints = { pluggableRequest: !!t.extensions.request, pluggableKo: !!t.extensions.ko };
    return a;
  }

  function describePolicy(data, offer, pol, gate) {
    const parts = [];
    if (pol.dontWait.length) parts.push('Non attendere: ' + pol.dontWait.map(function (id) { return Model.blockLabel(data, offer, id); }).join('; '));
    else parts.push('Attendi l\'esito di tutti i blocchi collegati');
    if (pol.stopOnKo) parts.push(pol.stopOnKo === 'ALL' ? 'Ferma tutta l\'offerta se c\'è almeno un KO' : 'Ferma tutta l\'offerta se KO su ' + pol.stopOnKo.map(function (p) { return Model.productName(data, p); }).join(', '));
    parts.push(pol.koPolicy === 'CONTINUE_ON_KO' && !pol.conflict ? 'I prodotti KO proseguono comunque' : 'Proseguono solo i prodotti OK' + (pol.explicit ? '' : ' (default)'));
    Model.routesOf(gate).forEach(function (x) { parts.push('Instradamento (prima delle altre regole): ' + Model.ruleText(data, offer, x.rule)); });
    return parts;
  }

  function build(data, offer) {
    const validation = Validation.validateOffer(data, offer);
    const st = Model.structure(offer);
    const topIdx = {};
    st.top.forEach(function (id, i) { topIdx[id] = i; });
    const services = {};
    const acts = {}, gates = {};
    offer.blocks.forEach(function (b) {
      const a = activity(data, offer, b);
      acts[b.id] = a;
      const t = Model.task(data, b.taskId);
      if (t) {
        services[t.id] = services[t.id] || {
          taskId: t.id, name: t.name, description: t.description || '', executionType: a.executionType,
          service: a.service, compatibleProducts: t.compatibleProducts.slice(),
          inputs: t.inputs.map(function (x) { return { name: x.name, type: x.type || 'string', required: !!x.required }; }),
          outputs: t.outputs.map(function (x) { return { name: x.name, type: x.type || 'string', description: x.description || '' }; }),
          outcomes: t.outcomes.slice(), extensionPoints: a.extensionPoints || null, usedIn: []
        };
        services[t.id].usedIn.push({ activityId: b.id, products: b.products.slice(), invocation: a.invocation.mode });
      }
    });
    offer.gates.forEach(function (g) {
      const pol = Model.effectivePolicy([g]);
      const scope = Model.scopeProducts(offer, g.id);
      gates[g.id] = {
        gateId: g.id, note: g.note || undefined, dependsOn: (g.dependsOn || []).slice(),
        kind: (g.dependsOn || []).length > 1 ? 'JOIN' : 'BRANCH', products: scope,
        rules: g.rules.map(function (r) {
          const o = { type: r.type };
          if (r.blockId) o.blockId = r.blockId;
          if (r.products && r.products.length) o.products = r.products.slice();
          if (r.type === 'ROUTE') { o.when = { join: r.when.join, clauses: Conditions.clone(r.when.clauses), text: Conditions.describe(data, offer, r.when) }; o.to = r.to; if (r.to !== 'STOP') { o.maxIterations = r.maxIterations; o.onExceed = r.onExceed; } }
          return o;
        }),
        routes: Model.routesOf(g).map(function (x) {
          return { key: x.key, gateId: g.id, to: x.rule.to, backward: x.rule.to !== 'STOP' && topIdx[x.rule.to] != null && topIdx[x.rule.to] <= topIdx[g.id], maxIterations: x.rule.to === 'STOP' ? null : x.rule.maxIterations, onExceed: x.rule.to === 'STOP' ? null : x.rule.onExceed, condition: Conditions.describe(data, offer, x.rule.when), text: Model.ruleText(data, offer, x.rule) };
        }),
        effectivePolicy: {
          dontWait: pol.dontWait,
          stopOnKo: pol.stopOnKo,
          koProducts: pol.koPolicy === 'CONTINUE_ON_KO' && !pol.conflict ? 'CONTINUE' : 'EXCLUDE',
          description: describePolicy(data, offer, pol, g)
        }
      };
    });
    const conv = function (n) {
      return n.type === 'node' ? { type: 'node', kind: acts[n.id] ? 'activity' : 'gate', id: n.id } : { type: n.type, items: n.items.map(conv) };
    };
    const ordered = st.order.length ? st.order : offer.blocks.map(function (b) { return b.id; }).concat(offer.gates.map(function (g) { return g.id; }));
    return {
      planVersion: '2.0',
      generatedAt: new Date().toISOString(),
      offer: { id: offer.id, name: offer.name, description: offer.description || '' },
      // input generale del processo: campi della pratica (e radici, per riconoscere i percorsi nelle mappature)
      practice: { fields: (data.practice && data.practice.fields || []).map(function (f) { return { name: f.name, type: f.type || 'string', required: !!f.required }; }),
        roots: Fields.rootsOf(data.practice && data.practice.fields) },
      products: offer.products.map(function (p) { const x = Model.product(data, p) || { id: p, name: p }; return { id: x.id, name: x.name, category: x.category || '' }; }),
      summary: {
        products: offer.products.length,
        activities: offer.blocks.length,
        services: Object.keys(services).length,
        gates: offer.gates.length,
        valid: validation.ok
      },
      // struttura del flusso: sequenze (seq) e rami paralleli (par) di attività e gate; top = nodi della sequenza principale
      flow: st.tree && !st.errors.length ? conv(st.tree) : null,
      top: st.top.slice(),
      order: ordered,
      activities: ordered.filter(function (id) { return acts[id]; }).map(function (id) { return acts[id]; }),
      gates: ordered.filter(function (id) { return gates[id]; }).map(function (id) { return gates[id]; }),
      servicesToDevelop: Object.keys(services).map(function (k) { return services[k]; }),
      // configurazione originale: gli exporter la scrivono nei metadata del DSL
      source: { format: 2, offer: Model.canonicalOffer(offer) },
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
    const acts = {}, gates = {};
    plan.activities.forEach(function (a) { acts[a.activityId] = a; });
    plan.gates.forEach(function (g) { gates[g.gateId] = g; });
    const nameOf = function (id) { return acts[id] ? acts[id].taskName : 'Gate ' + id; };
    const activityView = function (a) {
      return h('div', { class: 'plan-act' },
        h('div', { class: 'plan-act-title' }, h('b', null, a.taskName), ' ', h('code', null, a.activityId),
          a.when ? h('span', { class: 'badge cond' }, 'SE ' + a.when.text) : null,
          a.executionType === 'ASYNC_CALLBACK' ? h('span', { class: 'badge async' }, 'async · ' + (a.async.callbackTopic || 'topic?')) : null,
          a.dependsOn.length ? h('span', { class: 'muted' }, ' dopo: ' + a.dependsOn.map(nameOf).join(', ')) : null),
        h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, ['Prodotti', 'Servizio', 'Invocazione', 'Input', 'Output', 'Esiti', 'Retry'].map(function (x) { return h('th', null, x); }))),
          h('tbody', null, h('tr', null,
            h('td', null, pn(a.products)),
            h('td', null, h('code', null, (a.service.method || '') + ' ' + (a.service.path || ''))),
            h('td', null, invLabel[a.invocation.mode] + ' (' + a.invocation.calls + ')'),
            h('td', null, a.input.map(function (i) { return h('div', null, h('code', null, i.name), ' ← ', i.source ? h('span', null, i.source) : h('span', { class: 'missing' }, 'non mappato')); })),
            h('td', null, a.output.map(function (o) { return h('div', null, h('code', null, o.name)); })),
            h('td', null, outcomeText(a.outcomes)),
            h('td', null, a.retry.maxAttempts ? a.retry.maxAttempts + ' × ' + a.retry.intervalSec + 's' : '—'))))); 
    };
    const gateView = function (g) {
      return h('div', { class: 'plan-gate' },
        h('div', { class: 'plan-gate-title' }, (g.kind === 'JOIN' ? 'Gate join ' : 'Gate di ramo ') + g.gateId + ' · dopo ' + (g.dependsOn.map(nameOf).join(', ') || '—') + (g.products.length ? ' · prodotti: ' + pn(g.products) : '')),
        g.note ? h('div', { class: 'muted' }, g.note) : null,
        h('ul', null, g.effectivePolicy.description.map(function (d) { return h('li', null, d); })));
    };
    const flowView = function (n) {
      if (n.type === 'node') return n.kind === 'activity' ? activityView(acts[n.id]) : gateView(gates[n.id]);
      if (n.type === 'seq') return h('div', { class: 'plan-seq' }, n.items.map(flowView));
      return h('div', { class: 'plan-par' },
        h('div', { class: 'plan-par-label' }, 'In parallelo · ' + n.items.length + ' rami indipendenti'),
        h('div', { class: 'plan-par-branches' }, n.items.map(function (b) { return h('div', { class: 'plan-branch' }, flowView(b)); })));
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
      h('section', { class: 'plan-step' },
        h('h4', null, 'Flusso'),
        plan.flow ? flowView(plan.flow) : h('div', { class: 'muted' }, plan.activities.length ? 'Il grafo non è valido: correggi gli errori per vedere il flusso.' : 'Nessun blocco: i prodotti attraversano l\'offerta senza attività.')),
      h('section', { class: 'plan-step' },
        h('h4', null, 'Servizi da sviluppare / esporre'),
        h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, ['Task', 'Servizio', 'Tipo', 'Input', 'Output', 'Esiti', 'Estensioni', 'Utilizzo'].map(function (x) { return h('th', null, x); }))),
          h('tbody', null, plan.servicesToDevelop.map(function (s) {
            return h('tr', null,
              h('td', null, h('b', null, s.name), h('div', { class: 'muted' }, s.description)),
              h('td', null, h('code', null, s.service.method + ' ' + s.service.path)),
              h('td', null, s.executionType === 'ASYNC_CALLBACK' ? 'async' : 'sync'),
              h('td', null, s.inputs.map(function (i) { return h('div', null, h('code', null, i.name), i.required ? ' *' : ''); })),
              h('td', null, s.outputs.map(function (o) { return h('div', null, h('code', null, o.name)); })),
              h('td', null, s.outcomes.map(function (o) { return Model.OUTCOMES[o] || o; }).join(', ')),
              h('td', null, s.extensionPoints ? [s.extensionPoints.pluggableRequest ? 'request pluggable' : null, s.extensionPoints.pluggableKo ? 'KO pluggable' : null].filter(Boolean).join(', ') : '—'),
              h('td', null, s.usedIn.map(function (u) { return h('div', null, u.activityId + ': ' + pn(u.products)); })));
          })))));
  }
  function kpi(label, value) { return h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, String(value)), h('div', { class: 'kpi-l' }, label)); }

  window.ExecutionPlan = { build: build, render: render, describePolicy: describePolicy, toYaml: function (v) { return Exporters.toYaml(v); } };
})();
