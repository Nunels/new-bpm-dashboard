/* Exporter Serverless Workflow DSL 1.0.0 (CNCF), YAML. Espressioni runtime in jq. */
(function () {
  const X = Exporters;
  const NS = 'offers';
  const ERR = 'https://example.com/errors/';

  function docName(s) { return X.kebab(s).slice(0, 63).replace(/-+$/, ''); }
  function jqList(arr) { return arr.map(function (p) { return JSON.stringify(p); }).join(', '); }
  /* Filtro "il valore è uno di": jackson-jq (usato da Quarkus Flow) non implementa IN/1, quindi uso confronti espliciti. */
  function jqAnyOf(arr) { return arr.length ? '(' + arr.map(function (p) { return '. == ' + JSON.stringify(p); }).join(' or ') + ')' : 'false'; }

  /* Percorso jq di un campo con i punti ("a.b-c.d"): i segmenti non identificatori usano la forma ["..."]. */
  function jqSeg(seg) { return /^[A-Za-z_]\w*$/.test(seg) ? '.' + seg : '["' + seg.replace(/"/g, '\\"') + '"]'; }
  function jqPath(base, dotted) { return base + String(dotted).split('.').map(jqSeg).join(''); }
  function jqFromDot(dotted) {
    const p = jqPath('', dotted);
    return p.charAt(0) === '.' ? p : '.' + p;
  }
  /* Aggiunge un segmento a un'espressione; senza base (`.` implicito) un nome non identificatore diventa `.["..."]`. */
  function segOf(cur, seg) {
    return cur === '' && !/^[A-Za-z_]\w*$/.test(seg) ? '.["' + seg.replace(/"/g, '\\"') + '"]' : cur + jqSeg(seg);
  }

  /*
   * Percorso con liste. `x[]` percorre tutti gli elementi e il risultato è la lista dei valori (appiattita se ci sono più liste:
   * a[].b[].c = una sola lista); `x[@]` sceglie un elemento con pick(lista) (liste risultati per prodotto). Senza liste è un
   * semplice percorso. `base` vuoto = valore corrente (`.`).
   */
  function pathChain(base, segs, pick) {
    const stages = [];
    let cur = base;
    let lastIsList = false;
    segs.forEach(function (raw, i) {
      const m = /^(.*?)\[(@?)\]$/.exec(raw);
      if (!m) { cur = segOf(cur, raw); lastIsList = false; return; }
      const arr = '(' + segOf(cur, m[1]) + ' // [])';
      if (m[2]) { cur = '(' + pick(arr) + ')'; lastIsList = false; return; }
      stages.push(arr + '[]');
      cur = '';
      lastIsList = i === segs.length - 1;
    });
    if (!stages.length) return cur;
    if (stages.length === 1 && lastIsList) return stages[0].slice(0, -2);
    if (cur !== '') stages.push(cur);
    return '[ ' + stages.join(' | ') + ' ]';
  }
  const noPick = function () { return 'null'; };

  /* Prodotti su cui gira il blocco: nelle liste "un elemento per prodotto" e in `offerta.prodotti`. */
  function blockProducts(a) { return X.perProduct(a) ? '[$product]' : targetsExpr(a); }

  /* Variabili del contesto di un input: prodotto corrente (blocco per prodotto o lista di prodotti) ed elemento corrente di una lista. */
  function blockScope(a) { return { prod: a && X.perProduct(a) ? '$product' : null, item: null, depth: 0 }; }

  /* Espressione jq della sorgente di un input; `a` è l'attività che lo consuma, `scope` le variabili della lista in cui si trova. */
  function inputExpr(plan, i, a, scope) {
    scope = scope || blockScope(a);
    const s = X.source(i.source, plan);
    if (s.kind === 'none') return 'null';
    if (s.kind === 'literal') return JSON.stringify(s.value);
    if (s.kind === 'system') return s.path === 'offerta.prodotti' ? (a ? targetsExpr(a) : '$context.offerProducts') : (scope.prod || 'null');
    if (s.kind === 'item') return scope.item ? pathChain(scope.item, s.path ? s.path.split('.') : [], noPick) : 'null';
    if (s.kind === 'productPath') {
      if (!scope.prod) return 'null';
      return s.path.split('.').reduce(function (cur, seg) { return seg === '{prodotto}' ? cur + '[' + scope.prod + ']' : cur + jqSeg(seg); }, '$workflow.input');
    }
    if (s.kind === 'result') {
      const src = X.findActivity(plan, s.ref);
      const id = src ? src.activityId : s.ref;
      const segs = s.field.split('.');
      const pick = function (arr) {
        const pr = src && src.productResults;
        if (!pr || !scope.prod) return 'null';
        return arr + ' | map(select(' + jqFromDot(pr.productField) + ' == ' + scope.prod + ')) | .[0]';
      };
      if (src && X.perProduct(src) && !/\[@?\]/.test(s.field)) {
        // il produttore ha girato una volta per prodotto: un consumatore "per prodotto" legge il risultato del proprio prodotto, gli altri la lista dei risultati
        const byProduct = '($context.esitiByProduct[' + JSON.stringify(id) + '] // {})';
        if (a && X.perProduct(a)) return jqPath('(' + byProduct + '[$product] // {})', s.field);
        return '[' + byProduct + ' | .[] | ' + jqFromDot(s.field) + ']';
      }
      return pathChain('$context.esiti.' + id, segs, pick);
    }
    return pathChain('$workflow.input', s.path.split('.'), noPick);
  }

  /* ---------------- input con liste ---------------- */
  function parseSegs(name) {
    return String(name).split('.').map(function (s) { return /\[\]$/.test(s) ? { n: s.slice(0, -2), list: true } : { n: s, list: false }; });
  }
  function keyUpTo(segs, i) { return segs.slice(0, i + 1).map(function (s) { return s.n + (s.list ? '[]' : ''); }).join('.'); }
  function inputEntries(a) { return a.input.map(function (i) { return { input: i, segs: parseSegs(i.name) }; }); }

  /* Lista di valori dell'origine di una lista di input (`a[]`): jq che restituisce un array. */
  function originList(plan, a, key, scope) {
    const row = a.input.find(function (x) { return x.name === key; });
    const o = X.source(row ? row.source : '', plan);
    if (o.kind === 'none' || o.kind === 'literal' || o.kind === 'productPath') return '[]';
    if (o.kind === 'system') return o.path === 'offerta.prodotti' ? blockProducts(a) : '[]';
    return inputExpr(plan, { source: row.source }, a, scope);
  }

  /*
   * jq di una lista di input: un elemento per ogni elemento dell'origine (o per ogni prodotto del blocco), con i campi mappati.
   * `entries` = input che stanno nella lista, `pos` = indice del primo segmento dopo `key`.
   */
  function listExpr(plan, a, key, entries, pos, scope) {
    const kids = entries.filter(function (e) { return e.segs.length > pos; });
    const src = originList(plan, a, key, scope);
    if (!kids.length) return src;
    const row = a.input.find(function (x) { return x.name === key; });
    const isProducts = !!row && (function (o) { return o.kind === 'system' && o.path === 'offerta.prodotti'; })(X.source(row.source, plan));
    const v = isProducts ? '$p' : '$item' + scope.depth;
    const inner = { prod: isProducts ? '$p' : scope.prod, item: isProducts ? scope.item : v, depth: scope.depth + 1 };
    return '[ ' + src + '[] as ' + v + ' | ' + objectExpr(plan, a, kids, pos, inner) + ' ]';
  }

  /* Oggetto jq degli elementi di una lista: i campi con lo stesso prefisso si annidano, le sotto-liste si costruiscono a loro volta. */
  function objectExpr(plan, a, entries, pos, scope) {
    const groups = [];
    entries.forEach(function (e) {
      const sg = e.segs[pos];
      let g = groups.find(function (x) { return x.n === sg.n && x.list === sg.list; });
      if (!g) { g = { n: sg.n, list: sg.list, entries: [] }; groups.push(g); }
      g.entries.push(e);
    });
    return '{ ' + groups.map(function (g) {
      let v;
      if (g.list) v = listExpr(plan, a, keyUpTo(g.entries[0].segs, pos), g.entries, pos + 1, scope);
      else if (g.entries.length === 1 && g.entries[0].segs.length === pos + 1) v = inputExpr(plan, g.entries[0].input, a, scope);
      else v = objectExpr(plan, a, g.entries.filter(function (e) { return e.segs.length > pos + 1; }), pos + 1, scope);
      return JSON.stringify(g.n) + ': (' + v + ')';
    }).join(', ') + ' }';
  }

  /* Liste di primo livello degli input: chiave, percorso nel body (senza []) e input che ne fanno parte. */
  function topLists(plan, a) {
    const lists = [];
    inputEntries(a).forEach(function (e) {
      const L = e.segs.findIndex(function (s) { return s.list; });
      if (L < 0) return;
      const key = keyUpTo(e.segs, L);
      let g = lists.find(function (x) { return x.key === key; });
      if (!g) { g = { key: key, path: e.segs.slice(0, L + 1).map(function (s) { return s.n; }).join('.'), pos: L + 1, entries: [] }; lists.push(g); }
      g.entries.push(e);
    });
    return lists;
  }
  function plainInputs(a) { return inputEntries(a).filter(function (e) { return !e.segs.some(function (s) { return s.list; }); }); }

  /* URI dell'endpoint: i segmenti {param} del path diventano un'espressione che li sostituisce con il valore dell'input omonimo. */
  function endpointUri(plan, a) {
    const raw = X.BASE_URL + (a.service.path || '/');
    if (!/\{\w+\}/.test(raw)) return raw;
    const re = /\{(\w+)\}/g, parts = [];
    let last = 0, m;
    while ((m = re.exec(raw))) {
      const inp = a.input.find(function (x) { return x.name === m[1]; });
      parts.push(JSON.stringify(raw.slice(last, m.index)));
      parts.push('((' + (inp ? inputExpr(plan, inp, a) : '$workflow.input.' + m[1]) + ') | tostring | @uri)');
      last = re.lastIndex;
    }
    parts.push(JSON.stringify(raw.slice(last)));
    return '${ ' + parts.join(' + ') + ' }';
  }

  /*
   * Prodotti su cui l'attività va eseguita: i suoi, esclusi quelli già KO o esclusi a monte
   * (nei nodi da cui dipende, anche indirettamente: lo scrive ogni blocco/gate in $context.dead).
   */
  function targetsExpr(a) {
    const base = '[$context.offerProducts[] | select(' + jqAnyOf(a.products) + ')]';
    if (!a.dependsOn.length) return base;
    return '(' + base + ' - (' + deadOf(a.dependsOn) + '))';
  }

  function productsExpr(a) {
    return X.perProduct(a) ? '${ [$product] }' : '${ ' + targetsExpr(a) + ' }';
  }

  /* ---------------- condizioni (when) ---------------- */
  function typeOfLeft(plan, k) {
    if (k.kind === 'outcome') return 'outcome';
    if (k.kind === 'system') return Fields.SYSTEM[k.path].type;
    if (k.kind === 'path') {
      const f = ((plan.practice && plan.practice.fields) || []).find(function (x) { return Fields.plain(x.name) === Fields.plain(k.path); });
      return f ? f.type : 'string';
    }
    const src = X.findActivity(plan, k.ref);
    const o = src && src.output.find(function (x) { return Fields.plain(x.name) === Fields.plain(k.field); });
    return o ? o.type : 'string';
  }

  /* KO del blocco: per il prodotto corrente (blocco "per prodotto"), per uno dei prodotti del blocco, o per qualunque prodotto (gate). */
  function koExpr(plan, ref, a) {
    const src = X.findActivity(plan, ref);
    const list = '($context.koByBlock[' + JSON.stringify(src ? src.activityId : ref) + '] // [])';
    if (!a) return '(' + list + ' | length > 0)';
    return '([' + list + '[] | select(' + (X.perProduct(a) ? '. == $product' : jqAnyOf(a.products)) + ')] | length > 0)';
  }

  function clauseExpr(plan, c, a) {
    const k = Conditions.leftKind(c.left);
    if (k.kind === 'outcome') {
      const ko = koExpr(plan, k.ref, a);
      return (c.op === '==') === (String(c.value).trim() === 'KO') ? ko : '(' + ko + ' | not)';
    }
    const e = inputExpr(plan, { source: c.left }, a);
    const type = typeOfLeft(plan, k);
    const lit = function (v) { return JSON.stringify(Conditions.typed(v, type)); };
    const any = function (op, join, vals) { return vals.length ? '(' + e + ' | (' + vals.map(function (v) { return '. ' + op + ' ' + JSON.stringify(v); }).join(join) + '))' : null; };
    const cmp = { countEq: '==', countNe: '!=', countGt: '>', countGte: '>=', countLt: '<', countLte: '<=' };
    if (cmp[c.op]) return '((' + e + ' | length) ' + cmp[c.op] + ' ' + (Number(c.value) || 0) + ')';
    switch (c.op) {
      case 'anyEq': return '(' + e + ' | any(. == ' + lit(c.value) + '))';
      case 'anyNe': return '(' + e + ' | any(. != ' + lit(c.value) + '))';
      case 'allEq': return '(' + e + ' | all(. == ' + lit(c.value) + '))';
      case 'noneEq': return '(' + e + ' | any(. == ' + lit(c.value) + ') | not)';
      case 'exists': return Conditions.isListLeft(c.left) ? '((' + e + ' | length) > 0)' : '(' + e + ' | (. != null and . != ""))';
      case 'nexists': return Conditions.isListLeft(c.left) ? '((' + e + ' | length) == 0)' : '(' + e + ' | (. == null or . == ""))';
      case '==': case '!=': return '(' + e + ' ' + c.op + ' ' + lit(c.value) + ')';
      case '>': case '>=': case '<': case '<=': return '(' + e + ' | (. != null and . ' + c.op + ' ' + lit(c.value) + '))';
      case 'in': return any('==', ' or ', Conditions.listOf(c.value, type)) || 'false';
      case 'nin': return any('!=', ' and ', Conditions.listOf(c.value, type)) || 'true';
      default: {
        const has = type === 'array'
          ? '([(' + e + ')[]? | select(. == ' + JSON.stringify(String(c.value).trim()) + ')] | length > 0)'
          : '((' + e + ') // "" | tostring | contains(' + JSON.stringify(String(c.value).trim()) + '))';
        return c.op === 'contains' ? has : '(' + has + ' | not)';
      }
    }
  }

  /* Espressione jq (senza ${ }) di una condizione; `a` = attività che la valuta, assente per i gate. */
  function whenExpr(plan, when, a) {
    return '(' + when.clauses.map(function (c) { return clauseExpr(plan, c, a); }).join(when.join === 'OR' ? ' or ' : ' and ') + ')';
  }

  /* Radici dell'input originale lette dalle condizioni (servono ai sotto-workflow "non attesi"). */
  function whenRoots(when, into) {
    if (!when) return;
    when.clauses.forEach(function (c) { const k = Conditions.leftKind(c.left); if (k.kind === 'path') into[k.path.split('.')[0].replace(/\[\]$/, '')] = true; });
  }

  /* Il body costruisce le liste con jq (un elemento per prodotto o per elemento della lista d'origine); gli altri input restano valori singoli. */
  function bodyOf(plan, a) {
    const b = {};
    plainInputs(a).forEach(function (e) {
      const i = e.input;
      const s = X.source(i.source, plan);
      Fields.setPath(b, i.name, s.kind === 'none' ? null : s.kind === 'literal' ? s.value : '${ ' + inputExpr(plan, i, a) + ' }');
    });
    topLists(plan, a).forEach(function (g) {
      Fields.setPath(b, g.path, '${ ' + listExpr(plan, a, g.key, g.entries, g.pos, blockScope(a)) + ' }');
    });
    b.products = productsExpr(a);
    return b;
  }

  /* Query string di una GET: gli input non già usati come parametri del path, più i prodotti. Le liste vanno in JSON. */
  function queryOf(plan, a) {
    const used = {};
    (a.service.path || '').replace(/\{(\w+)\}/g, function (_, n) { used[n] = true; return ''; });
    const q = {};
    plainInputs(a).forEach(function (e) {
      const i = e.input;
      if (used[i.name]) return;
      const s = X.source(i.source, plan);
      if (s.kind === 'none') return;
      q[i.name] = s.kind === 'literal' ? s.value : '${ ' + inputExpr(plan, i, a) + ' }';
    });
    topLists(plan, a).forEach(function (g) { q[g.path] = '${ ' + listExpr(plan, a, g.key, g.entries, g.pos, blockScope(a)) + ' | tojson }'; });
    q.products = X.perProduct(a) ? '${ $product }' : '${ ' + targetsExpr(a) + ' | join(",") }';
    return q;
  }

  /*
   * Task con lista risultati per prodotto: l'esito di ogni prodotto si ricava dalla lista della risposta
   * (valori "ok" → OK, "koTask" → KO_TASK, tutti gli altri → KO), così il servizio non deve costruire productOutcomes.
   */
  function outcomesExpr(a) {
    const pr = a.productResults;
    const eq = function (vals) { return vals.length ? '(' + vals.map(function (v) { return jqFromDot(pr.outcomeField) + ' == ' + JSON.stringify(v); }).join(' or ') + ')' : 'false'; };
    const kt = (pr.koTask || []).length ? ' elif ' + eq(pr.koTask) + ' then "KO_TASK"' : '';
    return '[ (' + jqFromDot(pr.list) + ' // [])[] | { key: (' + jqFromDot(pr.productField) + ' | tostring), value: (if ' + eq(pr.ok || []) + ' then "OK"' + kt + ' else "KO" end) } ] | from_entries';
  }
  /* output.as di un task: aggiunge productOutcomes (se il task dichiara la lista per prodotto) a `base` (l'output grezzo, "." di default). */
  function outputAs(a, base) {
    base = base || '.';
    if (!a.productResults) return base === '.' ? null : '${ ' + base + ' }';
    return '${ (' + base + ' // {}) | if (' + jqFromDot(a.productResults.list) + ' == null) then . else (. + { productOutcomes: (' + outcomesExpr(a) + ') }) end }';
  }

  /*
   * Salva l'esito nel contesto e accumula i prodotti KO (letti dal gate e dai blocchi dipendenti). In export.as l'output del task è $output.
   * Per i blocchi "una chiamata per prodotto" l'esito è anche in esitiByProduct[blocco][prodotto], perché esiti[blocco] conserva solo l'ultimo.
   */
  function exportResult(a) {
    const ko = '[($output.productOutcomes // {}) | to_entries[] | select(.value == "KO") | .key]';
    const byProduct = X.perProduct(a)
      ? ', esitiByProduct: (($context.esitiByProduct // {}) + { "' + a.activityId + '": (($context.esitiByProduct["' + a.activityId + '"] // {}) + { ($product): $output }) })'
      : '';
    return {
      as: '${ $context + { esiti: (($context.esiti // {}) + { "' + a.activityId + '": $output }), koByBlock: (($context.koByBlock // {}) + { "' + a.activityId + '": ((($context.koByBlock["' + a.activityId + '"] // []) + ' + ko + ') | unique) })' + byProduct + ' } }'
    };
  }

  /* Metadata: annotazioni leggibili dell'offerta, dei blocchi e delle barre (il DSL non viene riletto dalla dashboard). */
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
      m.block = { id: b.id, taskId: b.taskId, products: b.products.slice(), dependsOn: b.dependsOn.slice(), config: config };
    }
    return m;
  }

  function gateMeta(plan, g) {
    const src = plan.source && plan.source.offer;
    const m = { description: g.effectivePolicy.description.join(' · '), gateId: g.gateId, kind: g.kind, dependsOn: g.dependsOn.join(',') };
    const sg = src && src.gates.find(function (x) { return x.id === g.gateId; });
    if (sg) m.gate = { id: sg.id, dependsOn: sg.dependsOn.slice(), note: sg.note || '', rules: sg.rules };
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

  /* Prodotti già KO o esclusi a monte di un nodo: unione di quelli registrati nei nodi da cui dipende (jq, senza ${ }). */
  function deadOf(ids) {
    return ids.length ? ids.map(function (d) { return '($context.dead[' + JSON.stringify(d) + '] // [])'; }).join(' + ') : '[]';
  }
  /* Prodotti KO/esclusi dopo un blocco: quelli a monte più i propri KO. Si scrive sempre, anche se il blocco è saltato. */
  function deadSettle(a) {
    return '((' + deadOf(a.dependsOn) + ') + (($context.koByBlock // {})[' + JSON.stringify(a.activityId) + '] // [])) | unique';
  }
  function setDead(id, expr) {
    return '${ $context + { dead: (($context.dead // {}) + { ' + JSON.stringify(id) + ': ' + expr + ' }) } }';
  }

  function unit(plan, a) {
    const k = X.kebab(a.activityId);
    const method = (a.service.method || 'POST').toLowerCase();
    const call = { call: 'http', with: { method: method, endpoint: { uri: endpointUri(plan, a) } } };
    if (method === 'get') call.with.query = queryOf(plan, a);
    else call.with.body = bodyOf(plan, a);
    if (!X.isAsync(a)) {
      call.export = exportResult(a);
      const oa = outputAs(a);
      if (oa) call.output = { as: oa };
    }
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
        output: { as: outputAs(a, '.[0]') || '${ .[0] }' },
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
    const cond = a.when ? '${ ' + whenExpr(plan, a.when, a) + ' }' : null;
    let run;
    if (X.perProduct(a)) {
      // la condizione si valuta per prodotto, dentro il for (è lì che esiste $product); con nessun prodotto il for non gira
      const body = cond ? [{ [k + '-when']: { if: cond, do: steps } }] : steps;
      run = { for: { each: 'product', in: '${ ' + targetsExpr(a) + ' }' }, do: body };
    } else {
      // una chiamata per N prodotti: parte solo se resta almeno un prodotto (e se la condizione è vera)
      run = { if: '${ ((' + targetsExpr(a) + ') | length) > 0' + (a.when ? ' and ' + whenExpr(plan, a.when, a) : '') + ' }', do: steps };
    }
    // il blocco registra sempre i prodotti KO/esclusi (anche se è stato saltato), così i nodi successivi li ereditano
    const item = {};
    item[k] = {
      do: [{ [k + '-run']: run }, { [k + '-settle']: { set: { dead: '${ ' + deadSettle(a) + ' }' }, export: { as: setDead(a.activityId, '$output.dead') } } }],
      metadata: blockMeta(plan, a)
    };
    return item;
  }

  function document(plan, name, title, summary) {
    return { dsl: '1.0.0', namespace: NS, name: name, version: '1.0.0', title: title, summary: summary };
  }

  function initTask(products) {
    return { 'init-offer': { set: { offerProducts: products, dead: {}, koByBlock: {}, esiti: {}, esitiByProduct: {} }, export: { as: '${ $output }' } } };
  }

  /* Schema dell'input generale: dal modello della pratica; senza campi resta il vecchio schema pratica + cliente. pratica.id c'è sempre (correlazione degli eventi). */
  function inputSchema(plan) {
    const fields = plan.practice && plan.practice.fields || [];
    if (!fields.length) return { type: 'object', required: ['pratica', 'cliente'], properties: { pratica: { type: 'object' }, cliente: { type: 'object' } } };
    const all = fields.some(function (f) { return f.name === 'pratica.id'; }) ? fields : [{ name: 'pratica.id', type: 'string', required: true }].concat(fields);
    return Fields.toSchema(all.map(function (f) { return f.name === 'pratica.id' ? Object.assign({}, f, { required: true }) : f; }));
  }

  /* ---------------- gate e instradamenti (ROUTE) ---------------- */
  function loopCount(key) { return '(($context.loops // {})[' + JSON.stringify(key) + '] // 0)'; }
  function routeMeta(list, description) {
    return { description: description, routes: list.map(function (r) { return { gate: r.gateId, text: r.rule.when.text + ' → ' + r.rule.to }; }) };
  }
  function stopRaise(title) { return { error: { type: ERR + 'offer-stopped', status: 409, title: title } }; }
  function dropKeys(field, ids) {
    const keep = ids.map(function (id) { return '.key != ' + JSON.stringify(id); }).join(' and ') || 'true';
    return field + ': ((($context.' + field + ' // {}) | to_entries | map(select(' + keep + ')) | from_entries))';
  }

  /* Regole ROUTE di un gate del piano, con la chiave del contatore di cicli (gate + posizione della regola). */
  function routesOf(g) {
    const r = [];
    g.rules.forEach(function (rule, i) { if (rule.type === 'ROUTE') r.push({ key: g.gateId + '-' + i, gateId: g.gateId, rule: rule }); });
    return r;
  }

  /* Ripartisce le regole ROUTE di un gate: ritorni/stop prima delle regole KO, salti dopo; nei rami paralleli restano solo gli stop. */
  function routeParts(plan, g) {
    const topIdx = plan.top.indexOf(g.gateId);
    const isTop = topIdx >= 0;
    const parts = { isTop: isTop, early: [], forward: [], stops: [] };
    routesOf(g).forEach(function (r) {
      if (r.rule.to === 'STOP') { (isTop ? parts.early : parts.stops).push(r); return; }
      const di = plan.top.indexOf(r.rule.to);
      if (!isTop || di < 0) return;
      (di <= topIdx ? parts.early : parts.forward).push(r);
    });
    return parts;
  }

  /* Nome del primo task generato per un nodo: serve come destinazione dei ritorni e dei salti. */
  function entryName(plan, id) {
    const g = plan.gates.find(function (x) { return x.gateId === id; });
    if (!g) return X.kebab(id);
    const p = routeParts(plan, g);
    const s = X.kebab(g.gateId);
    if (p.early.length) return 'gate-' + s + '-route';
    if (g.effectivePolicy.stopOnKo) return 'gate-' + s + '-stop';
    if (p.stops.length) return 'gate-' + s + '-stop-route-1';
    return 'gate-' + s + '-apply';
  }

  /* Task di ritorno: conta il giro, azzera KO ed esiti dei nodi che verranno rieseguiti e torna al nodo di destinazione. */
  function loopTask(plan, r) {
    const ids = plan.order.slice(plan.order.indexOf(r.rule.to), plan.order.indexOf(r.gateId) + 1);
    const loops = '($context.loops // {})';
    return {
      set: { routedTo: r.rule.to },
      export: { as: '${ $context + { loops: (' + loops + ' + { ' + JSON.stringify(r.key) + ': (' + loopCount(r.key) + ' + 1) }), ' + dropKeys('dead', ids) + ', ' + dropKeys('koByBlock', ids) + ' } }' },
      then: entryName(plan, r.rule.to),
      metadata: { description: 'Ritorno a ' + r.rule.to + ' (giro ' + r.key + ', al massimo ' + r.rule.maxIterations + ')' }
    };
  }

  /* Task di salto avanti: i nodi saltati lasciano passare i prodotti che il gate ha lasciato passare. */
  function skipTask(plan, r) {
    const ids = plan.order.slice(plan.order.indexOf(r.gateId) + 1, plan.order.indexOf(r.rule.to));
    const pass = ids.map(function (id) { return JSON.stringify(id) + ': ($context.dead[' + JSON.stringify(r.gateId) + '] // [])'; }).join(', ');
    return {
      set: { skippedTo: r.rule.to },
      export: { as: '${ $context + { dead: (($context.dead // {}) + { ' + pass + ' }) } }' },
      then: entryName(plan, r.rule.to),
      metadata: { description: 'Salto a ' + r.rule.to + ' (nodi saltati: ' + (ids.join(', ') || 'nessuno') + ')' }
    };
  }

  /* Task di un gate: ritorni/stop → stop su KO → registrazione dei prodotti che passano → salti. Stesso `do` del ramo a cui appartiene. */
  function gateTasks(plan, g, env) {
    const s = X.kebab(g.gateId);
    const pol = g.effectivePolicy;
    const p = routeParts(plan, g);
    const deadIn = deadOf(g.dependsOn);
    const tasks = [];
    if (p.early.length) {
      const rc = [];
      p.early.forEach(function (r, n) {
        const cond = whenExpr(plan, r.rule.when, null);
        const name = 'route-' + (n + 1);
        if (r.rule.to === 'STOP') { rc.push({ [name]: { when: '${ ' + cond + ' }', then: 'offer-stopped' } }); env.needStop = true; return; }
        const go = 'gate-' + s + '-go-' + (n + 1);
        rc.push({ [name]: { when: '${ ' + cond + ' and ' + loopCount(r.key) + ' < ' + r.rule.maxIterations + ' }', then: go } });
        if (r.rule.onExceed === 'STOP') { rc.push({ [name + '-exceeded']: { when: '${ ' + cond + ' }', then: 'offer-stopped' } }); env.needStop = true; }
        env.goTasks.push({ [go]: loopTask(plan, r) });
      });
      rc.push({ proceed: { then: 'continue' } });
      tasks.push({ ['gate-' + s + '-route']: { switch: rc, metadata: routeMeta(p.early, 'Instradamenti prima delle regole del gate (ritorno indietro / stop)') } });
    }
    if (pol.stopOnKo) {
      const sc = pol.stopOnKo === 'ALL' ? 'true' : jqAnyOf(pol.stopOnKo);
      tasks.push({ ['gate-' + s + '-stop']: { if: '${ ([ (' + deadIn + ')[] | select(' + sc + ') ] | length) > 0 }', raise: stopRaise('Offerta fermata da un gate (KO)') } });
    }
    p.stops.forEach(function (r, n) {
      tasks.push({ ['gate-' + s + '-stop-route-' + (n + 1)]: { if: '${ ' + whenExpr(plan, r.rule.when, null) + ' }', raise: stopRaise('Offerta fermata da un instradamento del gate') } });
    });
    tasks.push({
      ['gate-' + s + '-apply']: {
        set: { dead: pol.koProducts === 'CONTINUE' ? [] : '${ (' + deadIn + ') | unique }' },
        export: { as: setDead(g.gateId, '$output.dead') },
        metadata: gateMeta(plan, g)
      }
    });
    if (p.forward.length) {
      const fc = p.forward.map(function (r, n) {
        return { ['route-' + (n + 1)]: { when: '${ ' + whenExpr(plan, r.rule.when, null) + ' }', then: 'gate-' + s + '-skip-go-' + (n + 1) } };
      });
      fc.push({ proceed: { then: 'continue' } });
      tasks.push({ ['gate-' + s + '-skip']: { switch: fc, metadata: routeMeta(p.forward, 'Salti in avanti dopo le regole del gate') } });
      p.forward.forEach(function (r, n) { env.goTasks.push({ ['gate-' + s + '-skip-go-' + (n + 1)]: skipTask(plan, r) }); });
    }
    return tasks;
  }

  /* Blocco "non atteso": parte in un sotto-workflow autonomo (await: false) e il gate non lo aspetta. */
  function detachedTask(plan, a, name, subflows) {
    const sub = docName(name + '-' + a.activityId);
    // il ramo "non atteso" ricostruisce il proprio contesto dall'input: prodotti, nodi già eseguiti ed esiti raccolti
    subflows.push({
      document: document(plan, sub, a.taskName + ' (non atteso)', 'Eseguito senza attesa dal gate'),
      do: [{ 'init-branch': { set: { offerProducts: '${ $workflow.input.offerProducts }', dead: '${ $workflow.input.dead // {} }', koByBlock: '${ $workflow.input.koByBlock // {} }', esiti: '${ $workflow.input.esiti // {} }', esitiByProduct: '${ $workflow.input.esitiByProduct // {} }' }, export: { as: '${ $output }' } } }, unit(plan, a)]
    });
    const t = {};
    // lo schema vuole un oggetto: passo le radici dell'input originale (modello della pratica) più prodotti, esclusioni ed esiti già raccolti
    const roots = { pratica: true };
    ((plan.practice && plan.practice.roots) || []).forEach(function (r) { roots[r] = true; });
    if (!plan.practice || !plan.practice.roots.length) roots.cliente = true;
    a.input.forEach(function (i) { const sr = X.source(i.source, plan); if (sr.kind === 'path' || sr.kind === 'productPath') roots[sr.path.split('.')[0].replace(/\[\]$/, '')] = true; });
    whenRoots(a.when, roots);
    const subInput = { offerProducts: '${ $context.offerProducts }', dead: '${ $context.dead }', koByBlock: '${ $context.koByBlock }', esiti: '${ $context.esiti }', esitiByProduct: '${ $context.esitiByProduct }' };
    Object.keys(roots).forEach(function (r) { subInput[r] = '${ $workflow.input.' + r + ' }'; });
    t['start-' + X.kebab(a.activityId)] = { run: { workflow: { namespace: NS, name: sub, version: '1.0.0', input: subInput }, await: false }, metadata: blockMeta(plan, a, true) };
    return t;
  }

  function build(plan) {
    const name = docName('offer-' + plan.offer.id);
    if (!plan.flow && (plan.activities.length || plan.gates.length)) throw new Error('Il grafo dell\'offerta non è valido (dipendenze circolari o rami che si incrociano): correggi gli errori di validazione.');
    const subflows = [];
    const doList = [initTask(plan.products.map(function (p) { return p.id; }))];
    const env = { goTasks: [], needStop: false };
    const acts = {}, gates = {};
    plan.activities.forEach(function (a) { acts[a.activityId] = a; });
    plan.gates.forEach(function (g) { gates[g.gateId] = g; });
    const detached = X.detachedIds(plan);
    let forkN = 0, branchN = 0;

    /* Sequenza = task in fila nello stesso `do`; rami paralleli = `fork` (ogni ramo è un task o un `do` di task). */
    const tasksOf = function (n) {
      if (n.type === 'node') {
        if (n.kind === 'gate') return gateTasks(plan, gates[n.id], env);
        return [detached.indexOf(n.id) >= 0 ? detachedTask(plan, acts[n.id], name, subflows) : unit(plan, acts[n.id])];
      }
      if (n.type === 'seq') return [].concat.apply([], n.items.map(tasksOf));
      const f = {};
      f['fork-' + (++forkN)] = { fork: { branches: n.items.map(branchOf), compete: false } };
      return [f];
    };
    const branchOf = function (n) {
      const ts = tasksOf(n);
      if (ts.length === 1) return ts[0];
      const w = {};
      w['branch-' + (++branchN)] = { do: ts };
      return w;
    };
    if (plan.flow) tasksOf(plan.flow).forEach(function (t) { doList.push(t); });

    // a fine flusso restano i prodotti non KO nei nodi finali
    const dependedOn = {};
    plan.activities.forEach(function (a) { a.dependsOn.forEach(function (d) { dependedOn[d] = true; }); });
    plan.gates.forEach(function (g) { g.dependsOn.forEach(function (d) { dependedOn[d] = true; }); });
    const surv = '($context.offerProducts - (' + deadOf(plan.order.filter(function (id) { return !dependedOn[id]; })) + '))';
    doList.push({ 'offer-completed': { set: { activeProducts: '${ ' + surv + ' }', status: '${ if (' + surv + ' | length) > 0 then "COMPLETED" else "NO_PRODUCTS" end }' }, then: 'end' } });
    if (env.needStop) doList.push({ 'offer-stopped': { raise: { error: { type: ERR + 'offer-stopped', status: 409, title: 'Offerta fermata da un instradamento (STOP)' } } } });
    // destinazioni dei ritorni e dei salti: in fondo al do, mai raggiunte in sequenza (offer-completed termina, offer-stopped solleva)
    env.goTasks.forEach(function (t) { doList.push(t); });

    const main = {
      document: document(plan, name, plan.offer.name, (plan.offer.description || '') + ' — generato da BPM AI Offer Designer'),
      input: { schema: { format: 'json', document: inputSchema(plan) } },
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
      'Sequenza = task in fila nello stesso "do"; rami paralleli = "fork" (anche annidati); "1 chiamata per prodotto" = "for" sui prodotti ancora in corsa. Solo grafi serie/parallelo: i rami che si incrociano non sono esprimibili e la validazione li segnala.',
      'Attività = "call: http" verso ' + X.BASE_URL + ' + path; retry = try/catch con retry policy.',
      'Task asincroni = "listen" sull\'evento (type = topic di callback) correlato su pratica.id; output.as ${ .[0] } prende l\'evento (il listen restituisce l\'array degli eventi consumati).',
      '"KO con task" = emit "manual-task.requested" + listen "manual-task.completed" (solo se esito KO_TASK).',
      'Gate = task nel ramo a cui appartengono: "switch" per ritorni/salti (solo nella sequenza principale: un "then" non esce da un "fork"), "raise" con "if" per gli STOP, "set" che registra in $context.dead[nodo] i prodotti KO/esclusi (ereditati dai nodi che ne dipendono, anche se saltati).',
      '"Non attendere" = "run: workflow" con await: false verso un sotto-workflow generato in un file separato. ATTENZIONE: Quarkus Flow 1.3.0 non rispetta await: false (attende comunque il sotto-workflow); in quel runtime serve un\'attività Java o un evento con broker (provato in quarkus-flow-sim).',
      'Verifica automatica: validazione di schema DSL 1.0 e valutazione delle espressioni jq con jackson-jq nei test. Il formato a step precedente era stato provato su Quarkus Flow 1.3.0 (quarkus-flow-sim/README.md); il formato a grafo non è stato eseguito su alcun runtime. Il runtime usa jackson-jq (non tutto jq: niente IN/1, quindi il generatore usa confronti espliciti) e in export.as l\'output del task si legge con $output, non con "."; il generatore lo rispetta.'
    ],
    files: function (plan) {
      const r = build(plan);
      return [{ name: r.main.document.name + '.sw.yaml', mime: 'application/yaml', content: X.toYaml(r.main) }]
        .concat(r.subflows.map(function (s) { return { name: s.document.name + '.sw.yaml', mime: 'application/yaml', content: X.toYaml(s) }; }));
    }
  });
})();
