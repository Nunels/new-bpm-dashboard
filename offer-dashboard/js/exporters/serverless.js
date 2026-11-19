/* Exporter Serverless Workflow DSL 1.0.0 (CNCF), YAML. Espressioni runtime in jq. */
(function () {
  const X = Exporters;
  const NS = 'offers';
  const ERR = 'https://example.com/errors/';

  function docName(s) { return X.kebab(s).slice(0, 63).replace(/-+$/, ''); }
  function jqList(arr) { return arr.map(function (p) { return JSON.stringify(p); }).join(', '); }
  /* Filtro "il valore è uno di": jackson-jq (usato da Quarkus Flow) non implementa IN/1, quindi uso confronti espliciti. */
  function jqAnyOf(arr) { return arr.length ? '(' + arr.map(function (p) { return '. == ' + JSON.stringify(p); }).join(' or ') + ')' : 'false'; }

  function inputExpr(plan, i) {
    const s = X.source(i.source);
    if (s.kind === 'none') return 'null';
    if (s.kind === 'literal') return JSON.stringify(s.value);
    if (s.kind === 'result') {
      const src = X.findActivity(plan, s.ref);
      return '$context.esiti.' + (src ? src.activityId : s.ref) + '.' + s.field;
    }
    return '$workflow.input.' + s.path;
  }

  /* URI dell'endpoint: i segmenti {param} del path diventano un'espressione che li sostituisce con il valore dell'input omonimo. */
  function endpointUri(plan, a) {
    const raw = X.BASE_URL + (a.service.path || '/');
    if (!/\{\w+\}/.test(raw)) return raw;
    const re = /\{(\w+)\}/g, parts = [];
    let last = 0, m;
    while ((m = re.exec(raw))) {
      const inp = a.input.find(function (x) { return x.name === m[1]; });
      parts.push(JSON.stringify(raw.slice(last, m.index)));
      parts.push('((' + (inp ? inputExpr(plan, inp) : '$workflow.input.' + m[1]) + ') | tostring | @uri)');
      last = re.lastIndex;
    }
    parts.push(JSON.stringify(raw.slice(last)));
    return '${ ' + parts.join(' + ') + ' }';
  }

  /*
   * Prodotti su cui l'attività va eseguita: quelli ancora in corsa tra i suoi, esclusi i prodotti andati in KO
   * nei blocchi da cui dipende (come fa il simulatore della dashboard).
   */
  function targetsExpr(a) {
    const base = '[$context.activeProducts[] | select(' + jqAnyOf(a.products) + ')]';
    if (!a.dependsOn.length) return base;
    return '(' + base + ' - (' + a.dependsOn.map(function (d) { return '($context.koByBlock[' + JSON.stringify(d) + '] // [])'; }).join(' + ') + '))';
  }

  function productsExpr(a) {
    return X.perProduct(a) ? '${ [$product] }' : '${ ' + targetsExpr(a) + ' }';
  }

  function bodyOf(plan, a) {
    const b = {};
    a.input.forEach(function (i) {
      const s = X.source(i.source);
      if (s.kind === 'none') b[i.name] = null;
      else if (s.kind === 'literal') b[i.name] = s.value;
      else b[i.name] = '${ ' + inputExpr(plan, i) + ' }';
    });
    b.products = productsExpr(a);
    return b;
  }

  /* Salva l'esito nel contesto e accumula i prodotti KO (letti dal gate e dai blocchi dipendenti). In export.as l'output del task è $output. */
  function exportResult(a) {
    const ko = '[($output.productOutcomes // {}) | to_entries[] | select(.value == "KO") | .key]';
    return {
      as: '${ $context + { esiti: (($context.esiti // {}) + { "' + a.activityId + '": $output }), koProducts: ((($context.koProducts // []) + ' + ko + ') | unique), koByBlock: (($context.koByBlock // {}) + { "' + a.activityId + '": ((($context.koByBlock["' + a.activityId + '"] // []) + ' + ko + ') | unique) }) } }'
    };
  }

  /* Metadata canonici: tutto ciò che serve a ricostruire l'offerta dal DSL (vedi js/dsl-import.js).
   * Il retry non è nei metadata perché si legge dal corpo (try/catch), così una modifica lì viene riportata in dashboard. */
  const CANONICAL = { generator: 'offer-process-designer', format: 1 };

  function sourceBlock(plan, id) {
    const src = plan.source && plan.source.offer;
    return src ? src.blocks.find(function (b) { return b.id === id; }) : null;
  }

  function blockMeta(plan, a, detached) {
    const m = { activityId: a.activityId, taskId: a.taskId, products: a.products.join(','), invocation: a.invocation.mode };
    const b = sourceBlock(plan, a.activityId);
    if (b) {
      const config = JSON.parse(JSON.stringify(b.config || {}));
      // ramo non atteso: il corpo è nel sotto-workflow, quindi il retry resta nei metadata
      if (!detached) config.retry = { intervalSec: (b.config && b.config.retry && b.config.retry.intervalSec) || 0 };
      m.block = { id: b.id, taskId: b.taskId, stepId: b.stepId, products: b.products.slice(), dependsOn: b.dependsOn.slice(), config: config };
    }
    return m;
  }

  function gateMeta(plan, st, pol) {
    const src = plan.source && plan.source.offer;
    const m = { description: pol.description.join(' · '), afterStep: st.stepId };
    if (src) m.gates = src.gates.filter(function (g) { return g.afterStep === st.stepId; }).map(function (g) { return { id: g.id, note: g.note || '', rules: g.rules }; });
    return m;
  }

  function documentMeta(plan) {
    const src = plan.source && plan.source.offer;
    if (!src) return null;
    const offer = { id: src.id, description: src.description || '', products: src.products.slice(),
      blockOrder: src.blocks.map(function (b) { return b.id; }), gateOrder: src.gates.map(function (g) { return g.id; }) };
    if (src.generation) offer.generation = src.generation;
    return Object.assign({}, CANONICAL, { offer: offer });
  }

  function unit(plan, a) {
    const k = X.kebab(a.activityId);
    const method = (a.service.method || 'POST').toLowerCase();
    const call = { call: 'http', with: { method: method, endpoint: { uri: endpointUri(plan, a) } } };
    if (method === 'get') call.with.query = { products: X.perProduct(a) ? '${ $product }' : '${ ' + targetsExpr(a) + ' | join(",") }' };
    else call.with.body = bodyOf(plan, a);
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
      // il listen produce l'array degli eventi consumati (DSL 1.0): output.as prende il primo, così export e "if" leggono l'oggetto
      w[k + '-await-callback'] = {
        listen: { to: { one: { with: { type: a.async.callbackTopic || a.activityId }, correlate: { pratica: { from: '${ .data.praticaId }', expect: '${ $workflow.input.pratica.id }' } } } } },
        timeout: { after: { hours: a.async.timeoutHours || 48 } },
        output: { as: '${ .[0] }' },
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
          { 'await-manual-task': { listen: { to: { one: { with: { type: 'manual-task.completed' }, correlate: { activity: { from: '${ .data.activityId }', expect: a.activityId } } } } }, output: { as: '${ .[0] }' }, export: exportResult(a) } }
        ]
      };
      steps.push(m);
    }
    const item = {};
    if (X.perProduct(a)) {
      item[k] = { for: { each: 'product', in: '${ ' + targetsExpr(a) + ' }' }, do: steps };
    } else {
      item[k] = { do: steps };
    }
    item[k].metadata = blockMeta(plan, a);
    return item;
  }

  function document(plan, name, title, summary) {
    return { dsl: '1.0.0', namespace: NS, name: name, version: '1.0.0', title: title, summary: summary };
  }

  function initTask(products) {
    return { 'init-offer': { set: { activeProducts: products, koProducts: [], esiti: {} }, export: { as: '${ $output }' } } };
  }

  function build(plan) {
    const name = docName('offer-' + plan.offer.id);
    const subflows = [];
    const doList = [initTask(plan.products.map(function (p) { return p.id; }))];
    let needStop = false;
    plan.steps.forEach(function (st) {
      const sp = X.splitStep(st);
      const s = X.kebab(st.stepId);
      const tasks = [];
      sp.detached.forEach(function (a) {
        const sub = docName(name + '-' + a.activityId);
        // il ramo "non atteso" è un sotto-workflow autonomo: riceve l'input originale + i prodotti attivi e ricostruisce il proprio contesto
        subflows.push({
          document: document(plan, sub, a.taskName + ' (non atteso)', 'Eseguito senza attesa dal gate dopo ' + st.name),
          do: [{ 'init-branch': { set: { activeProducts: '${ $workflow.input.activeProducts }', koProducts: [], esiti: {} }, export: { as: '${ $output }' } } }, unit(plan, a)]
        });
        const t = {};
        // lo schema vuole un oggetto: passo le radici dell'input originale che il ramo legge (pratica e cliente sempre) più i prodotti attivi
        const roots = { pratica: true, cliente: true };
        a.input.forEach(function (i) { const sr = X.source(i.source); if (sr.kind === 'path') roots[sr.path.split('.')[0]] = true; });
        const subInput = { activeProducts: '${ $context.activeProducts }' };
        Object.keys(roots).forEach(function (r) { subInput[r] = '${ $workflow.input.' + r + ' }'; });
        t['start-' + X.kebab(a.activityId)] = { run: { workflow: { namespace: NS, name: sub, version: '1.0.0', input: subInput }, await: false }, metadata: blockMeta(plan, a, true) };
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
        else if (Array.isArray(pol.stopOnKo)) cases.push({ stop: { when: '${ ([$context.koProducts[] | select(' + jqAnyOf(pol.stopOnKo) + ')] | length) > 0 }', then: 'offer-stopped' } });
        if (cases.length) needStop = true;
        cases.push({ 'no-products': { when: '${ (' + remaining + ' | length) == 0 }', then: 'offer-no-products' } });
        cases.push({ proceed: { then: 'continue' } });
        const g = {};
        g['gate-' + s] = { switch: cases, metadata: gateMeta(plan, st, pol) };
        doList.push(g);
        const ap = {};
        ap['gate-' + s + '-apply'] = {
          set: { activeProducts: '${ ' + remaining + ' }' },
          export: { as: '${ $context + { activeProducts: $output.activeProducts, koProducts: [] } }' }
        };
        doList.push(ap);
      }
    });
    doList.push({ 'offer-completed': { set: { status: 'COMPLETED', activeProducts: '${ $context.activeProducts }' }, then: 'end' } });
    doList.push({ 'offer-no-products': { set: { status: 'NO_PRODUCTS' }, then: 'end' } });
    if (needStop) doList.push({ 'offer-stopped': { raise: { error: { type: ERR + 'offer-stopped', status: 409, title: 'Offerta fermata da una barra regole (KO)' } } } });

    const main = {
      document: document(plan, name, plan.offer.name, (plan.offer.description || '') + ' — generato da BPM AI Offer Designer'),
      input: { schema: { format: 'json', document: { type: 'object', required: ['pratica', 'cliente'], properties: { pratica: { type: 'object' }, cliente: { type: 'object' } } } } },
      do: doList
    };
    const meta = documentMeta(plan);
    if (meta) main.document.metadata = meta;
    return { main: main, subflows: subflows };
  }

  X.buildServerless = build;
  X.register({
    id: 'serverless',
    label: 'Serverless Workflow 1.0 (YAML CNCF)',
    notes: [
      'Standard aperto (DSL 1.0.0), espressioni runtime jq. Runtime per la 1.0: reference implementation del Java SDK 7.x, Lemline, Synapse (da verificare maturità). Attenzione: SonataFlow/Apache KIE implementa solo la 0.8 e non esegue questi file.',
      'Step = task "do"; blocchi paralleli = "fork"; "1 chiamata per prodotto" = "for" sui prodotti attivi.',
      'Attività = "call: http" verso ' + X.BASE_URL + ' + path; retry = try/catch con retry policy.',
      'Task asincroni = "listen" sull\'evento (type = topic di callback) correlato su pratica.id; output.as ${ .[0] } prende l\'evento (il listen restituisce l\'array degli eventi consumati).',
      '"KO con task" = emit "manual-task.requested" + listen "manual-task.completed" (solo se esito KO_TASK).',
      'Barre arancioni = "switch" (STOP → raise, nessun prodotto → fine) + "set" che aggiorna activeProducts nel contesto.',
      '"Non attendere" = "run: workflow" con await: false verso un sotto-workflow generato in un file separato. ATTENZIONE: Quarkus Flow 1.3.0 non rispetta await: false (attende comunque il sotto-workflow); in quel runtime serve un\'attività Java o un evento con broker (provato in quarkus-flow-sim).',
      'Provato su Quarkus Flow 1.3.0: il YAML supera la validazione di schema e riproduce il simulatore (9 scenari su 10, vedi quarkus-flow-sim/README.md). Il runtime usa jackson-jq (non tutto jq: niente IN/1, quindi il generatore usa confronti espliciti) e in export.as l\'output del task si legge con $output, non con "."; il generatore lo rispetta.'
    ],
    files: function (plan) {
      const r = build(plan);
      return [{ name: r.main.document.name + '.sw.yaml', mime: 'application/yaml', content: X.toYaml(r.main) }]
        .concat(r.subflows.map(function (s) { return { name: s.document.name + '.sw.yaml', mime: 'application/yaml', content: X.toYaml(s) }; }));
    }
  });
})();
