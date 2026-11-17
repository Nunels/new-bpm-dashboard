/* Exporter Serverless Workflow DSL 1.0.0 (CNCF), YAML. Espressioni runtime in jq. */
(function () {
  const X = Exporters;
  const NS = 'offers';
  const ERR = 'https://example.com/errors/';

  function docName(s) { return X.kebab(s).slice(0, 63).replace(/-+$/, ''); }
  function jqList(arr) { return arr.map(function (p) { return JSON.stringify(p); }).join(', '); }

  function bodyOf(plan, a) {
    const b = {};
    a.input.forEach(function (i) {
      const s = X.source(i.source);
      if (s.kind === 'none') b[i.name] = null;
      else if (s.kind === 'literal') b[i.name] = s.value;
      else if (s.kind === 'result') {
        const src = X.findActivity(plan, s.ref);
        b[i.name] = '${ $context.esiti.' + (src ? src.activityId : s.ref) + '.' + s.field + ' }';
      } else b[i.name] = '${ $workflow.input.' + s.path + ' }';
    });
    b.products = X.perProduct(a) ? '${ [$product] }' : '${ [$context.activeProducts[] | select(IN(' + jqList(a.products) + '))] }';
    return b;
  }

  /* Salva l'esito nel contesto e accumula i prodotti KO (letti dal gate). */
  function exportResult(a) {
    return {
      as: '${ $context + { esiti: (($context.esiti // {}) + { "' + a.activityId + '": . }), koProducts: ((($context.koProducts // []) + [(.productOutcomes // {}) | to_entries[] | select(.value == "KO") | .key]) | unique) } }'
    };
  }

  function unit(plan, a) {
    const k = X.kebab(a.activityId);
    const method = (a.service.method || 'POST').toLowerCase();
    const call = { call: 'http', with: { method: method, endpoint: { uri: X.BASE_URL + (a.service.path || '/') } } };
    if (method !== 'get') call.with.body = bodyOf(plan, a);
    if (!X.isAsync(a)) call.export = exportResult(a);
    let callItem = {};
    if (a.retry.maxAttempts > 0) {
      callItem[k + '-call'] = {
        try: [{ invoke: call }],
        catch: {
          errors: { with: { type: 'https://serverlessworkflow.io/spec/1.0.0/errors/communication' } },
          retry: { delay: { seconds: a.retry.intervalSec || 1 }, limit: { attempt: { count: a.retry.maxAttempts } } }
        }
      };
    } else callItem[k + '-call'] = call;
    const steps = [callItem];
    if (X.isAsync(a)) {
      const w = {};
      w[k + '-await-callback'] = {
        listen: { to: { one: { with: { type: a.async.callbackTopic || a.activityId }, correlate: { pratica: { from: '${ .data.praticaId }', expect: '${ $workflow.input.pratica.id }' } } } } },
        timeout: { after: { hours: a.async.timeoutHours || 48 } },
        export: exportResult(a)
      };
      steps.push(w);
    }
    if (X.hasKoTask(a)) {
      const kt = a.outcomes.KO_WITH_TASK;
      const m = {};
      m[k + '-ko-task'] = {
        if: '${ (.productOutcomes // {}) | to_entries | any(.value == "KO_TASK") }',
        do: [
          { 'request-manual-task': { emit: { event: { with: { source: 'https://example.com/offers', type: 'manual-task.requested', data: { queue: kt.queue, slaHours: kt.slaHours, activityId: a.activityId, praticaId: '${ $workflow.input.pratica.id }' } } } } } },
          { 'await-manual-task': { listen: { to: { one: { with: { type: 'manual-task.completed' }, correlate: { activity: { from: '${ .data.activityId }', expect: a.activityId } } } } }, export: exportResult(a) } }
        ]
      };
      steps.push(m);
    }
    const item = {};
    if (X.perProduct(a)) {
      item[k] = { for: { each: 'product', in: '${ [$context.activeProducts[] | select(IN(' + jqList(a.products) + '))] }' }, do: steps };
    } else {
      item[k] = { do: steps };
    }
    item[k].metadata = { activityId: a.activityId, taskId: a.taskId, products: a.products.join(','), invocation: a.invocation.mode };
    return item;
  }

  function document(plan, name, title, summary) {
    return { dsl: '1.0.0', namespace: NS, name: name, version: '1.0.0', title: title, summary: summary };
  }

  function build(plan) {
    const name = docName('offer-' + plan.offer.id);
    const subflows = [];
    const doList = [{
      'init-offer': {
        set: { activeProducts: plan.products.map(function (p) { return p.id; }), koProducts: [], esiti: {} },
        export: { as: '${ . }' }
      }
    }];
    let needStop = false;
    plan.steps.forEach(function (st) {
      const sp = X.splitStep(st);
      const s = X.kebab(st.stepId);
      const tasks = [];
      sp.detached.forEach(function (a) {
        const sub = docName(name + '-' + a.activityId);
        subflows.push({ document: document(plan, sub, a.taskName + ' (non atteso)', 'Eseguito senza attesa dal gate dopo ' + st.name), do: [unit(plan, a)] });
        const t = {};
        t['start-' + X.kebab(a.activityId)] = { run: { workflow: { namespace: NS, name: sub, version: '1.0.0', input: { activeProducts: '${ $context.activeProducts }' } }, await: false } };
        tasks.push(t);
      });
      sp.stages.forEach(function (stg) {
        if (stg.activities.length === 1) { tasks.push(unit(plan, stg.activities[0])); return; }
        const f = {};
        f[s + '-stage-' + stg.stage] = { fork: { branches: stg.activities.map(function (a) { return unit(plan, a); }), compete: false } };
        tasks.push(f);
      });
      if (tasks.length) { const step = {}; step['step-' + s] = { do: tasks, metadata: { step: st.name } }; doList.push(step); }
      if (st.exitGate) {
        const pol = st.exitGate.effectivePolicy;
        const remaining = pol.koProducts === 'CONTINUE' ? '$context.activeProducts' : '($context.activeProducts - $context.koProducts)';
        const cases = [];
        if (pol.stopOnKo === 'ALL') cases.push({ stop: { when: '${ ($context.koProducts | length) > 0 }', then: 'offer-stopped' } });
        else if (Array.isArray(pol.stopOnKo)) cases.push({ stop: { when: '${ ([$context.koProducts[] | select(IN(' + jqList(pol.stopOnKo) + '))] | length) > 0 }', then: 'offer-stopped' } });
        if (cases.length) needStop = true;
        cases.push({ 'no-products': { when: '${ (' + remaining + ' | length) == 0 }', then: 'offer-no-products' } });
        cases.push({ proceed: { then: 'continue' } });
        const g = {};
        g['gate-' + s] = { switch: cases, metadata: { description: pol.description.join(' · ') } };
        doList.push(g);
        const ap = {};
        ap['gate-' + s + '-apply'] = {
          set: { activeProducts: '${ ' + remaining + ' }' },
          export: { as: '${ $context + { activeProducts: .activeProducts, koProducts: [] } }' }
        };
        doList.push(ap);
      }
    });
    doList.push({ 'offer-completed': { set: { status: 'COMPLETED', activeProducts: '${ $context.activeProducts }' }, then: 'end' } });
    doList.push({ 'offer-no-products': { set: { status: 'NO_PRODUCTS' }, then: 'end' } });
    if (needStop) doList.push({ 'offer-stopped': { raise: { error: { type: ERR + 'offer-stopped', status: 409, title: 'Offerta fermata da una barra regole (KO)' } } } });

    const main = {
      document: document(plan, name, plan.offer.name, (plan.offer.description || '') + ' — generato da Offer Process Designer'),
      input: { schema: { format: 'json', document: { type: 'object', required: ['pratica', 'cliente'], properties: { pratica: { type: 'object' }, cliente: { type: 'object' } } } } },
      do: doList
    };
    return { main: main, subflows: subflows };
  }

  X.buildServerless = build;
  X.register({
    id: 'serverless',
    label: 'Serverless Workflow 1.0 (YAML CNCF)',
    notes: [
      'Standard aperto CNCF (DSL 1.0.0), espressioni runtime jq; eseguibile ad es. con SonataFlow/Apache KIE o runtime compatibili.',
      'Step = task "do"; blocchi paralleli = "fork"; "1 chiamata per prodotto" = "for" sui prodotti attivi.',
      'Attività = "call: http" verso ' + X.BASE_URL + ' + path; retry = try/catch con retry policy.',
      'Task asincroni = "listen" sull\'evento (type = topic di callback) correlato su pratica.id.',
      '"KO con task" = emit "manual-task.requested" + listen "manual-task.completed" (solo se esito KO_TASK).',
      'Barre arancioni = "switch" (STOP → raise, nessun prodotto → fine) + "set" che aggiorna activeProducts nel contesto.',
      '"Non attendere" = "run: workflow" con await: false verso un sotto-workflow generato in un file separato.'
    ],
    files: function (plan) {
      const r = build(plan);
      return [{ name: r.main.document.name + '.sw.yaml', mime: 'application/yaml', content: X.toYaml(r.main) }]
        .concat(r.subflows.map(function (s) { return { name: s.document.name + '.sw.yaml', mime: 'application/yaml', content: X.toYaml(s) }; }));
    }
  });
})();
