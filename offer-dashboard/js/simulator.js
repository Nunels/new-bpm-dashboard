/* Simulazione: dati gli esiti per blocco/prodotto, propaga i prodotti attraverso step e gate. */
(function () {
  const PENDING_LIKE = ['PENDING', 'KO_TASK', 'WAITING'];
  const MAX_PASSES = 200; // rete di sicurezza: i ritorni sono già limitati da maxIterations

  const getPath = function (obj, path) { return Fields.getPath(obj, path); };

  /* Un esito può essere un valore o una lista di valori, uno per passaggio nello step (l'ultimo vale anche per i successivi). */
  function pick(v, pass) { return Array.isArray(v) ? v[Math.min(pass - 1, v.length - 1)] : v; }

  /*
   * outcomes: { blockId: { productId: 'OK' | 'KO' | 'KO_TASK' | 'PENDING' } } (default OK)
   * scenario: { practice: {…dati della pratica…}, outputs: { blockId: {…output del blocco…} } } per valutare le condizioni (when / ROUTE)
   * opts.recoverAfterLoop: dopo un ritorno indietro tutti i blocchi rieseguiti rispondono OK
   * Ritorna per ogni passaggio negli step: prodotti in ingresso, esiti per blocco, stato per prodotto e verdetto del gate.
   */
  function run(data, offer, outcomes, scenario, opts) {
    outcomes = outcomes || {};
    scenario = scenario || {};
    opts = opts || {};
    let active = offer.products.slice();
    const asyncPending = []; // esiti "non attesi" ancora aperti
    const result = { steps: [], final: null, log: [], routes: [] };
    const log = function (msg, kind) { result.log.push({ msg: msg, kind: kind || '' }); };
    const history = {};      // blockId -> productId -> ultimo stato (per le condizioni sull'esito di un blocco)
    const passes = {};       // stepId -> quante volte è stato eseguito
    const loops = {};        // chiave regola -> ritorni già fatti
    let guard = 0;

    const koState = function (st) { return st === 'KO' || st === 'KO_IGNORED'; };
    /* Ambiente di valutazione: `block` = blocco che valuta la condizione, `pid` = prodotto corrente, `targets` = prodotti del blocco; senza blocco vale per un gate. */
    const envFor = function (block, pid, targets) {
      return {
        type: function (left) { return Conditions.leftType(data, offer, left); },
        value: function (left) {
          const k = Conditions.leftKind(left);
          if (k.kind === 'path') return getPath(scenario.practice, k.path);
          if (k.kind === 'system') return k.path === 'prodotto.id' ? pid : targets.slice();
          const src = Fields.resolveBlock(offer, k.ref);
          if (!src) return undefined;
          if (k.kind === 'outcome') {
            const states = history[src.id] || {};
            const ko = !block ? Object.keys(states).some(function (p) { return koState(states[p]); })
              : Conditions.isPerProduct(block) ? koState(states[pid])
              : targets.some(function (p) { return koState(states[p]); });
            return ko ? 'KO' : 'OK';
          }
          const task = Model.task(data, src.taskId);
          const pick = function (list) {
            const pr = task && task.productResults;
            return pr ? list.find(function (el) { return getPath(el, pr.productField) === pid; }) : list[0];
          };
          const v = getPath((scenario.outputs || {})[src.id], k.field, pick);
          // il produttore ha girato per prodotto e chi legge no: riceve la lista dei risultati (come nel DSL)
          if (!Fields.hasList(k.field) && Conditions.isPerProduct(src) && !Conditions.isPerProduct(block)) return Object.keys(history[src.id] || {}).map(function () { return v; });
          return v;
        }
      };
    };

    let i = 0;
    while (i < data.steps.length) {
      if (++guard > MAX_PASSES) { result.final = { status: 'FAILED', message: 'Troppi passaggi: simulazione interrotta', active: [] }; return result; }
      const step = data.steps[i];
      const isLast = i === data.steps.length - 1;
      const gates = Model.gatesAfter(offer, step.id);
      const policy = Model.effectivePolicy(gates);
      const blocks = Model.blocksInStep(offer, step.id);
      const ordered = [].concat.apply([], Model.levels(blocks).levels);
      const blockResults = {};
      const productStatus = {};
      const pass = passes[step.id] = (passes[step.id] || 0) + 1;
      const sr = { stepId: step.id, iteration: pass, entering: active.slice(), blockResults: blockResults, productStatus: productStatus, gate: null };
      result.steps.push(sr);

      if (!active.length) { sr.skipped = true; i++; continue; }
      log('▶ ' + step.name + (pass > 1 ? ' (giro ' + pass + ')' : '') + ': entrano ' + names(data, active), 'step');

      ordered.forEach(function (b) {
        const t = Model.task(data, b.taskId);
        const tn = t ? t.name : b.taskId;
        blockResults[b.id] = {};
        // stato di partenza per prodotto: dipendenze, poi condizione, poi esito scelto
        const runnable = [];
        b.products.forEach(function (pid) {
          if (active.indexOf(pid) < 0) { blockResults[b.id][pid] = 'NOT_ACTIVE'; return; }
          const depStates = b.dependsOn.map(function (d) { return (blockResults[d] || {})[pid]; }).filter(Boolean);
          if (depStates.some(function (s) { return s === 'KO' || s === 'SKIPPED'; })) blockResults[b.id][pid] = 'SKIPPED';
          else if (depStates.some(function (s) { return PENDING_LIKE.indexOf(s) >= 0; })) blockResults[b.id][pid] = 'WAITING';
          else runnable.push(pid);
        });
        let blockCond = true;
        if (Conditions.isActive(b.config.when) && !Conditions.isPerProduct(b)) blockCond = Conditions.evaluate(b.config.when, envFor(b, null, runnable));
        runnable.forEach(function (pid) {
          let st;
          const cond = !Conditions.isActive(b.config.when) ? true : Conditions.isPerProduct(b) ? Conditions.evaluate(b.config.when, envFor(b, pid, runnable)) : blockCond;
          if (!cond) st = 'SKIPPED_BY_CONDITION';
          else {
            st = opts.recoverAfterLoop && pass > 1 ? 'OK' : (pick((outcomes[b.id] || {})[pid], pass) || 'OK');
            if (st === 'KO_TASK' && !(b.config.koTask.enabled && t && t.outcomes.indexOf('KO_TASK') >= 0)) st = 'KO';
            if (st === 'KO' && b.config.onKo === 'IGNORE') st = 'KO_IGNORED';
          }
          blockResults[b.id][pid] = st;
        });
        history[b.id] = history[b.id] || {};
        b.products.forEach(function (pid) {
          const st = blockResults[b.id][pid];
          if (st === 'NOT_ACTIVE') return;
          history[b.id][pid] = st;
          const pn = Model.productName(data, pid);
          if (st === 'KO') log('  ✖ ' + tn + ' KO per ' + pn, 'ko');
          else if (st === 'KO_IGNORED') log('  ⚠ ' + tn + ' KO per ' + pn + ' (ignorato, non bloccante)', 'warn');
          else if (st === 'KO_TASK') log('  ✋ ' + tn + ' KO per ' + pn + ': aperto task manuale su coda ' + (b.config.koTask.queue || '?'), 'warn');
          else if (st === 'PENDING') log('  … ' + tn + ' in attesa di esito per ' + pn, 'warn');
          else if (st === 'SKIPPED') log('  ⤼ ' + tn + ' non eseguito per ' + pn + ' (dipendenza KO)', '');
          else if (st === 'SKIPPED_BY_CONDITION') log('  ⤼ ' + tn + ' saltato per ' + pn + ' (condizione non soddisfatta: ' + Conditions.describe(data, offer, b.config.when) + ')', '');
        });
      });

      active.forEach(function (pid) {
        let ko = false, pending = false, async = false;
        blocks.forEach(function (b) {
          const st = (blockResults[b.id] || {})[pid];
          if (!st) return;
          if (st === 'KO' || st === 'SKIPPED') ko = true;
          else if (PENDING_LIKE.indexOf(st) >= 0) {
            if (!isLast && policy.dontWait.indexOf(b.id) >= 0) async = true; else pending = true;
          }
        });
        productStatus[pid] = ko ? 'KO' : (pending ? 'PENDING' : (async ? 'ASYNC' : 'OK'));
        if (async) asyncPending.push({ stepId: step.id, productId: pid });
      });

      const koList = active.filter(function (p) { return productStatus[p] === 'KO'; });
      const pendList = active.filter(function (p) { return productStatus[p] === 'PENDING'; });

      if (isLast) {
        sr.gate = null;
        if (pendList.length) {
          result.final = { status: 'WAITING', message: 'Processo in attesa di esiti in ' + step.name + ' per ' + names(data, pendList), active: active };
          log('⏸ ' + result.final.message, 'warn');
          return result;
        }
        const done = active.filter(function (p) { return productStatus[p] !== 'KO'; });
        result.final = { status: done.length ? 'COMPLETED' : 'FAILED', message: done.length ? 'Completati: ' + names(data, done) + (koList.length ? ' — KO in post attivazione: ' + names(data, koList) : '') : 'Nessun prodotto completato', active: done };
        log((done.length ? '✔ ' : '✖ ') + result.final.message, done.length ? 'ok' : 'ko');
        break;
      }

      const next = data.steps[i + 1].name;
      if (pendList.length) {
        sr.gate = { verdict: 'WAIT', text: 'In attesa: ' + names(data, pendList), passed: [], excluded: [] };
        result.final = { status: 'WAITING', message: 'Gate ' + step.name + ' → ' + next + ' in attesa di esiti per ' + names(data, pendList) + ' (nessuna regola "Non attendere")', active: active };
        log('⏸ ' + result.final.message, 'warn');
        return result;
      }

      // instradamenti prima delle regole del gate: ritorno indietro (stesso step o precedente) e stop
      const routable = Model.routesAfter(offer, step.id).filter(function (r) { return r.rule.to === 'STOP' || !!Model.step(data, r.rule.to); });
      const early = routable.filter(function (r) { return r.rule.to === 'STOP' || Model.stepIndex(data, r.rule.to) <= i; });
      let routed = false;
      for (let k = 0; k < early.length && !routed; k++) {
        const r = early[k];
        if (!Conditions.evaluate(r.rule.when, envFor(null, null, active))) continue;
        const why = Conditions.describe(data, offer, r.rule.when);
        if (r.rule.to === 'STOP') {
          sr.gate = { verdict: 'STOP', text: 'STOP: ' + why, passed: [], excluded: active.slice(), route: { to: 'STOP' } };
          result.final = { status: 'STOPPED', message: 'Offerta fermata al gate ' + step.name + ' → ' + next + ' dall\'instradamento: ' + why, active: [] };
          log('⛔ ' + result.final.message, 'ko');
          return result;
        }
        const n = loops[r.key] || 0;
        const dest = Model.step(data, r.rule.to);
        if (n >= r.rule.maxIterations) {
          log('  ⚠ Ritorno a ' + dest.name + ' non più possibile: già ' + n + ' volte (massimo ' + r.rule.maxIterations + ')', 'warn');
          if (r.rule.onExceed === 'STOP') {
            sr.gate = { verdict: 'STOP', text: 'STOP: superato il massimo di ritorni a ' + dest.name, passed: [], excluded: active.slice(), route: { to: 'STOP' } };
            result.final = { status: 'STOPPED', message: 'Offerta fermata al gate ' + step.name + ' → ' + next + ': superato il massimo di ' + r.rule.maxIterations + ' ritorni a ' + dest.name, active: [] };
            log('⛔ ' + result.final.message, 'ko');
            return result;
          }
          continue;
        }
        loops[r.key] = n + 1;
        const to = Model.stepIndex(data, r.rule.to);
        for (let j = to; j <= i; j++) Model.blocksInStep(offer, data.steps[j].id).forEach(function (b) { delete history[b.id]; });
        sr.gate = { verdict: 'ROUTE', text: 'Ritorno a ' + dest.name + ' (' + (n + 1) + '/' + r.rule.maxIterations + '): ' + why, passed: [], excluded: [], route: { to: r.rule.to, kind: 'back', n: n + 1, max: r.rule.maxIterations } };
        result.routes.push({ from: step.id, to: r.rule.to, kind: 'back', key: r.key, n: n + 1, max: r.rule.maxIterations });
        log('↩ Gate ' + step.name + ' → torna a ' + dest.name + ' (' + (n + 1) + '/' + r.rule.maxIterations + '): ' + why, 'gate');
        i = to;
        routed = true;
      }
      if (routed) continue;

      if (policy.stopOnKo) {
        const scope = policy.stopOnKo === 'ALL' ? active : policy.stopOnKo;
        const blocking = koList.filter(function (p) { return scope.indexOf(p) >= 0; });
        if (blocking.length) {
          sr.gate = { verdict: 'STOP', text: 'STOP: KO su ' + names(data, blocking), passed: [], excluded: active.slice() };
          result.final = { status: 'STOPPED', message: 'Offerta fermata al gate ' + step.name + ' → ' + next + ' per KO su ' + names(data, blocking), active: [] };
          log('⛔ ' + result.final.message, 'ko');
          return result;
        }
      }
      let passed, excluded;
      if (policy.koPolicy === 'CONTINUE_ON_KO' && !policy.conflict) { passed = active.slice(); excluded = []; }
      else { passed = active.filter(function (p) { return productStatus[p] !== 'KO'; }); excluded = koList; }
      const asyncHere = active.filter(function (p) { return productStatus[p] === 'ASYNC'; });
      sr.gate = {
        verdict: passed.length ? 'PASS' : 'STOP',
        text: (passed.length ? 'Passano: ' + names(data, passed) : 'Nessun prodotto passa') + (excluded.length ? ' — esclusi: ' + names(data, excluded) : '') + (asyncHere.length ? ' — esito asincrono atteso: ' + names(data, asyncHere) : ''),
        passed: passed, excluded: excluded
      };
      log((passed.length ? '➜ ' : '⛔ ') + 'Gate ' + step.name + ' → ' + next + ': ' + sr.gate.text, passed.length ? 'gate' : 'ko');
      active = passed;
      if (!active.length) {
        result.final = { status: 'FAILED', message: 'Nessun prodotto supera il gate ' + step.name + ' → ' + next, active: [] };
        return result;
      }

      // salti in avanti, dopo la politica KO del gate
      const ahead = routable.filter(function (r) { return r.rule.to !== 'STOP' && Model.stepIndex(data, r.rule.to) > i; });
      for (let k = 0; k < ahead.length && !routed; k++) {
        const r = ahead[k];
        if (!Conditions.evaluate(r.rule.when, envFor(null, null, active))) continue;
        const to = Model.stepIndex(data, r.rule.to);
        const dest = Model.step(data, r.rule.to);
        const why = Conditions.describe(data, offer, r.rule.when);
        sr.gate.route = { to: r.rule.to, kind: 'skip' };
        sr.gate.text += ' — salta a ' + dest.name;
        result.routes.push({ from: step.id, to: r.rule.to, kind: 'skip', key: r.key });
        log('⤳ Gate ' + step.name + ' → salta a ' + dest.name + ': ' + why, 'gate');
        for (let j = i + 1; j < to; j++) result.steps.push({ stepId: data.steps[j].id, iteration: 1, entering: [], blockResults: {}, productStatus: {}, gate: null, skipped: true, routed: true });
        i = to - 1;
        routed = true;
      }
      i++;
    }
    if (!result.final) result.final = { status: 'NO_PRODUCTS', message: 'L\'offerta non contiene prodotti', active: [] };
    if (asyncPending.length) {
      result.final.message += ' — restano esiti asincroni da ricevere per: ' + asyncPending.map(function (a) { return Model.productName(data, a.productId) + ' (' + Model.step(data, a.stepId).name + ')'; }).join(', ');
    }
    return result;
  }

  function names(data, ids) { return ids.map(function (p) { return Model.productName(data, p); }).join(', ') || '—'; }

  window.Simulator = { run: run };
})();
