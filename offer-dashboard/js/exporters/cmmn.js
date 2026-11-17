/*
 * Exporter Flowable: CMMN 1.1 (case management). Step = stage, barra arancione = decision task (DMN)
 * + milestone "gate superato" che apre lo stage successivo; STOP = exit criterion del case.
 */
(function () {
  const X = Exporters;
  const SZ = { task: [100, 80], ms: [100, 40], ev: [36, 36], gap: 30, pad: 30 };

  function Builder() {
    this.items = [];      // { container, id, defId, entry: [sentryId], exit: [], required, repetition }
    this.defs = [];       // { container, xml }
    this.sentries = [];   // { container, id, onParts: [{ source, event }], cond }
    this.shapes = [];     // { ref, x, y, w, h, expanded }
    this.seq = 0;
  }
  Builder.prototype.sentry = function (container, onParts, cond) {
    const id = 'Sentry_' + (++this.seq);
    this.sentries.push({ container: container, id: id, onParts: onParts, cond: cond });
    return id;
  };
  Builder.prototype.item = function (container, defId, xmlDef, opts) {
    const it = Object.assign({ container: container, id: 'PI_' + defId, defId: defId, entry: [], exit: [] }, opts || {});
    this.items.push(it);
    if (xmlDef) this.defs.push({ container: container, xml: xmlDef });
    return it;
  };

  function httpTask(defId, a) {
    const url = X.BASE_URL + (a.service.path || '').replace(/\{(\w+)\}/g, '${$1}');
    const body = {};
    a.input.forEach(function (i) {
      const s = X.source(i.source);
      body[i.name] = s.kind === 'literal' ? s.value : s.kind === 'none' ? null : '${' + s.path + '}';
    });
    return '<task id="' + defId + '" name="' + X.xml(a.taskName) + '" flowable:type="http">' +
      '<documentation>' + X.xml('Prodotti: ' + a.products.join(', ') + ' · ' + a.invocation.mode + ' · retry ' + a.retry.maxAttempts) + '</documentation>' +
      '<extensionElements>' +
      field('requestMethod', a.service.method || 'POST') + field('requestUrl', url) +
      (a.service.method === 'GET' ? '' : field('requestBody', JSON.stringify(body))) +
      field('responseVariableName', 'esiti_' + a.activityId) + field('saveResponseVariableAsJson', 'true') +
      '</extensionElements></task>';
  }
  function field(name, value) { return '<flowable:field name="' + name + '"><flowable:string><![CDATA[' + String(value).replace(/]]>/g, ']]]]><![CDATA[>') + ']]></flowable:string></flowable:field>'; }

  /* Unità di attività: task [+ listener callback + milestone] [+ human task su KO]. Ritorna le "uscite" da usare nelle dipendenze. */
  function addUnit(B, container, a) {
    const id = X.sid(a.activityId);
    const task = B.item(container, id, httpTask(id, a), { required: true, repetition: X.perProduct(a) });
    const ui = { task: task, elems: [task] };
    let done = { source: task.id, event: 'complete' };
    if (X.isAsync(a)) {
      const lis = B.item(container, id + '_callback', '<eventListener id="' + id + '_callback" name="' + X.xml('Callback ' + (a.async.callbackTopic || '')) + '" flowable:eventType="' + X.xml(a.async.callbackTopic || a.activityId) + '" />', { listener: true });
      const ms = B.item(container, id + '_done', '<milestone id="' + id + '_done" name="' + X.xml('Esito ' + a.taskName + ' ricevuto') + '" />', { required: true });
      ms.entry.push(B.sentry(container, [{ source: task.id, event: 'complete' }, { source: lis.id, event: 'occur' }]));
      ui.elems.push(ms); ui.listener = lis;
      done = { source: ms.id, event: 'occur' };
    }
    ui.exits = [{ parts: [done], cond: null }];
    if (X.hasKoTask(a)) {
      const k = a.outcomes.KO_WITH_TASK;
      const ht = B.item(container, id + '_manual', '<humanTask id="' + id + '_manual" name="' + X.xml('Lavorazione manuale ' + a.taskName) + '" flowable:candidateGroups="' + X.xml(k.queue || 'BACKOFFICE') + '"' +
        (k.slaHours ? ' flowable:dueDate="PT' + k.slaHours + 'H"' : '') + ' />');
      ht.entry.push(B.sentry(container, [done], '${outcome_' + a.activityId + ' == \'KO_TASK\'}'));
      ui.elems.push(ht);
      ui.exits = [{ parts: [done], cond: '${outcome_' + a.activityId + ' != \'KO_TASK\'}' }, { parts: [{ source: ht.id, event: 'complete' }], cond: null }];
    }
    return ui;
  }

  function build(plan) {
    const B = new Builder();
    const caseId = X.sid(plan.offer.id);
    const CP = 'CasePlan_' + caseId;
    let prevMilestone = null;
    let x = 60;
    const top = 70;
    let maxBottom = 0;
    const caseExits = [];

    plan.steps.forEach(function (st, i) {
      const sp = X.splitStep(st);
      const stageId = 'Stage_' + X.sid(st.stepId);
      const stage = B.item(CP, stageId, null, { required: true, stage: true });
      if (prevMilestone) stage.entry.push(B.sentry(CP, [{ source: prevMilestone.id, event: 'occur' }]));
      const units = {};
      // layout: una colonna per stage del piano, unità impilate
      let cx = x + SZ.pad, colsBottom = top + SZ.pad + 20;
      const listeners = [];
      sp.stages.forEach(function (stg) {
        let cy = top + SZ.pad + 20;
        stg.activities.forEach(function (a) {
          const u = addUnit(B, stageId, a);
          units[a.activityId] = u;
          u.elems.forEach(function (e) {
            const s = e.id.slice(-5) === '_done' ? SZ.ms : SZ.task;
            B.shapes.push({ ref: e.id, x: cx, y: cy, w: s[0], h: s[1] });
            e.box = { x: cx, y: cy, w: s[0], h: s[1] };
            cy += s[1] + SZ.gap;
          });
          if (u.listener) listeners.push(u.listener);
        });
        colsBottom = Math.max(colsBottom, cy);
        cx += SZ.task[0] + SZ.gap + 20;
      });
      listeners.forEach(function (l, li) {
        B.shapes.push({ ref: l.id, x: x + SZ.pad + li * 60, y: colsBottom, w: SZ.ev[0], h: SZ.ev[1] });
        if (li === listeners.length - 1) colsBottom += SZ.ev[1] + SZ.gap + 30;
      });
      // dipendenze "Esegui dopo": una sentry per ogni combinazione di uscite (criteri in OR)
      sp.stages.forEach(function (stg) {
        stg.activities.forEach(function (a) {
          const deps = a.dependsOn.filter(function (d) { return units[d]; });
          if (!deps.length) return;
          let combos = [{ parts: [], conds: [] }];
          deps.forEach(function (d) {
            const next = [];
            combos.forEach(function (c) { units[d].exits.forEach(function (e) { next.push({ parts: c.parts.concat(e.parts), conds: e.cond ? c.conds.concat([e.cond]) : c.conds }); }); });
            combos = next;
          });
          combos.forEach(function (c) {
            const cond = c.conds.length ? '${' + c.conds.map(function (k) { return k.slice(2, -1); }).join(' && ') + '}' : null;
            units[a.activityId].task.entry.push(B.sentry(stageId, c.parts, cond));
          });
        });
      });
      const stageW = Math.max(cx - x + SZ.pad - SZ.gap - 20, 220);
      const stageH = Math.max(colsBottom - top + SZ.pad - SZ.gap, 160);
      B.shapes.push({ ref: stage.id, x: x, y: top, w: stageW, h: stageH, expanded: true });
      B.defs.push({ container: CP, stageDef: stageId, name: st.order + '. ' + st.name });
      maxBottom = Math.max(maxBottom, top + stageH);

      // attività "non attese": a livello di case, partono insieme allo stage e non lo bloccano
      let dy = top + stageH + 40;
      sp.detached.forEach(function (a) {
        const u = addUnit(B, CP, a);
        u.task.required = false;
        u.elems.forEach(function (e) {
          if (e.required) e.required = false;
          const s = e.id.slice(-5) === '_done' ? SZ.ms : SZ.task;
          B.shapes.push({ ref: e.id, x: x + SZ.pad, y: dy, w: s[0], h: s[1] });
          dy += s[1] + SZ.gap;
        });
        if (u.listener) { B.shapes.push({ ref: u.listener.id, x: x + SZ.pad + 130, y: dy - SZ.gap - SZ.ev[1], w: SZ.ev[0], h: SZ.ev[1] }); }
        if (prevMilestone) u.task.entry.push(B.sentry(CP, [{ source: prevMilestone.id, event: 'occur' }]));
      });
      maxBottom = Math.max(maxBottom, dy);
      x += stageW + 40;

      if (st.exitGate) {
        const pol = st.exitGate.effectivePolicy;
        const gid = 'Gate_' + X.sid(st.stepId);
        const dec = B.item(CP, gid + '_decision', '<decisionTask id="' + gid + '_decision" name="' + X.xml('Valuta gate → ' + plan.steps[i + 1].name) + '">' +
          '<documentation>' + X.xml(pol.description.join(' · ')) + '</documentation>' +
          '<extensionElements>' + field('fallbackToDefaultTenant', 'true') + '</extensionElements>' +
          '<decisionRefExpression>' + gid + '</decisionRefExpression></decisionTask>');
        dec.entry.push(B.sentry(CP, [{ source: stage.id, event: 'complete' }]));
        B.shapes.push({ ref: dec.id, x: x, y: top + 40, w: SZ.task[0], h: SZ.task[1] });
        const ms = B.item(CP, gid + '_passed', '<milestone id="' + gid + '_passed" name="' + X.xml('Gate superato → ' + plan.steps[i + 1].name) + '" />');
        ms.entry.push(B.sentry(CP, [{ source: dec.id, event: 'complete' }], '${action == \'CONTINUE\' && activeProducts.size() > 0}'));
        B.shapes.push({ ref: ms.id, x: x, y: top + 160, w: SZ.ms[0], h: SZ.ms[1] });
        caseExits.push(B.sentry(CP, [{ source: dec.id, event: 'complete' }], '${action == \'STOP\' || activeProducts.size() == 0}'));
        prevMilestone = ms;
        x += SZ.task[0] + 40;
      }
    });

    /* ---------- serializzazione ---------- */
    const crit = [];
    function criteria(it) {
      return it.entry.map(function (s, k) { const cid = it.id + '_entry' + (k + 1); crit.push({ id: cid, item: it, side: 'left', k: k }); return '<entryCriterion id="' + cid + '" sentryRef="' + s + '" />'; }).join('');
    }
    function planItem(it) {
      const ctrl = [];
      if (it.required) ctrl.push('<requiredRule><condition>${true}</condition></requiredRule>');
      if (it.repetition) ctrl.push('<repetitionRule flowable:collectionVariable="activeProducts" flowable:elementVariable="product"><condition>${true}</condition></repetitionRule>');
      return '<planItem id="' + it.id + '" definitionRef="' + it.defId + '">' +
        (ctrl.length ? '<itemControl>' + ctrl.join('') + '</itemControl>' : '') + criteria(it) + '</planItem>';
    }
    function sentryXml(s) {
      return '<sentry id="' + s.id + '">' + s.onParts.map(function (p, k) {
        return '<planItemOnPart id="' + s.id + '_on' + (k + 1) + '" sourceRef="' + p.source + '"><standardEvent>' + p.event + '</standardEvent></planItemOnPart>';
      }).join('') + (s.cond ? '<ifPart id="' + s.id + '_if"><condition><![CDATA[' + s.cond + ']]></condition></ifPart>' : '') + '</sentry>';
    }
    function containerXml(cid, ind) {
      const out = [];
      B.items.filter(function (it) { return it.container === cid; }).forEach(function (it) { out.push(ind + planItem(it)); });
      B.sentries.filter(function (s) { return s.container === cid; }).forEach(function (s) { out.push(ind + sentryXml(s)); });
      B.defs.filter(function (d) { return d.container === cid; }).forEach(function (d) {
        if (d.stageDef) out.push(ind + '<stage id="' + d.stageDef + '" name="' + X.xml(d.name) + '" autoComplete="true">\n' + containerXml(d.stageDef, ind + '  ') + '\n' + ind + '</stage>');
        else out.push(ind + d.xml);
      });
      return out.join('\n');
    }
    const exitXml = caseExits.map(function (s, k) { const cid = CP + '_exit' + (k + 1); crit.push({ id: cid, cp: true, k: k }); return '      <exitCriterion id="' + cid + '" sentryRef="' + s + '" />'; }).join('\n');
    const body = containerXml(CP, '      ');

    const cpW = x + 20, cpH = maxBottom + 40;
    const shapeById = {};
    B.shapes.forEach(function (s) { shapeById[s.ref] = s; });
    const di = ['      <cmmndi:CMMNShape id="' + CP + '_di" cmmnElementRef="' + CP + '"><dc:Bounds x="20" y="20" width="' + cpW + '" height="' + cpH + '" /></cmmndi:CMMNShape>'];
    B.shapes.forEach(function (s) {
      di.push('      <cmmndi:CMMNShape id="' + s.ref + '_di" cmmnElementRef="' + s.ref + '"' + (s.expanded ? ' isCollapsed="false"' : '') + '><dc:Bounds x="' + s.x + '" y="' + s.y + '" width="' + s.w + '" height="' + s.h + '" /></cmmndi:CMMNShape>');
    });
    crit.forEach(function (c) {
      const host = c.cp ? { x: 20 + cpW, y: 20 + cpH / 2, w: 0, h: 0 } : shapeById[c.item.id];
      if (!host) return;
      const y = c.cp ? host.y - 11 + c.k * 26 : host.y + 4 + c.k * 24;
      const xx = c.cp ? host.x - 6 : host.x - 6;
      di.push('      <cmmndi:CMMNShape id="' + c.id + '_di" cmmnElementRef="' + c.id + '"><dc:Bounds x="' + xx + '" y="' + y + '" width="12" height="20" /></cmmndi:CMMNShape>');
    });

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<definitions xmlns="http://www.omg.org/spec/CMMN/20151109/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xmlns:flowable="http://flowable.org/cmmn" xmlns:cmmndi="http://www.omg.org/spec/CMMN/20151109/CMMNDI"' +
      ' xmlns:dc="http://www.omg.org/spec/CMMN/20151109/DC" xmlns:di="http://www.omg.org/spec/CMMN/20151109/DI"' +
      ' id="Definitions_' + caseId + '" targetNamespace="http://example.com/offers" exporter="Offer Process Designer" exporterVersion="1.0">\n' +
      '  <case id="Case_' + caseId + '" name="' + X.xml(plan.offer.name) + '">\n' +
      '    <documentation>' + X.xml('Variabili attese all\'avvio: activeProducts (lista prodotti), pratica, cliente. I task impostano outcome_<attività> e koProducts.') + '</documentation>\n' +
      '    <casePlanModel id="' + CP + '" name="' + X.xml(plan.offer.name) + '" autoComplete="true">\n' +
      body + '\n' + exitXml + (exitXml ? '\n' : '') +
      '    </casePlanModel>\n  </case>\n' +
      '  <cmmndi:CMMNDI>\n    <cmmndi:CMMNDiagram id="Diagram_' + caseId + '">\n' + di.join('\n') + '\n    </cmmndi:CMMNDiagram>\n  </cmmndi:CMMNDI>\n' +
      '</definitions>\n';
  }

  X.buildCmmn = build;
  X.register({
    id: 'flowable',
    label: 'Flowable (CMMN 1.1 + DMN)',
    notes: [
      'Modello a "case": ogni step è uno stage (autoComplete); è il modello più vicino allo schizzo (stage + milestone + sentry).',
      'Le attività sono task HTTP Flowable verso ' + X.BASE_URL + ' + path del catalogo; "Esegui dopo" diventa una sentry di ingresso.',
      '"1 chiamata per prodotto" = repetition rule sulla collezione activeProducts.',
      'Task asincroni: event listener (flowable:eventType = topic di callback) + milestone "esito ricevuto" obbligatoria.',
      '"KO con task": human task con candidateGroups = coda, attivato se outcome_<attività> = KO_TASK; le dipendenze attendono il task manuale.',
      'Barre arancioni: decision task sulla decisione DMN Gate_<STEP> → milestone "gate superato" che apre lo stage successivo, oppure exit criterion del case (STOP / nessun prodotto).',
      '"Non attendere": l\'attività è a livello di case, parte con lo stage ma non ne blocca il completamento.'
    ],
    files: function (plan) {
      return [
        { name: 'offer-' + X.kebab(plan.offer.id) + '.cmmn', mime: 'application/xml', content: build(plan) },
        { name: 'offer-' + X.kebab(plan.offer.id) + '-gates.dmn', mime: 'application/xml', content: X.buildDmn(plan) }
      ];
    }
  });
})();
