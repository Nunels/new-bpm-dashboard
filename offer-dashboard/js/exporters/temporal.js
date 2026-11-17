/* Exporter Temporal: piano in DSL YAML (stile temporalio "dsl" sample, esteso) + interprete TypeScript generico. */
(function () {
  const X = Exporters;

  function activity(plan, a) {
    const args = {};
    a.input.forEach(function (i) {
      const s = X.source(i.source);
      if (s.kind === 'none') args[i.name] = null;
      else if (s.kind === 'literal') args[i.name] = s.value;
      else if (s.kind === 'result') { const src = X.findActivity(plan, s.ref); args[i.name] = '$esiti.' + (src ? src.activityId : s.ref) + '.' + s.field; }
      else args[i.name] = '$input.' + s.path;
    });
    const o = {
      id: a.activityId,
      name: X.snake(a.taskId),
      description: a.taskName + ' — ' + (a.service.method || '') + ' ' + (a.service.path || ''),
      products: a.products.slice(),
      perProduct: X.perProduct(a),
      arguments: args,
      result: 'esiti.' + a.activityId,
      retry: { maximumAttempts: a.retry.maxAttempts + 1, initialIntervalSeconds: a.retry.intervalSec || 1, backoffCoefficient: 1 }
    };
    if (X.isAsync(a)) o.awaitSignal = { name: a.async.callbackTopic || a.activityId, timeoutHours: a.async.timeoutHours || 48 };
    if (X.hasKoTask(a)) o.koTask = { queue: a.outcomes.KO_WITH_TASK.queue, slaHours: a.outcomes.KO_WITH_TASK.slaHours, signal: 'manual-task-completed' };
    return { activity: o };
  }

  function build(plan) {
    const elements = [];
    plan.steps.forEach(function (st) {
      const sp = X.splitStep(st);
      const inner = [];
      sp.detached.forEach(function (a) { inner.push({ detached: activity(plan, a) }); });
      sp.stages.forEach(function (stg) {
        if (stg.activities.length === 1) inner.push(activity(plan, stg.activities[0]));
        else inner.push({ parallel: { branches: stg.activities.map(function (a) { return activity(plan, a); }) } });
      });
      elements.push({ step: { id: st.stepId, name: st.name, sequence: { elements: inner } } });
      if (st.exitGate) {
        const pol = st.exitGate.effectivePolicy;
        elements.push({ gate: { id: 'GATE_' + st.stepId, to: st.exitGate.to, stopOnKo: pol.stopOnKo, koProducts: pol.koProducts, description: pol.description } });
      }
    });
    return {
      dslVersion: '1.0',
      workflow: { type: 'offerInterpreterWorkflow', id: 'offer-' + X.kebab(plan.offer.id) + '-${praticaId}', taskQueue: 'offer-processing' },
      offer: { id: plan.offer.id, name: plan.offer.name },
      variables: { activeProducts: plan.products.map(function (p) { return p.id; }), koProducts: [] },
      root: { sequence: { elements: elements } }
    };
  }

  const INTERPRETER = [
    '// Interprete generico del piano offerta (Temporal TypeScript SDK).',
    '// Il piano YAML generato dalla dashboard viene passato come input: nessun redeploy per nuove offerte.',
    'import { proxyActivities, defineSignal, setHandler, condition, startChild, ParentClosePolicy } from \'@temporalio/workflow\';',
    '',
    'type Outcome = \'OK\' | \'KO\' | \'KO_TASK\';',
    'interface ActivityResult { outcome: Outcome; productOutcomes: Record<string, Outcome>; [k: string]: unknown }',
    'interface ActivityStmt {',
    '  id: string; name: string; products: string[]; perProduct: boolean; arguments: Record<string, unknown>; result: string;',
    '  retry: { maximumAttempts: number; initialIntervalSeconds: number; backoffCoefficient: number };',
    '  awaitSignal?: { name: string; timeoutHours: number }; koTask?: { queue: string; slaHours?: number; signal: string };',
    '}',
    'type Statement =',
    '  | { activity: ActivityStmt }',
    '  | { detached: { activity: ActivityStmt } }',
    '  | { sequence: { elements: Statement[] } }',
    '  | { parallel: { branches: Statement[] } }',
    '  | { step: { id: string; name: string; sequence: { elements: Statement[] } } }',
    '  | { gate: { id: string; to: string; stopOnKo: \'ALL\' | string[] | null; koProducts: \'EXCLUDE\' | \'CONTINUE\'; description: string[] } };',
    'export interface OfferPlan { variables: { activeProducts: string[]; koProducts: string[] }; root: Statement }',
    'export interface OfferInput { plan: OfferPlan; input: Record<string, unknown> }',
    '',
    'export const callbackSignal = defineSignal<[string, ActivityResult]>(\'callback\');',
    'export const manualTaskSignal = defineSignal<[string, ActivityResult]>(\'manual-task-completed\');',
    '',
    'class Stopped extends Error {}',
    '',
    'export async function offerInterpreterWorkflow({ plan, input }: OfferInput): Promise<Record<string, unknown>> {',
    '  const state = { input, esiti: {} as Record<string, unknown>, activeProducts: [...plan.variables.activeProducts], koProducts: [] as string[] };',
    '  const signals = new Map<string, ActivityResult>();',
    '  setHandler(callbackSignal, (key, result) => { signals.set(key, result); });',
    '  setHandler(manualTaskSignal, (key, result) => { signals.set(\'manual:\' + key, result); });',
    '',
    '  const resolve = (v: unknown): unknown => {',
    '    if (typeof v !== \'string\' || !v.startsWith(\'$\')) return v;',
    '    return v.slice(1).split(\'.\').reduce<any>((o, k) => (o == null ? undefined : o[k]), state);',
    '  };',
    '',
    '  async function runActivity(a: ActivityStmt): Promise<void> {',
    '    const { [a.name]: fn } = proxyActivities<Record<string, (args: unknown) => Promise<ActivityResult>>>({',
    '      startToCloseTimeout: \'5 minutes\',',
    '      retry: { maximumAttempts: a.retry.maximumAttempts, initialInterval: a.retry.initialIntervalSeconds * 1000, backoffCoefficient: a.retry.backoffCoefficient },',
    '    });',
    '    const targets = a.products.filter((p) => state.activeProducts.includes(p));',
    '    if (!targets.length) return;',
    '    const args = Object.fromEntries(Object.entries(a.arguments).map(([k, v]) => [k, resolve(v)]));',
    '    const calls = a.perProduct ? targets.map((p) => fn({ ...args, products: [p] })) : [fn({ ...args, products: targets })];',
    '    let results = await Promise.all(calls);',
    '    if (a.awaitSignal) {',
    '      const key = a.id;',
    '      const ok = await condition(() => signals.has(key), a.awaitSignal.timeoutHours * 3600 * 1000);',
    '      results = ok ? [signals.get(key)!] : targets.map((p) => ({ outcome: \'KO\' as Outcome, productOutcomes: { [p]: \'KO\' as Outcome } }));',
    '    }',
    '    for (const r of results) {',
    '      if (a.koTask && Object.values(r.productOutcomes).includes(\'KO_TASK\')) {',
    '        // il task manuale viene aperto da un\'activity dedicata e chiuso via signal',
    '        await condition(() => signals.has(\'manual:\' + a.id));',
    '        Object.assign(r, signals.get(\'manual:\' + a.id));',
    '      }',
    '      for (const [p, o] of Object.entries(r.productOutcomes)) if (o === \'KO\' && !state.koProducts.includes(p)) state.koProducts.push(p);',
    '    }',
    '    state.esiti[a.id] = results.length === 1 ? results[0] : results;',
    '  }',
    '',
    '  async function execute(s: Statement): Promise<void> {',
    '    if (\'activity\' in s) return runActivity(s.activity);',
    '    if (\'detached\' in s) {',
    '      // "Non attendere": child workflow abbandonato, non blocca il gate',
    '      await startChild(offerInterpreterWorkflow, {',
    '        args: [{ plan: { variables: { activeProducts: state.activeProducts, koProducts: [] }, root: s.detached }, input }],',
    '        parentClosePolicy: ParentClosePolicy.ABANDON,',
    '      });',
    '      return;',
    '    }',
    '    if (\'sequence\' in s) { for (const e of s.sequence.elements) await execute(e); return; }',
    '    if (\'step\' in s) { for (const e of s.step.sequence.elements) await execute(e); return; }',
    '    if (\'parallel\' in s) { await Promise.all(s.parallel.branches.map(execute)); return; }',
    '    if (\'gate\' in s) {',
    '      const g = s.gate;',
    '      const stop = g.stopOnKo === \'ALL\' ? state.koProducts.length > 0 : Array.isArray(g.stopOnKo) && state.koProducts.some((p) => g.stopOnKo!.includes(p));',
    '      if (stop) throw new Stopped(g.id);',
    '      if (g.koProducts === \'EXCLUDE\') state.activeProducts = state.activeProducts.filter((p) => !state.koProducts.includes(p));',
    '      state.koProducts = [];',
    '      if (!state.activeProducts.length) throw new Stopped(g.id + \':NO_PRODUCTS\');',
    '    }',
    '  }',
    '',
    '  try {',
    '    await execute(plan.root);',
    '    return { status: \'COMPLETED\', activeProducts: state.activeProducts, esiti: state.esiti };',
    '  } catch (e) {',
    '    if (e instanceof Stopped) return { status: e.message.endsWith(\'NO_PRODUCTS\') ? \'NO_PRODUCTS\' : \'STOPPED\', gate: e.message, koProducts: state.koProducts };',
    '    throw e;',
    '  }',
    '}',
    ''
  ].join('\n');

  X.buildTemporal = build;
  X.TEMPORAL_INTERPRETER = INTERPRETER;
  X.register({
    id: 'temporal',
    label: 'Temporal (DSL YAML + interprete TS)',
    notes: [
      'Temporal non ha un formato di processo: si usa il pattern "interprete DSL" (vedi samples DSL di Temporal). Il piano YAML è l\'input di un workflow generico.',
      'offer-interpreter.workflow.ts è lo scheletro dell\'interprete: si deploya una volta, le nuove offerte sono solo nuovi YAML.',
      'Ogni attività è un\'activity Temporal (nome = id task in snake_case) con retry policy; parallel = Promise.all.',
      'Task asincroni = attesa del signal "callback"; "KO con task" = attesa del signal "manual-task-completed".',
      'Barre arancioni = statement "gate" valutato dall\'interprete; "Non attendere" = child workflow con ParentClosePolicy.ABANDON.'
    ],
    files: function (plan) {
      return [
        { name: 'offer-' + X.kebab(plan.offer.id) + '.temporal.yaml', mime: 'application/yaml', content: X.toYaml(build(plan)) },
        { name: 'offer-interpreter.workflow.ts', mime: 'text/plain', content: INTERPRETER }
      ];
    }
  });
})();
