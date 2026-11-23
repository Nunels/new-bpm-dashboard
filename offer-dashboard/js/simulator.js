/* Simulazione: dati gli esiti per blocco/prodotto, esegue il grafo (sequenze, rami paralleli, gate) propagando i prodotti KO. */
(function () {
  const PENDING_LIKE = ['PENDING', 'KO_TASK', 'WAITING'];
  const MAX_PASSES = 400; // rete di sicurezza: i ritorni sono già limitati da maxIterations

  const getPath = function (obj, path) { return Fields.getPath(obj, path); };

  /* Un esito può essere un valore o una lista di valori, uno per passaggio nel blocco (l'ultimo vale anche per i successivi). */
  function pick(v, pass) { return Array.isArray(v) ? v[Math.min(pass - 1, v.length - 1)] : v; }

  /*
   * outcomes: { blockId: { productId: 'OK' | 'KO' | 'KO_TASK' | 'PENDING' } } (default OK)
   * scenario: { practice: {…dati della pratica…}, outputs: { blockId: {…output del blocco…} } } per valutare le condizioni (when / ROUTE)
   * opts.recoverAfterLoop: dopo un ritorno indietro tutti i blocchi rieseguiti rispondono OK
   *
   * Semantica (la stessa del DSL): un prodotto KO in un blocco viene escluso dai nodi che ne dipendono (anche indirettamente);
   * un gate "Solo OK" lo lascia escluso, "Prosegui anche con KO" lo riammette. Un blocco saltato da una condizione è neutro.
   * Ritorna { blocks, gates, productStatus, final, log, routes, order }: per blocco gli esiti effettivi per prodotto, per gate il verdetto.
   */
  function run(data, offer, outcomes, scenario, opts) {
    outcomes = outcomes || {};
    scenario = scenario || {};
    opts = opts || {};
    const result = { blocks: {}, gates: {}, productStatus: {}, final: null, log: [], routes: [], order: [] };
    const log = function (msg, kind) { result.log.push({ msg: msg, kind: kind || '' }); };
    const st = Model.structure(offer);
    result.order = st.order.slice();
    if (st.errors.length) {
      result.final = { status: 'FAILED', message: 'Il grafo non è valido: ' + Model.structureErrors(data, offer, st).join(' '), active: [] };
      return result;
    }
    if (!offer.products.length) { result.final = { status: 'NO_PRODUCTS', message: 'L\'offerta non contiene prodotti', active: [] }; return result; }

    const graph = st.graph;
    const order = st.order;
    const topIdx = {};
    st.top.forEach(function (id, k) { topIdx[id] = k; });
    const detached = {};      // blocchi con "Non attendere" su uno dei gate
    offer.gates.forEach(function (g) { g.rules.forEach(function (r) { if (r.type === 'DONT_WAIT' && r.blockId) detached[r.blockId] = true; }); });
    const history = {};       // blockId -> productId -> ultimo stato (per le condizioni sull'esito di un blocco)
    const dead = {};          // nodeId -> { prodotto: true }: prodotti KO/esclusi a questo punto del percorso
    const pend = {};          // nodeId -> { prodotto: true }: prodotti ancora in attesa di un esito
    const passes = {};        // nodeId -> quante volte è stato eseguito
    const loops = {};         // chiave regola -> ritorni già fatti
    const asyncPending = [];  // esiti "non attesi" ancora aperti
    const executed = {};
    let guard = 0;

    const union = function (ids, map) {
      const u = {};
      ids.forEach(function (d) { Object.keys(map[d] || {}).forEach(function (p) { u[p] = true; }); });
      return u;
    };
    const koState = function (s) { return s === 'KO' || s === 'KO_IGNORED'; };
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
          const choose = function (list) {
            const pr = task && task.productResults;
            return pr ? list.find(function (el) { return getPath(el, pr.productField) === pid; }) : list[0];
          };
          const v = getPath((scenario.outputs || {})[src.id], k.field, choose);
          // il produttore ha girato per prodotto e chi legge no: riceve la lista dei risultati (come nel DSL)
          if (!Fields.hasList(k.field) && Conditions.isPerProduct(src) && !Conditions.isPerProduct(block)) return Object.keys(history[src.id] || {}).map(function () { return v; });
          return v;
        }
      };
    };

    const reset = function (ids) {
      ids.forEach(function (id) { delete history[id]; delete dead[id]; delete pend[id]; delete executed[id]; });
    };
    const names = function (ids) { return ids.map(function (p) { return Model.productName(data, p); }).join(', ') || '—'; };

    const runBlock = function (b) {
      const t = Model.task(data, b.taskId);
      const tn = t ? t.name : b.taskId;
      const pass = passes[b.id] = (passes[b.id] || 0) + 1;
      const deps = graph.deps[b.id];
      const inDead = union(deps, dead), inPend = union(deps, pend);
      const res = {};
      const entry = result.blocks[b.id] = { results: res, passes: pass, reached: [], detached: !!detached[b.id] };
      const runnable = [];
      b.products.forEach(function (pid) {
        if (offer.products.indexOf(pid) < 0) { res[pid] = 'NOT_ACTIVE'; return; }
        if (inDead[pid]) res[pid] = 'SKIPPED';
        else if (inPend[pid]) res[pid] = 'WAITING';
        else runnable.push(pid);
      });
      let blockCond = true;
      if (Conditions.isActive(b.config.when) && !Conditions.isPerProduct(b)) blockCond = Conditions.evaluate(b.config.when, envFor(b, null, runnable));
      runnable.forEach(function (pid) {
        let s;
        const cond = !Conditions.isActive(b.config.when) ? true : Conditions.isPerProduct(b) ? Conditions.evaluate(b.config.when, envFor(b, pid, runnable)) : blockCond;
        if (!cond) s = 'SKIPPED_BY_CONDITION';
        else {
          s = opts.recoverAfterLoop && pass > 1 ? 'OK' : (pick((outcomes[b.id] || {})[pid], pass) || 'OK');
          if (s === 'KO_TASK' && !(b.config.koTask.enabled && t && t.outcomes.indexOf('KO_TASK') >= 0)) s = 'KO';
          if (s === 'KO' && b.config.onKo === 'IGNORE') s = 'KO_IGNORED';
          entry.reached.push(pid);
        }
        res[pid] = s;
      });
      history[b.id] = history[b.id] || {};
      const myDead = Object.assign({}, inDead), myPend = Object.assign({}, inPend);
      b.products.forEach(function (pid) {
        const s = res[pid];
        if (s === 'NOT_ACTIVE') return;
        history[b.id][pid] = s;
        const pn = Model.productName(data, pid);
        if (detached[b.id] && s !== 'SKIPPED' && s !== 'WAITING' && s !== 'SKIPPED_BY_CONDITION') {
          log('  ⏩ ' + tn + ' non atteso (Non attendere): l\'esito per ' + pn + ' non blocca il flusso', 'warn');
          if (PENDING_LIKE.indexOf(s) >= 0) asyncPending.push({ blockId: b.id, productId: pid });
          return;
        }
        if (s === 'KO') { myDead[pid] = true; log('  ✖ ' + tn + ' KO per ' + pn, 'ko'); }
        else if (s === 'KO_IGNORED') log('  ⚠ ' + tn + ' KO per ' + pn + ' (ignorato, non bloccante)', 'warn');
        else if (s === 'KO_TASK') { myPend[pid] = true; log('  ✋ ' + tn + ' KO per ' + pn + ': aperto task manuale su coda ' + (b.config.koTask.queue || '?'), 'warn'); }
        else if (s === 'PENDING') { myPend[pid] = true; log('  … ' + tn + ' in attesa di esito per ' + pn, 'warn'); }
        else if (s === 'WAITING') myPend[pid] = true;
        else if (s === 'SKIPPED') { myDead[pid] = true; log('  ⤼ ' + tn + ' non eseguito per ' + pn + ' (dipendenza KO)', ''); }
        else if (s === 'SKIPPED_BY_CONDITION') log('  ⤼ ' + tn + ' saltato per ' + pn + ' (condizione non soddisfatta: ' + Conditions.describe(data, offer, b.config.when) + ')', '');
      });
      dead[b.id] = myDead; pend[b.id] = myPend; executed[b.id] = true;
    };

    /* Esegue un gate; ritorna null (si prosegue), { jump: indice } (ritorno/salto) oppure { stop: true } (la simulazione termina). */
    const runGate = function (g, at) {
      const pass = passes[g.id] = (passes[g.id] || 0) + 1;
      const inDead = union(graph.deps[g.id], dead), inPend = union(graph.deps[g.id], pend);
      const scope = Model.scopeProducts(offer, g.id, graph);
      const inScope = function (map) { return scope.filter(function (p) { return map[p]; }); };
      const policy = Model.effectivePolicy([g]);
      const label = 'Gate ' + g.id;
      const verdict = result.gates[g.id] = { verdict: 'PASS', text: '', passed: [], excluded: [], passes: pass };
      const waiting = inScope(inPend);
      if (waiting.length) {
        verdict.verdict = 'WAIT'; verdict.text = 'In attesa: ' + names(waiting);
        result.final = { status: 'WAITING', message: label + ' in attesa di esiti per ' + names(waiting) + ' (nessuna regola "Non attendere")', active: scope.filter(function (p) { return !inDead[p]; }) };
        log('⏸ ' + result.final.message, 'warn');
        return { stop: true };
      }
      executed[g.id] = true;
      const routes = Model.routesOf(g).filter(function (r) { return r.rule.to === 'STOP' || (topIdx[r.rule.to] != null && topIdx[g.id] != null); });
      const early = routes.filter(function (r) { return r.rule.to === 'STOP' || topIdx[r.rule.to] <= topIdx[g.id]; });
      for (let k = 0; k < early.length; k++) {
        const r = early[k];
        if (!Conditions.evaluate(r.rule.when, envFor(null, null, scope))) continue;
        const why = Conditions.describe(data, offer, r.rule.when);
        if (r.rule.to === 'STOP') {
          verdict.verdict = 'STOP'; verdict.text = 'STOP: ' + why; verdict.route = { to: 'STOP' };
          result.final = { status: 'STOPPED', message: 'Offerta fermata da ' + label + ' (instradamento): ' + why, active: [] };
          log('⛔ ' + result.final.message, 'ko');
          return { stop: true };
        }
        const n = loops[r.key] || 0;
        const destName = Model.nodeName(data, offer, r.rule.to);
        if (n >= r.rule.maxIterations) {
          log('  ⚠ Ritorno a ' + destName + ' non più possibile: già ' + n + ' volte (massimo ' + r.rule.maxIterations + ')', 'warn');
          if (r.rule.onExceed === 'STOP') {
            verdict.verdict = 'STOP'; verdict.text = 'STOP: superato il massimo di ritorni a ' + destName; verdict.route = { to: 'STOP' };
            result.final = { status: 'STOPPED', message: 'Offerta fermata da ' + label + ': superato il massimo di ' + r.rule.maxIterations + ' ritorni a ' + destName, active: [] };
            log('⛔ ' + result.final.message, 'ko');
            return { stop: true };
          }
          continue;
        }
        loops[r.key] = n + 1;
        const to = order.indexOf(r.rule.to);
        reset(order.slice(to, at + 1));
        verdict.verdict = 'ROUTE'; verdict.text = 'Ritorno a ' + destName + ' (' + (n + 1) + '/' + r.rule.maxIterations + '): ' + why;
        verdict.route = { to: r.rule.to, kind: 'back', n: n + 1, max: r.rule.maxIterations };
        result.routes.push({ from: g.id, to: r.rule.to, kind: 'back', key: r.key, n: n + 1, max: r.rule.maxIterations });
        log('↩ ' + label + ' → torna a ' + destName + ' (' + (n + 1) + '/' + r.rule.maxIterations + '): ' + why, 'gate');
        return { jump: to };
      }

      if (policy.stopOnKo) {
        const sc = policy.stopOnKo === 'ALL' ? scope : policy.stopOnKo;
        const blocking = inScope(inDead).filter(function (p) { return sc.indexOf(p) >= 0; });
        if (blocking.length) {
          verdict.verdict = 'STOP'; verdict.text = 'STOP: KO su ' + names(blocking);
          result.final = { status: 'STOPPED', message: 'Offerta fermata da ' + label + ' per KO su ' + names(blocking), active: [] };
          log('⛔ ' + result.final.message, 'ko');
          return { stop: true };
        }
      }
      let passed, excluded;
      if (policy.koPolicy === 'CONTINUE_ON_KO' && !policy.conflict) { dead[g.id] = {}; passed = scope.slice(); excluded = []; }
      else { dead[g.id] = Object.assign({}, inDead); passed = scope.filter(function (p) { return !inDead[p]; }); excluded = inScope(inDead); }
      pend[g.id] = {};
      const asyncHere = asyncPending.filter(function (a) { return graph.deps[g.id].indexOf(a.blockId) >= 0; }).map(function (a) { return a.productId; });
      verdict.verdict = passed.length ? 'PASS' : 'NONE';
      verdict.passed = passed; verdict.excluded = excluded;
      verdict.text = (passed.length ? 'Passano: ' + names(passed) : 'Nessun prodotto passa') + (excluded.length ? ' — esclusi: ' + names(excluded) : '') + (asyncHere.length ? ' — esito asincrono atteso: ' + names(asyncHere) : '');
      log((passed.length ? '➜ ' : '⛔ ') + label + ': ' + verdict.text, passed.length ? 'gate' : 'ko');

      // salti in avanti, dopo la politica KO del gate: i nodi saltati lasciano passare ciò che il gate ha lasciato passare
      const ahead = routes.filter(function (r) { return r.rule.to !== 'STOP' && topIdx[r.rule.to] > topIdx[g.id]; });
      for (let k = 0; k < ahead.length; k++) {
        const r = ahead[k];
        if (!Conditions.evaluate(r.rule.when, envFor(null, null, scope))) continue;
        const to = order.indexOf(r.rule.to);
        const why = Conditions.describe(data, offer, r.rule.when);
        const destName = Model.nodeName(data, offer, r.rule.to);
        verdict.route = { to: r.rule.to, kind: 'skip' };
        verdict.text += ' — salta a ' + destName;
        result.routes.push({ from: g.id, to: r.rule.to, kind: 'skip', key: r.key });
        log('⤳ ' + label + ' → salta a ' + destName + ': ' + why, 'gate');
        order.slice(at + 1, to).forEach(function (id) {
          dead[id] = Object.assign({}, dead[g.id]); pend[id] = {};
          if (Model.block(offer, id)) result.blocks[id] = { results: {}, passes: 0, reached: [], skipped: true };
          else result.gates[id] = { verdict: 'SKIPPED', text: 'Saltato dall\'instradamento', passed: [], excluded: [], passes: 0 };
        });
        return { jump: to };
      }
      return null;
    };

    /* Esito finale per prodotto: KO se è KO in uno dei nodi finali (rami compresi), in attesa se manca un esito. */
    const finish = function (stopped) {
      const leaves = order.filter(function (id) { return !(graph.kids[id] || []).length && executed[id]; });
      const fDead = union(leaves, dead), fPend = union(leaves, pend);
      offer.products.forEach(function (p) {
        result.productStatus[p] = stopped && result.final.status === 'STOPPED' ? 'STOPPED' : fDead[p] ? 'KO' : fPend[p] ? 'PENDING' : 'OK';
      });
      if (stopped) return;
      const ok = offer.products.filter(function (p) { return result.productStatus[p] === 'OK'; });
      const ko = offer.products.filter(function (p) { return result.productStatus[p] === 'KO'; });
      const waiting = offer.products.filter(function (p) { return result.productStatus[p] === 'PENDING'; });
      if (waiting.length) {
        result.final = { status: 'WAITING', message: 'Processo in attesa di esiti per ' + names(waiting), active: ok.concat(waiting) };
        log('⏸ ' + result.final.message, 'warn');
      } else {
        result.final = { status: ok.length ? 'COMPLETED' : 'FAILED', message: ok.length ? 'Completati: ' + names(ok) + (ko.length ? ' — KO: ' + names(ko) : '') : 'Nessun prodotto completato', active: ok };
        log((ok.length ? '✔ ' : '✖ ') + result.final.message, ok.length ? 'ok' : 'ko');
      }
      if (asyncPending.length) {
        result.final.message += ' — restano esiti asincroni da ricevere per: ' + asyncPending.map(function (a) { return Model.productName(data, a.productId) + ' (' + Model.nodeName(data, offer, a.blockId) + ')'; }).join(', ');
      }
    };

    let i = 0;
    while (i < order.length) {
      if (++guard > MAX_PASSES) { result.final = { status: 'FAILED', message: 'Troppi passaggi: simulazione interrotta', active: [] }; return result; }
      const b = Model.block(offer, order[i]);
      if (b) { runBlock(b); i++; continue; }
      const r = runGate(Model.gate(offer, order[i]), i);
      if (r && r.stop) { finish(true); return result; }
      i = r && r.jump != null ? r.jump : i + 1;
    }
    finish(false);
    return result;
  }

  window.Simulator = { run: run };
})();
