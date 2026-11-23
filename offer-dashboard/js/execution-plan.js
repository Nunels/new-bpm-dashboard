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

  function describePolicy(data, offer, pol, gateStepId) {
    const parts = [];
    if (pol.dontWait.length) parts.push('Non attendere: ' + pol.dontWait.map(function (id) { return Model.blockLabel(data, offer, id); }).join('; '));
    else parts.push('Attendi l\'esito di tutti i blocchi');
    if (pol.stopOnKo) parts.push(pol.stopOnKo === 'ALL' ? 'Ferma tutta l\'offerta se c\'è almeno un KO' : 'Ferma tutta l\'offerta se KO su ' + pol.stopOnKo.map(function (p) { return Model.productName(data, p); }).join(', '));
    parts.push(pol.koPolicy === 'CONTINUE_ON_KO' && !pol.conflict ? 'I prodotti KO proseguono comunque' : 'Proseguono solo i prodotti OK' + (pol.explicit ? '' : ' (default)'));
    Model.routesAfter(offer, gateStepId).forEach(function (x) { parts.push('Instradamento (prima delle altre regole): ' + Model.ruleText(data, offer, x.rule)); });
    return parts;
  }

  /* Rami di uno step (componenti delle dipendenze): ogni ramo è indipendente dagli altri; "outline" = a → b, ( x ∥ y ) per i rami che si aprono. */
  function branchesOf(stages) {
    const acts = [].concat.apply([], stages.map(function (x) { return x.activities; }));
    const flat = function (n) { return [n.ref].concat([].concat.apply([], n.children.map(flat))); };
    const outline = function (n) {
      const me = n.ref.taskName;
      if (!n.children.length) return me;
      if (n.children.length === 1) return me + ' → ' + outline(n.children[0]);
      return me + ' → ( ' + n.children.map(outline).join(' ∥ ') + ' )';
    };
    return Model.branches(acts, function (a) { return a.activityId; }).map(function (c, n) {
      const order = c.kind === 'tree' ? flat(c.root) : [].concat.apply([], c.levels);
      return {
        branch: n + 1, kind: c.kind,
        outline: c.kind === 'tree' ? outline(c.root) : c.levels.map(function (l) { return l.map(function (a) { return a.taskName; }).join(' ∥ '); }).join(' → '),
        activities: order
      };
    });
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
      st.branches = branchesOf(stages);
      if (i < data.steps.length - 1) {
        const gates = Model.gatesAfter(offer, s.id);
        const pol = Model.effectivePolicy(gates);
        st.exitGate = {
          to: data.steps[i + 1].id,
          gates: gates.map(function (g) { return { gateId: g.id, note: g.note || undefined, rules: g.rules.map(function (r) {
            const o = { type: r.type };
            if (r.blockId) o.blockId = r.blockId;
            if (r.products && r.products.length) o.products = r.products.slice();
            if (r.type === 'ROUTE') { o.when = { join: r.when.join, clauses: Conditions.clone(r.when.clauses), text: Conditions.describe(data, offer, r.when) }; o.to = r.to; if (r.to !== 'STOP') { o.maxIterations = r.maxIterations; o.onExceed = r.onExceed; } }
            return o;
          }) }; }),
          routes: Model.routesAfter(offer, s.id).map(function (x) {
            return { key: x.key, gateId: x.gate.id, to: x.rule.to, backward: x.rule.to !== 'STOP' && Model.stepIndex(data, x.rule.to) <= i, maxIterations: x.rule.to === 'STOP' ? null : x.rule.maxIterations, onExceed: x.rule.to === 'STOP' ? null : x.rule.onExceed, condition: Conditions.describe(data, offer, x.rule.when), text: Model.ruleText(data, offer, x.rule) };
          }),
          effectivePolicy: {
            waitFor: blocks.filter(function (b) { return pol.dontWait.indexOf(b.id) < 0; }).map(function (b) { return b.id; }),
            dontWait: pol.dontWait,
            stopOnKo: pol.stopOnKo,
            koProducts: pol.koPolicy === 'CONTINUE_ON_KO' && !pol.conflict ? 'CONTINUE' : 'EXCLUDE',
            description: describePolicy(data, offer, pol, s.id)
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
          s.branches.length ? s.branches.map(function (br) {
            return h('div', { class: 'plan-stage' },
              h('div', { class: 'plan-stage-label' }, (s.branches.length > 1 ? 'Ramo ' + br.branch + ' (in parallelo agli altri): ' : '') + br.outline + (br.kind === 'levels' && br.activities.length > 1 ? ' — con join: si attende ogni livello' : '')),
              h('table', { class: 'tbl' },
                h('thead', null, h('tr', null, ['Attività', 'Prodotti', 'Servizio', 'Invocazione', 'Input', 'Output', 'Esiti', 'Retry'].map(function (x) { return h('th', null, x); }))),
                h('tbody', null, br.activities.map(function (a) {
                  return h('tr', null,
                    h('td', null, h('b', null, a.taskName), a.when ? h('div', { class: 'badge cond' }, 'SE ' + a.when.text) : null, a.dependsOn.length ? h('div', { class: 'muted' }, 'dopo: ' + a.dependsOn.join(', ')) : null, a.executionType === 'ASYNC_CALLBACK' ? h('div', { class: 'badge async' }, 'async · ' + (a.async.callbackTopic || 'topic?')) : null),
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

  window.ExecutionPlan = { build: build, render: render, describePolicy: describePolicy, toYaml: function (v) { return Exporters.toYaml(v); } };
})();
