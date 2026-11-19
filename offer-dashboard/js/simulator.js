/* Simulazione: dati gli esiti per blocco/prodotto, propaga i prodotti attraverso step e gate. */
(function () {
  const PENDING_LIKE = ['PENDING', 'KO_TASK', 'WAITING'];

  /*
   * outcomes: { blockId: { productId: 'OK' | 'KO' | 'KO_TASK' | 'PENDING' } } (default OK)
   * Ritorna per ogni step: prodotti in ingresso, esiti per blocco, stato per prodotto e verdetto del gate.
   */
  function run(data, offer, outcomes) {
    outcomes = outcomes || {};
    let active = offer.products.slice();
    const asyncPending = []; // esiti "non attesi" ancora aperti
    const result = { steps: [], final: null, log: [] };
    const log = function (msg, kind) { result.log.push({ msg: msg, kind: kind || '' }); };

    for (let i = 0; i < data.steps.length; i++) {
      const step = data.steps[i];
      const isLast = i === data.steps.length - 1;
      const gates = Model.gatesAfter(offer, step.id);
      const policy = Model.effectivePolicy(gates);
      const blocks = Model.blocksInStep(offer, step.id);
      const ordered = [].concat.apply([], Model.levels(blocks).levels);
      const blockResults = {};
      const productStatus = {};
      const sr = { stepId: step.id, entering: active.slice(), blockResults: blockResults, productStatus: productStatus, gate: null };
      result.steps.push(sr);

      if (!active.length) { sr.skipped = true; continue; }
      log('▶ ' + step.name + ': entrano ' + names(data, active), 'step');

      ordered.forEach(function (b) {
        const t = Model.task(data, b.taskId);
        blockResults[b.id] = {};
        b.products.forEach(function (pid) {
          if (active.indexOf(pid) < 0) { blockResults[b.id][pid] = 'NOT_ACTIVE'; return; }
          const depStates = b.dependsOn.map(function (d) { return (blockResults[d] || {})[pid]; }).filter(Boolean);
          let st;
          if (depStates.some(function (s) { return s === 'KO' || s === 'SKIPPED'; })) st = 'SKIPPED';
          else if (depStates.some(function (s) { return PENDING_LIKE.indexOf(s) >= 0; })) st = 'WAITING';
          else {
            st = ((outcomes[b.id] || {})[pid]) || 'OK';
            if (st === 'KO_TASK' && !(b.config.koTask.enabled && t && t.outcomes.indexOf('KO_TASK') >= 0)) st = 'KO';
            if (st === 'KO' && b.config.onKo === 'IGNORE') st = 'KO_IGNORED';
          }
          blockResults[b.id][pid] = st;
          const tn = t ? t.name : b.taskId;
          if (st === 'KO') log('  ✖ ' + tn + ' KO per ' + Model.productName(data, pid), 'ko');
          else if (st === 'KO_IGNORED') log('  ⚠ ' + tn + ' KO per ' + Model.productName(data, pid) + ' (ignorato, non bloccante)', 'warn');
          else if (st === 'KO_TASK') log('  ✋ ' + tn + ' KO per ' + Model.productName(data, pid) + ': aperto task manuale su coda ' + (b.config.koTask.queue || '?'), 'warn');
          else if (st === 'PENDING') log('  … ' + tn + ' in attesa di esito per ' + Model.productName(data, pid), 'warn');
          else if (st === 'SKIPPED') log('  ⤼ ' + tn + ' non eseguito per ' + Model.productName(data, pid) + ' (dipendenza KO)', '');
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
