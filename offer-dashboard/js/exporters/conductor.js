/* Exporter Conductor OSS / Orkes: workflow definition (JSON) + task definitions. */
(function () {
  const X = Exporters;

  function ref(s) { return X.snake(s); }

  function inputParams(plan, a) {
    const p = {};
    a.input.forEach(function (i) {
      const s = X.source(i.source);
      if (s.kind === 'none') p[i.name] = null;
      else if (s.kind === 'literal') p[i.name] = s.value;
      else if (s.kind === 'result') {
        const src = X.findActivity(plan, s.ref);
        p[i.name] = src ? '${' + ref(src.activityId) + '.output.' + s.field + '}' : '${workflow.input.' + s.path + '}';
      } else p[i.name] = '${workflow.input.' + s.path + '}';
    });
    p.products = a.products.slice();
    p.activeProducts = '${workflow.variables.activeProducts}';
    p.activityId = a.activityId;
    return p;
  }

  /* Tasks di un'attività. Ritorna { tasks, refs: riferimenti che producono productOutcomes }. */
  function unit(plan, a, taskDefs) {
    const r = ref(a.activityId);
    const name = ref(a.taskId);
    const def = taskDefs[name] = taskDefs[name] || {
      name: name, description: a.taskName + ' — ' + (a.service.method || '') + ' ' + (a.service.path || ''),
      retryCount: 0, retryLogic: 'FIXED', retryDelaySeconds: 0, timeoutPolicy: 'TIME_OUT_WF',
      timeoutSeconds: 3600, responseTimeoutSeconds: 600, ownerEmail: 'offer-team@example.com',
      inputKeys: [], outputKeys: ['outcome', 'productOutcomes']
    };
    def.retryCount = Math.max(def.retryCount, a.retry.maxAttempts);
    def.retryDelaySeconds = Math.max(def.retryDelaySeconds, a.retry.intervalSec);
    a.input.forEach(function (i) { if (def.inputKeys.indexOf(i.name) < 0) def.inputKeys.push(i.name); });
    a.output.forEach(function (o) { if (def.outputKeys.indexOf(o.name) < 0) def.outputKeys.push(o.name); });

    const tasks = [];
    let outRef = r;
    if (X.perProduct(a)) {
      const params = inputParams(plan, a);
      tasks.push({
        name: 'prepare_' + r, taskReferenceName: r + '__prepare', type: 'INLINE',
        inputParameters: {
          evaluatorType: 'graaljs', products: a.products.slice(), active: '${workflow.variables.activeProducts}', params: params,
          expression: '(function(){ var out=[]; $.products.forEach(function(p){ if($.active.indexOf(p)>=0){ var x=JSON.parse(JSON.stringify($.params)); x.product=p; out.push(x);} }); return out; })()'
        }
      });
      tasks.push({
        name: 'fork_' + r, taskReferenceName: r, type: 'FORK_JOIN_DYNAMIC',
        inputParameters: { forkTaskName: name, forkTaskInputs: '${' + r + '__prepare.output.result}' },
        dynamicForkTasksParam: 'dynamicTasks', dynamicForkTasksInputParamName: 'dynamicTasksInput'
      });
      tasks.push({ name: 'join_' + r, taskReferenceName: r + '__join', type: 'JOIN' });
      outRef = r + '__join';
    } else {
      tasks.push({ name: name, taskReferenceName: r, type: 'SIMPLE', inputParameters: inputParams(plan, a) });
    }
    if (X.isAsync(a)) {
      tasks.push({
        name: 'wait_callback_' + r, taskReferenceName: r + '__callback', type: 'WAIT',
        inputParameters: { callbackTopic: a.async.callbackTopic, correlationKey: '${workflow.input.pratica.id}', timeoutHours: a.async.timeoutHours },
        description: 'Completato dal consumer del topic ' + a.async.callbackTopic + ' (API /tasks) con output productOutcomes'
      });
      outRef = r + '__callback';
    }
    if (X.hasKoTask(a)) {
      const k = a.outcomes.KO_WITH_TASK;
      tasks.push({
        name: 'switch_ko_' + r, taskReferenceName: r + '__ko_switch', type: 'SWITCH', evaluatorType: 'value-param', expression: 'outcome',
        inputParameters: { outcome: '${' + outRef + '.output.outcome}' },
        decisionCases: {
          KO_TASK: [{
            name: 'manual_' + r, taskReferenceName: r + '__manual', type: 'HUMAN',
            inputParameters: { queue: k.queue, slaHours: k.slaHours, activityId: a.activityId, details: '${' + outRef + '.output}' }
          }]
        },
        defaultCase: []
      });
    }
    return { tasks: tasks, outRef: outRef };
  }

  function gateTasks(plan, st, i, outRefs) {
    const pol = st.exitGate.effectivePolicy;
    const g = 'gate_' + ref(st.stepId);
    const outcomes = {};
    outRefs.forEach(function (r) { outcomes[r] = '${' + r + '.output}'; });
    const expression =
      '(function(){' +
      ' var ko=[];' +
      ' function collect(o){ if(!o) return; if(o.productOutcomes){ for(var p in o.productOutcomes){ if(o.productOutcomes[p]==="KO" && ko.indexOf(p)<0) ko.push(p);} return; }' +
      ' if(typeof o==="object"){ for(var k in o) collect(o[k]); } }' +
      ' for(var r in $.outcomes) collect($.outcomes[r]);' +
      ' var active=$.active||[];' +
      ' var stop=$.stopOnKo==="ALL" ? ko.length>0 : (Array.isArray($.stopOnKo) && ko.some(function(p){return $.stopOnKo.indexOf(p)>=0;}));' +
      ' if(stop) return { action:"STOP", activeProducts:[], koProducts:ko };' +
      ' var next=$.koProducts==="CONTINUE" ? active : active.filter(function(p){return ko.indexOf(p)<0;});' +
      ' return { action: next.length ? "CONTINUE" : "NONE", activeProducts:next, koProducts:ko };' +
      '})()';
    return [
      {
        name: g, taskReferenceName: g, type: 'INLINE', description: pol.description.join(' · '),
        inputParameters: { evaluatorType: 'graaljs', active: '${workflow.variables.activeProducts}', outcomes: outcomes, stopOnKo: pol.stopOnKo, koProducts: pol.koProducts, expression: expression }
      },
      {
        name: g + '_switch', taskReferenceName: g + '__switch', type: 'SWITCH', evaluatorType: 'value-param', expression: 'action',
        inputParameters: { action: '${' + g + '.output.result.action}' },
        decisionCases: {
          STOP: [{ name: g + '_stop', taskReferenceName: g + '__stop', type: 'TERMINATE', inputParameters: { terminationStatus: 'TERMINATED', terminationReason: 'Gate ' + st.name + ': offerta fermata per KO', workflowOutput: { status: 'STOPPED', koProducts: '${' + g + '.output.result.koProducts}' } } }],
          NONE: [{ name: g + '_none', taskReferenceName: g + '__none', type: 'TERMINATE', inputParameters: { terminationStatus: 'COMPLETED', terminationReason: 'Nessun prodotto attivo dopo ' + st.name, workflowOutput: { status: 'NO_PRODUCTS' } } }]
        },
        defaultCase: [{ name: g + '_apply', taskReferenceName: g + '__apply', type: 'SET_VARIABLE', inputParameters: { activeProducts: '${' + g + '.output.result.activeProducts}' } }]
      }
    ];
  }

  function build(plan) {
    const taskDefs = {};
    const tasks = [{
      name: 'init_offer', taskReferenceName: 'init_offer', type: 'SET_VARIABLE',
      inputParameters: { activeProducts: plan.products.map(function (p) { return p.id; }) }
    }];
    plan.steps.forEach(function (st, i) {
      const sp = X.splitStep(st);
      const s = ref(st.stepId);
      const main = [];
      const outRefs = [];
      sp.stages.forEach(function (stg, j) {
        const units = stg.activities.map(function (a) { return unit(plan, a, taskDefs); });
        units.forEach(function (u) { outRefs.push(u.outRef); });
        if (units.length === 1) { Array.prototype.push.apply(main, units[0].tasks); return; }
        const fr = s + '__stage' + (j + 1);
        main.push({ name: 'fork_' + fr, taskReferenceName: fr + '__fork', type: 'FORK_JOIN', forkTasks: units.map(function (u) { return u.tasks; }) });
        main.push({ name: 'join_' + fr, taskReferenceName: fr + '__join', type: 'JOIN', joinOn: units.map(function (u) { return u.tasks[u.tasks.length - 1].taskReferenceName; }) });
      });
      if (sp.detached.length) {
        // i rami "non attesi" non compaiono in joinOn: il JOIN attende solo il ramo principale
        const branches = [main.length ? main : [{ name: 'noop_' + s, taskReferenceName: s + '__noop', type: 'SET_VARIABLE', inputParameters: { step: st.stepId } }]];
        sp.detached.forEach(function (a) { branches.push(unit(plan, a, taskDefs).tasks); });
        tasks.push({ name: 'fork_' + s, taskReferenceName: s + '__fork', type: 'FORK_JOIN', description: st.name + ' (con attività non attese)', forkTasks: branches });
        tasks.push({ name: 'join_' + s, taskReferenceName: s + '__join', type: 'JOIN', joinOn: [branches[0][branches[0].length - 1].taskReferenceName] });
      } else {
        Array.prototype.push.apply(tasks, main);
      }
      if (st.exitGate) Array.prototype.push.apply(tasks, gateTasks(plan, st, i, outRefs));
    });

    const workflowDef = {
      name: 'offer_' + ref(plan.offer.id),
      description: plan.offer.name + (plan.offer.description ? ' — ' + plan.offer.description : ''),
      version: 1, schemaVersion: 2, ownerEmail: 'offer-team@example.com',
      inputParameters: ['pratica', 'cliente', 'offerta'],
      restartable: true, timeoutPolicy: 'ALERT_ONLY', timeoutSeconds: 0,
      variables: { activeProducts: [] },
      tasks: tasks,
      outputParameters: { status: 'COMPLETED', activeProducts: '${workflow.variables.activeProducts}' }
    };
    return {
      _howto: 'POST /api/metadata/taskdefs con "taskDefs", poi POST /api/metadata/workflow con "workflowDef". I worker devono restituire outcome e productOutcomes { PRODOTTO: OK|KO|KO_TASK }.',
      workflowDef: workflowDef,
      taskDefs: Object.keys(taskDefs).map(function (k) { return taskDefs[k]; })
    };
  }

  X.buildConductor = build;
  X.register({
    id: 'conductor',
    label: 'Conductor OSS / Orkes (JSON)',
    notes: [
      'Workflow registrabile via API a runtime (nessun deploy): POST /api/metadata/taskdefs e /api/metadata/workflow.',
      'Attività sync = SIMPLE task (nome = id task in snake_case) con retry nelle taskDefs; blocchi paralleli = FORK_JOIN + JOIN.',
      '"1 chiamata per prodotto" = INLINE che calcola i prodotti attivi + FORK_JOIN_DYNAMIC (forkTaskName/forkTaskInputs).',
      'Task asincroni = task + WAIT completato dal consumer del topic di callback (API /tasks).',
      '"KO con task" = SWITCH sull\'outcome → HUMAN task con la coda.',
      'Barre arancioni = INLINE (graaljs) che raccoglie i productOutcomes dello step e applica le regole + SWITCH: STOP/NONE → TERMINATE, altrimenti SET_VARIABLE activeProducts.',
      '"Non attendere" = ramo di un FORK_JOIN escluso da joinOn.'
    ],
    files: function (plan) {
      return [{ name: 'offer-' + X.kebab(plan.offer.id) + '.conductor.json', mime: 'application/json', content: JSON.stringify(build(plan), null, 2) + '\n' }];
    }
  });
})();
