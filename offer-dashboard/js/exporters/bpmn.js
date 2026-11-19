/*
 * Exporter Camunda 8: BPMN 2.0 con estensioni Zeebe e diagramma (BPMN DI) calcolato.
 * Ogni step è un sotto-processo; le barre arancioni diventano business rule task (DMN) + gateway.
 */
(function () {
  const X = Exporters;
  const W = { task: 100, taskH: 80, ev: 36, gw: 50, gap: 50 };

  function feelList(arr) { return '[' + arr.map(function (p) { return JSON.stringify(p); }).join(', ') + ']'; }

  function inputExpr(plan, src) {
    const s = X.source(src);
    if (s.kind === 'none') return '=null';
    if (s.kind === 'literal') return '=' + JSON.stringify(s.value);
    if (s.kind === 'result') {
      const a = X.findActivity(plan, s.ref);
      return '=esiti.' + (a ? a.activityId : s.ref) + '.' + s.field;
    }
    return '=' + s.path;
  }

  /* ---------- modello a oggetti: nodi, flussi, contenitori ---------- */
  function Graph() { this.seq = 0; }
  Graph.prototype.container = function () { return { nodes: [], flows: [] }; };
  Graph.prototype.node = function (c, tag, id, name, b, opts) {
    const n = Object.assign({ tag: tag, id: id, name: name, b: b, inc: [], out: [], attrs: {}, body: '', tail: '' }, opts || {});
    c.nodes.push(n);
    return n;
  };
  Graph.prototype.flow = function (c, s, t, opts) {
    opts = opts || {};
    // il primo flusso senza condizione in uscita dal gateway di un gate è il "prosegui" di default
    if (s.pendingDefault && !opts.cond) { opts = Object.assign({ name: 'prosegui' }, opts, { isDefault: true }); s.pendingDefault = false; }
    const f = { id: 'Flow_' + (++this.seq), s: s, t: t, name: opts.name, cond: opts.cond, points: opts.points || route(s, t) };
    s.out.push(f.id); t.inc.push(f.id);
    if (opts.isDefault) s.attrs['default'] = f.id;
    c.flows.push(f);
    return f;
  };

  function cx(b) { return b.x + b.w / 2; }
  function cy(b) { return b.y + b.h / 2; }
  function vertical(n) { return /Gateway$/.test(n.tag) || n.tag === 'boundaryEvent'; }

  /* Instradamento ortogonale semplice da sinistra verso destra. */
  function route(s, t) {
    const a = s.b, b = t.b;
    const sy = s.portY != null ? s.portY : cy(a), ty = t.portY != null ? t.portY : cy(b);
    if (Math.abs(sy - ty) < 1) return [[a.x + a.w, sy], [b.x, ty]];
    const down = ty > sy;
    if (b.x >= a.x + a.w - 1) {
      if (vertical(s)) return [[cx(a), down ? a.y + a.h : a.y], [cx(a), ty], [b.x, ty]];
      if (/Gateway$/.test(t.tag)) return [[a.x + a.w, sy], [cx(b), sy], [cx(b), down ? b.y : b.y + b.h]];
      const mx = Math.round((a.x + a.w + b.x) / 2);
      return [[a.x + a.w, sy], [mx, sy], [mx, ty], [b.x, ty]];
    }
    const my = Math.round(down ? (a.y + a.h + b.y) / 2 : (b.y + b.h + a.y) / 2);
    return [[cx(a), down ? a.y + a.h : a.y], [cx(a), my], [cx(b), my], [cx(b), down ? b.y : b.y + b.h]];
  }

  /* ---------- unità di attività: service task [+ callback] [+ task manuale su KO] ---------- */
  function unitSize(a) {
    const ko = X.hasKoTask(a), as = X.isAsync(a);
    let w = W.task;
    if (as) w += W.gap + W.task;
    if (ko) w = Math.max(w, (as ? 150 : 120) + W.task) + W.gap + W.gw;
    return { w: w, h: ko ? W.taskH + 40 + W.taskH : W.taskH, above: W.taskH / 2 };
  }

  function addUnit(g, c, plan, a, x, mainY, ctx) {
    const top = mainY - W.taskH / 2;
    const id = X.sid(a.activityId);
    const headers = [
      ['activityId', a.activityId], ['service', (a.service.method || '') + ' ' + (a.service.path || '')],
      ['products', a.products.join(',')], ['invocation', a.invocation.mode]
    ];
    if (a.notification) headers.push(['notifyTemplate', a.notification.template || '']);
    const inputs = a.input.map(function (i) { return '<zeebe:input source="' + X.xml(inputExpr(plan, i.source)) + '" target="' + X.xml(i.name) + '" />'; });
    inputs.push('<zeebe:input source="' + X.xml('=activeProducts[list contains(' + feelList(a.products) + ', item)]') + '" target="targetProducts" />');
    const outputs = a.output.map(function (o) { return '<zeebe:output source="=' + X.xml(o.name) + '" target="' + X.xml('esiti.' + a.activityId + '.' + o.name) + '" />'; });
    let body = '<bpmn:extensionElements>' +
      '<zeebe:taskDefinition type="' + X.xml(X.kebab(a.taskId)) + '" retries="' + Math.max(1, a.retry.maxAttempts) + '" />' +
      '<zeebe:ioMapping>' + inputs.join('') + outputs.join('') + '</zeebe:ioMapping>' +
      '<zeebe:taskHeaders>' + headers.map(function (h) { return '<zeebe:header key="' + X.xml(h[0]) + '" value="' + X.xml(h[1]) + '" />'; }).join('') + '</zeebe:taskHeaders>' +
      '</bpmn:extensionElements>';
    let tail = '';
    if (X.perProduct(a)) {
      tail = '<bpmn:multiInstanceLoopCharacteristics><bpmn:extensionElements>' +
        '<zeebe:loopCharacteristics inputCollection="' + X.xml('=activeProducts[list contains(' + feelList(a.products) + ', item)]') + '" inputElement="product" />' +
        '</bpmn:extensionElements></bpmn:multiInstanceLoopCharacteristics>';
    }
    const task = g.node(c, 'serviceTask', id, a.taskName, { x: x, y: top, w: W.task, h: W.taskH }, { body: body, tail: tail });
    let last = task;
    if (X.isAsync(a)) {
      const msgId = 'Message_' + X.sid(a.async.callbackTopic || a.activityId);
      if (!ctx.messages[msgId]) ctx.messages[msgId] = a.async.callbackTopic || a.activityId;
      const rt = g.node(c, 'receiveTask', id + '_callback', 'Attendi esito ' + a.taskName, { x: x + W.task + W.gap, y: top, w: W.task, h: W.taskH }, { attrs: { messageRef: msgId } });
      g.flow(c, task, rt);
      last = rt;
    }
    if (X.hasKoTask(a)) {
      const k = a.outcomes.KO_WITH_TASK;
      ctx.koError = true;
      const be = g.node(c, 'boundaryEvent', id + '_ko', 'KO con task', { x: x + W.task - 18 - 14, y: top + W.taskH - 18, w: W.ev, h: W.ev },
        { attrs: { attachedToRef: id }, tail: '<bpmn:errorEventDefinition errorRef="Error_KO_TASK" />' });
      const ux = x + (X.isAsync(a) ? 150 : 120);
      const ut = g.node(c, 'userTask', id + '_manual', 'Lavorazione manuale ' + a.taskName, { x: ux, y: top + W.taskH + 40, w: W.task, h: W.taskH },
        { body: '<bpmn:extensionElements><zeebe:assignmentDefinition candidateGroups="' + X.xml(k.queue || 'BACKOFFICE') + '" />' +
          (k.slaHours ? '<zeebe:taskSchedule dueDate="' + X.xml('=now() + duration("PT' + k.slaHours + 'H")') + '" />' : '') + '<zeebe:userTask /></bpmn:extensionElements>' });
      const mgX = Math.max(last.b.x + W.task, ux + W.task) + W.gap;
      const mg = g.node(c, 'exclusiveGateway', id + '_merge', null, { x: mgX, y: mainY - W.gw / 2, w: W.gw, h: W.gw });
      g.flow(c, last, mg);
      g.flow(c, be, ut);
      g.flow(c, ut, mg);
      last = mg;
    }
    return { entry: task, exit: last };
  }

  /* ---------- layout di uno step (contenuto del sotto-processo) ---------- */
  function stageSize(stage) {
    const sizes = stage.activities.map(unitSize);
    if (sizes.length === 1) return { w: sizes[0].w, above: sizes[0].above, below: sizes[0].h - sizes[0].above, sizes: sizes };
    const gapV = 30;
    const total = sizes.reduce(function (s, x) { return s + x.h; }, 0) + gapV * (sizes.length - 1);
    return { w: W.gw + W.gap + Math.max.apply(null, sizes.map(function (s) { return s.w; })) + W.gap + W.gw, above: total / 2, below: total / 2, sizes: sizes, total: total, gapV: gapV };
  }

  function stepSize(stages) {
    let w = 30 + W.ev, above = 40, below = 40;
    stages.forEach(function (s) { const z = stageSize(s); w += W.gap + z.w; above = Math.max(above, z.above); below = Math.max(below, z.below); });
    w += W.gap + W.ev + 30;
    return { w: Math.max(w, 260), h: 30 + above + below + 30, above: 30 + above };
  }

  function layoutStep(g, c, plan, step, stages, box, ctx) {
    const mainY = box.y + box.above;
    let x = box.x + 30;
    const pre = X.sid(step.stepId);
    const start = g.node(c, 'startEvent', pre + '_start', null, { x: x, y: mainY - W.ev / 2, w: W.ev, h: W.ev });
    let prev = start;
    x += W.ev;
    stages.forEach(function (stage, si) {
      x += W.gap;
      const z = stageSize(stage);
      if (stage.activities.length === 1) {
        const u = addUnit(g, c, plan, stage.activities[0], x, mainY, ctx);
        g.flow(c, prev, u.entry);
        prev = u.exit;
      } else {
        const fork = g.node(c, 'parallelGateway', pre + '_fork' + (si + 1), null, { x: x, y: mainY - W.gw / 2, w: W.gw, h: W.gw });
        const joinX = x + z.w - W.gw;
        const join = g.node(c, 'parallelGateway', pre + '_join' + (si + 1), null, { x: joinX, y: mainY - W.gw / 2, w: W.gw, h: W.gw });
        g.flow(c, prev, fork);
        let rowTop = mainY - z.total / 2;
        stage.activities.forEach(function (a, i) {
          const u = addUnit(g, c, plan, a, x + W.gw + W.gap, rowTop + W.taskH / 2, ctx);
          g.flow(c, fork, u.entry);
          g.flow(c, u.exit, join);
          rowTop += z.sizes[i].h + z.gapV;
        });
        prev = join;
      }
      x += z.w;
    });
    x += W.gap;
    const end = g.node(c, 'endEvent', pre + '_end', null, { x: x, y: mainY - W.ev / 2, w: W.ev, h: W.ev });
    g.flow(c, prev, end);
  }

  /* ---------- processo completo ---------- */
  function buildModel(plan) {
    const g = new Graph();
    const root = g.container();
    const ctx = { messages: {}, koError: false };
    const pid = 'Offer_' + X.sid(plan.offer.id);
    const steps = plan.steps.map(function (s) { const sp = X.splitStep(s); return { step: s, stages: sp.stages, detached: sp.detached, size: stepSize(sp.stages) }; });
    const maxAbove = Math.max.apply(null, steps.map(function (s) { return s.size.above; }).concat([140]));
    const maxBelow = Math.max.apply(null, steps.map(function (s) { return s.size.h - s.size.above; }).concat([140]));
    const Y = 40 + maxAbove;
    const detachedY = Y + maxBelow + 80;

    let x = 60;
    const start = g.node(root, 'startEvent', 'Start_' + X.sid(plan.offer.id), 'Offerta ricevuta', { x: x, y: Y - W.ev / 2, w: W.ev, h: W.ev },
      { body: '<bpmn:extensionElements><zeebe:ioMapping>' +
        '<zeebe:output source="' + X.xml('=' + feelList(plan.products.map(function (p) { return p.id; }))) + '" target="activeProducts" />' +
        '<zeebe:output source="=[]" target="koProducts" />' +
        '</zeebe:ioMapping></bpmn:extensionElements>' });
    let prev = start;
    x += W.ev;

    steps.forEach(function (S, i) {
      const st = S.step;
      const pre = X.sid(st.stepId);
      x += W.gap;
      if (S.detached.length) {
        const fork = g.node(root, 'parallelGateway', 'Fork_' + pre, null, { x: x, y: Y - W.gw / 2, w: W.gw, h: W.gw });
        g.flow(root, prev, fork);
        let dx = x + W.gw + W.gap, dprev = fork;
        S.detached.forEach(function (a) {
          const u = addUnit(g, root, plan, a, dx, detachedY, ctx);
          g.flow(root, dprev, u.entry);
          dprev = u.exit;
          dx = u.exit.b.x + u.exit.b.w + W.gap;
        });
        const dend = g.node(root, 'endEvent', 'End_' + pre + '_async', 'Esito non atteso registrato', { x: dx, y: detachedY - W.ev / 2, w: W.ev, h: W.ev });
        g.flow(root, dprev, dend);
        prev = fork;
        x += W.gw + W.gap;
      }
      const sub = g.node(root, 'subProcess', 'Step_' + pre, st.order + '. ' + st.name, { x: x, y: Y - S.size.above, w: S.size.w, h: S.size.h }, { expanded: true, portY: Y });
      sub.inner = g.container();
      layoutStep(g, sub.inner, plan, st, S.stages, { x: sub.b.x, y: sub.b.y, above: S.size.above }, ctx);
      g.flow(root, prev, sub);
      prev = sub;
      x += S.size.w;

      if (st.exitGate) {
        const pol = st.exitGate.effectivePolicy;
        const next = plan.steps[i + 1];
        x += W.gap;
        const brt = g.node(root, 'businessRuleTask', 'Gate_' + pre, 'Gate → ' + next.name, { x: x, y: Y - W.taskH / 2, w: W.task, h: W.taskH },
          { body: '<bpmn:documentation>' + X.xml(pol.description.join('\n')) + '</bpmn:documentation>' +
            '<bpmn:extensionElements><zeebe:calledDecision decisionId="Gate_' + pre + '" resultVariable="gateDecision" />' +
            '<zeebe:ioMapping><zeebe:output source="=gateDecision.activeProducts" target="activeProducts" />' +
            '<zeebe:output source="=[]" target="koProducts" /></zeebe:ioMapping></bpmn:extensionElements>' });
        g.flow(root, prev, brt);
        x += W.task + W.gap;
        const gw = g.node(root, 'exclusiveGateway', 'GateDecision_' + pre, 'Esito gate', { x: x, y: Y - W.gw / 2, w: W.gw, h: W.gw });
        g.flow(root, brt, gw);
        const evX = x + W.gw / 2 - W.ev / 2;
        if (pol.stopOnKo) {
          const stop = g.node(root, 'endEvent', 'Stopped_' + pre, 'Offerta fermata', { x: evX, y: Y - W.gw / 2 - 90 - W.ev, w: W.ev, h: W.ev },
            { tail: '<bpmn:terminateEventDefinition />' });
          g.flow(root, gw, stop, { name: 'STOP', cond: '=gateDecision.action = "STOP"' });
        }
        const none = g.node(root, 'endEvent', 'NoProducts_' + pre, 'Nessun prodotto attivo', { x: evX, y: Y + W.gw / 2 + 90, w: W.ev, h: W.ev },
          { tail: '<bpmn:terminateEventDefinition />' });
        g.flow(root, gw, none, { name: 'nessun prodotto', cond: '=count(activeProducts) = 0' });
        prev = gw;
        prev.pendingDefault = true;
        x += W.gw;
      }
    });

    x += W.gap + 20;
    const end = g.node(root, 'endEvent', 'End_' + X.sid(plan.offer.id), 'Offerta completata', { x: x, y: Y - W.ev / 2, w: W.ev, h: W.ev });
    g.flow(root, prev, end);
    return { g: g, root: root, ctx: ctx, pid: pid, width: x + 100 };
  }

  /* ---------- serializzazione ---------- */
  function attrs(o) { return Object.keys(o).map(function (k) { return ' ' + k + '="' + X.xml(o[k]) + '"'; }).join(''); }

  function serializeContainer(c, ind) {
    const out = [];
    c.nodes.forEach(function (n) {
      const head = '<bpmn:' + n.tag + ' id="' + n.id + '"' + (n.name ? ' name="' + X.xml(n.name) + '"' : '') + attrs(n.attrs) + '>';
      const inner = [];
      if (n.body) inner.push(n.body);
      n.inc.forEach(function (f) { inner.push('<bpmn:incoming>' + f + '</bpmn:incoming>'); });
      n.out.forEach(function (f) { inner.push('<bpmn:outgoing>' + f + '</bpmn:outgoing>'); });
      if (n.tail) inner.push(n.tail);
      if (n.inner) inner.push('\n' + serializeContainer(n.inner, ind + '  ') + '\n' + ind);
      out.push(ind + head + inner.join('') + '</bpmn:' + n.tag + '>');
    });
    c.flows.forEach(function (f) {
      const cond = f.cond ? '<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">' + X.xml(f.cond) + '</bpmn:conditionExpression>' : '';
      out.push(ind + '<bpmn:sequenceFlow id="' + f.id + '"' + (f.name ? ' name="' + X.xml(f.name) + '"' : '') + ' sourceRef="' + f.s.id + '" targetRef="' + f.t.id + '"' +
        (cond ? '>' + cond + '</bpmn:sequenceFlow>' : ' />'));
    });
    return out.join('\n');
  }

  function serializeDi(c, out) {
    c.nodes.forEach(function (n) {
      const b = n.b;
      out.push('      <bpmndi:BPMNShape id="' + n.id + '_di" bpmnElement="' + n.id + '"' + (n.expanded ? ' isExpanded="true"' : '') +
        (/Gateway$/.test(n.tag) ? ' isMarkerVisible="true"' : '') + '>' +
        '<dc:Bounds x="' + Math.round(b.x) + '" y="' + Math.round(b.y) + '" width="' + b.w + '" height="' + b.h + '" /></bpmndi:BPMNShape>');
      if (n.inner) serializeDi(n.inner, out);
    });
    c.flows.forEach(function (f) {
      out.push('      <bpmndi:BPMNEdge id="' + f.id + '_di" bpmnElement="' + f.id + '">' +
        f.points.map(function (p) { return '<di:waypoint x="' + Math.round(p[0]) + '" y="' + Math.round(p[1]) + '" />'; }).join('') + '</bpmndi:BPMNEdge>');
    });
  }

  function build(plan) {
    const m = buildModel(plan);
    const defs = [];
    Object.keys(m.ctx.messages).forEach(function (id) {
      defs.push('  <bpmn:message id="' + id + '" name="' + X.xml(m.ctx.messages[id]) + '"><bpmn:extensionElements><zeebe:subscription correlationKey="=pratica.id" /></bpmn:extensionElements></bpmn:message>');
    });
    if (m.ctx.koError) defs.push('  <bpmn:error id="Error_KO_TASK" name="KO con task manuale" errorCode="KO_TASK" />');
    const di = [];
    serializeDi(m.root, di);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"' +
      ' xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"' +
      ' xmlns:modeler="http://camunda.org/schema/modeler/1.0" id="Definitions_' + X.sid(plan.offer.id) + '"' +
      ' targetNamespace="http://example.com/offers" exporter="BPM AI Offer Designer" exporterVersion="1.0"' +
      ' modeler:executionPlatform="Camunda Cloud" modeler:executionPlatformVersion="8.6.0">\n' +
      '  <bpmn:process id="' + m.pid + '" name="' + X.xml(plan.offer.name) + '" isExecutable="true">\n' +
      '    <bpmn:documentation>' + X.xml('Generato da BPM AI Offer Designer (' + plan.generatedAt + '). ' + (plan.offer.description || '')) + '</bpmn:documentation>\n' +
      serializeContainer(m.root, '    ') + '\n' +
      '  </bpmn:process>\n' +
      (defs.length ? defs.join('\n') + '\n' : '') +
      '  <bpmndi:BPMNDiagram id="Diagram_' + X.sid(plan.offer.id) + '">\n' +
      '    <bpmndi:BPMNPlane id="Plane_' + X.sid(plan.offer.id) + '" bpmnElement="' + m.pid + '">\n' +
      di.join('\n') + '\n' +
      '    </bpmndi:BPMNPlane>\n  </bpmndi:BPMNDiagram>\n</bpmn:definitions>\n';
  }

  X.buildBpmn = build;
  X.register({
    id: 'camunda',
    label: 'Camunda 8 (BPMN 2.0 + DMN)',
    notes: [
      'Ogni step è un sotto-processo; i blocchi paralleli usano parallel gateway; "1 chiamata per prodotto" è un multi-instance su activeProducts.',
      'I service task hanno tipo = id del task in kebab-case (es. "oracolo"): i job worker vanno implementati (stream 1). Retry = zeebe retries.',
      'Task asincroni: service task + receive task sul messaggio = topic di callback, correlato su pratica.id.',
      '"KO con task": il worker lancia l\'errore BPMN KO_TASK → user task assegnato alla coda (candidateGroups).',
      'Barre arancioni: business rule task che chiama la decisione DMN Gate_<STEP> (file .dmn da deployare insieme) + gateway: STOP o nessun prodotto attivo → terminate end event.',
      '"Non attendere": l\'attività gira in un ramo parallelo separato che non blocca il gate.',
      'I worker devono aggiungere i prodotti KO alla variabile koProducts, letta dal DMN del gate.'
    ],
    files: function (plan) {
      return [
        { name: 'offer-' + X.kebab(plan.offer.id) + '.bpmn', mime: 'application/xml', content: build(plan) },
        { name: 'offer-' + X.kebab(plan.offer.id) + '-gates.dmn', mime: 'application/xml', content: X.buildDmn(plan, { flavor: 'camunda' }) }
      ];
    }
  });
})();
