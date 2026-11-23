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
    if (s.kind === 'system') return s.path === 'offerta.prodotti' ? (a ? targetsExpr(a) : '$context.activeProducts') : (scope.prod || 'null');
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
      as: '${ $context + { esiti: (($context.esiti // {}) + { "' + a.activityId + '": $output }), koProducts: ((($context.koProducts // []) + ' + ko + ') | unique), koByBlock: (($context.koByBlock // {}) + { "' + a.activityId + '": ((($context.koByBlock["' + a.activityId + '"] // []) + ' + ko + ') | unique) })' + byProduct + ' } }'
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
    const item = {};
    const cond = a.when ? '${ ' + whenExpr(plan, a.when, a) + ' }' : null;
    if (X.perProduct(a)) {
      // la condizione si valuta per prodotto, dentro il for (è lì che esiste $product)
      const body = cond ? [{ [k + '-when']: { if: cond, do: steps } }] : steps;
      item[k] = { for: { each: 'product', in: '${ ' + targetsExpr(a) + ' }' }, do: body };
    } else {
      item[k] = { do: steps };
      if (cond) item[k].if = cond;
    }
    item[k].metadata = blockMeta(plan, a);
    return item;
  }

  function document(plan, name, title, summary) {
    return { dsl: '1.0.0', namespace: NS, name: name, version: '1.0.0', title: title, summary: summary };
  }

  function initTask(products) {
    return { 'init-offer': { set: { activeProducts: products, koProducts: [], esiti: {}, esitiByProduct: {} }, export: { as: '${ $output }' } } };
  }

  /* Schema dell'input generale: dal modello della pratica; senza campi resta il vecchio schema pratica + cliente. pratica.id c'è sempre (correlazione degli eventi). */
  function inputSchema(plan) {
    const fields = plan.practice && plan.practice.fields || [];
    if (!fields.length) return { type: 'object', required: ['pratica', 'cliente'], properties: { pratica: { type: 'object' }, cliente: { type: 'object' } } };
    const all = fields.some(function (f) { return f.name === 'pratica.id'; }) ? fields : [{ name: 'pratica.id', type: 'string', required: true }].concat(fields);
    return Fields.toSchema(all.map(function (f) { return f.name === 'pratica.id' ? Object.assign({}, f, { required: true }) : f; }));
  }

  /* ---------------- instradamento dei gate (ROUTE) ---------------- */
  /* Regole ROUTE di uno step del piano, con la chiave del contatore di cicli (gate + posizione della regola). */
  function routesOf(plan, st) {
    const r = [];
    st.exitGate.gates.forEach(function (g) {
      g.rules.forEach(function (rule, i) { if (rule.type === 'ROUTE') r.push({ key: g.gateId + '-' + i, gateId: g.gateId, rule: rule }); });
    });
    return r;
  }
  function destIndex(plan, stepId) { return plan.steps.findIndex(function (x) { return x.stepId === stepId; }); }
  function loopCount(key) { return '(($context.loops // {})[' + JSON.stringify(key) + '] // 0)'; }
  function routeMeta(list, description) {
    return { description: description, routes: list.map(function (r) { return { gate: r.gateId, text: r.rule.when.text + ' → ' + r.rule.to }; }) };
  }

  /* Task di ritorno: conta il giro, azzera KO e esiti-KO dei blocchi che verranno rieseguiti e salta allo step di destinazione. */
  function loopTask(plan, r, fromIdx) {
    const to = destIndex(plan, r.rule.to);
    const ids = [];
    plan.steps.forEach(function (st, i) {
      if (i >= to && i <= fromIdx) st.stages.forEach(function (stg) { stg.activities.forEach(function (a) { ids.push(a.activityId); }); });
    });
    const keep = ids.map(function (id) { return '.key != ' + JSON.stringify(id); }).join(' and ') || 'true';
    const loops = '($context.loops // {})';
    return {
      set: { routedTo: r.rule.to },
      export: { as: '${ $context + { loops: (' + loops + ' + { ' + JSON.stringify(r.key) + ': (' + loopCount(r.key) + ' + 1) }), koProducts: [], koByBlock: (($context.koByBlock // {}) | to_entries | map(select(' + keep + ')) | from_entries) } }' },
      then: 'step-' + X.kebab(r.rule.to),
      metadata: { description: 'Ritorno a ' + r.rule.to + ' (giro ' + r.key + ', al massimo ' + r.rule.maxIterations + ')' }
    };
  }

  function build(plan) {
    const name = docName('offer-' + plan.offer.id);
    const subflows = [];
    const doList = [initTask(plan.products.map(function (p) { return p.id; }))];
    const goTasks = [];
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
          do: [{ 'init-branch': { set: { activeProducts: '${ $workflow.input.activeProducts }', koProducts: [], esiti: '${ $workflow.input.esiti // {} }', esitiByProduct: '${ $workflow.input.esitiByProduct // {} }' }, export: { as: '${ $output }' } } }, unit(plan, a)]
        });
        const t = {};
        // lo schema vuole un oggetto: passo le radici dell'input originale (modello della pratica) più prodotti attivi ed esiti già raccolti
        const roots = { pratica: true };
        ((plan.practice && plan.practice.roots) || []).forEach(function (r) { roots[r] = true; });
        if (!plan.practice || !plan.practice.roots.length) roots.cliente = true;
        a.input.forEach(function (i) { const sr = X.source(i.source, plan); if (sr.kind === 'path' || sr.kind === 'productPath') roots[sr.path.split('.')[0].replace(/\[\]$/, '')] = true; });
        whenRoots(a.when, roots);
        const subInput = { activeProducts: '${ $context.activeProducts }', esiti: '${ $context.esiti }', esitiByProduct: '${ $context.esitiByProduct }' };
        Object.keys(roots).forEach(function (r) { subInput[r] = '${ $workflow.input.' + r + ' }'; });
        t['start-' + X.kebab(a.activityId)] = { run: { workflow: { namespace: NS, name: sub, version: '1.0.0', input: subInput }, await: false }, metadata: blockMeta(plan, a, true) };
        tasks.push(t);
      });
      /* Rami: ogni componente di dipendenze è una catena (o un albero) indipendente, in parallelo alle altre. Un join forza l'attesa a livelli. */
      const stepName = function (suffix) { return s + '-' + suffix; };
      const seqOfNode = function (node) {
        const out = [unit(plan, node.ref)];
        if (node.children.length === 1) return out.concat(seqOfNode(node.children[0]));
        if (node.children.length > 1) {
          const f = {};
          f[stepName('fork-' + X.kebab(node.ref.activityId))] = { fork: { branches: node.children.map(branchOf), compete: false } };
          out.push(f);
        }
        return out;
      };
      const branchOf = function (node) {
        const seq = seqOfNode(node);
        if (seq.length === 1) return seq[0];
        const t = {};
        t[stepName('branch-' + X.kebab(node.ref.activityId))] = { do: seq };
        return t;
      };
      const componentOf = function (comp, n) {
        if (comp.kind === 'tree') return branchOf(comp.root);
        const seq = [];
        comp.levels.forEach(function (lv, j) {
          if (lv.length === 1) { seq.push(unit(plan, lv[0])); return; }
          const f = {};
          f[stepName('group-' + n + '-stage-' + (j + 1))] = { fork: { branches: lv.map(function (a) { return unit(plan, a); }), compete: false } };
          seq.push(f);
        });
        if (seq.length === 1) return seq[0];
        const t = {};
        t[stepName('group-' + n)] = { do: seq };
        return t;
      };
      if (sp.branches.length === 1) {
        const c = sp.branches[0];
        if (c.kind === 'tree') seqOfNode(c.root).forEach(function (t) { tasks.push(t); });
        else { const t = componentOf(c, 1); const nm = Object.keys(t)[0]; if (t[nm].do && nm === stepName('group-1')) t[nm].do.forEach(function (x) { tasks.push(x); }); else tasks.push(t); }
      } else if (sp.branches.length > 1) {
        const f = {};
        f[stepName('branches')] = { fork: { branches: sp.branches.map(function (c, i) { return componentOf(c, i + 1); }), compete: false } };
        tasks.push(f);
      }
      if (tasks.length) { const step = {}; step['step-' + s] = { do: tasks, metadata: { step: st.name } }; doList.push(step); }
      if (st.exitGate) {
        const pol = st.exitGate.effectivePolicy;
        const remaining = pol.koProducts === 'CONTINUE' ? '$context.activeProducts' : '($context.activeProducts - $context.koProducts)';
        const routes = routesOf(plan, st);
        const stepIdx = plan.steps.indexOf(st);
        const early = routes.filter(function (r) { return r.rule.to === 'STOP' || destIndex(plan, r.rule.to) <= stepIdx; });
        const forward = routes.filter(function (r) { return early.indexOf(r) < 0; });
        if (early.length) {
          // prima della politica KO del gate: un ritorno indietro riesegue anche i prodotti KO (che sono ancora tra gli activeProducts)
          const rc = [];
          early.forEach(function (r, n) {
            const cond = whenExpr(plan, r.rule.when, null);
            const name = 'route-' + (n + 1);
            if (r.rule.to === 'STOP') { rc.push({ [name]: { when: '${ ' + cond + ' }', then: 'offer-stopped' } }); needStop = true; return; }
            const go = 'gate-' + s + '-go-' + (n + 1);
            rc.push({ [name]: { when: '${ ' + cond + ' and ' + loopCount(r.key) + ' < ' + r.rule.maxIterations + ' }', then: go } });
            if (r.rule.onExceed === 'STOP') { rc.push({ [name + '-exceeded']: { when: '${ ' + cond + ' }', then: 'offer-stopped' } }); needStop = true; }
            goTasks.push({ [go]: loopTask(plan, r, stepIdx) });
          });
          rc.push({ proceed: { then: 'continue' } });
          const rg = {};
          rg['gate-' + s + '-route'] = { switch: rc, metadata: routeMeta(early, 'Instradamenti prima delle regole del gate (ritorno indietro / stop)') };
          doList.push(rg);
        }
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
        if (forward.length) {
          // dopo la politica KO: il salto in avanti vale per i prodotti che hanno superato il gate
          const fc = forward.map(function (r, n) {
            return { ['route-' + (n + 1)]: { when: '${ ' + whenExpr(plan, r.rule.when, null) + ' }', then: 'step-' + X.kebab(r.rule.to) } };
          });
          fc.push({ proceed: { then: 'continue' } });
          const fg = {};
          fg['gate-' + s + '-skip'] = { switch: fc, metadata: routeMeta(forward, 'Salti in avanti dopo le regole del gate') };
          doList.push(fg);
        }
      }
    });
    doList.push({ 'offer-completed': { set: { status: 'COMPLETED', activeProducts: '${ $context.activeProducts }' }, then: 'end' } });
    doList.push({ 'offer-no-products': { set: { status: 'NO_PRODUCTS' }, then: 'end' } });
    if (needStop) doList.push({ 'offer-stopped': { raise: { error: { type: ERR + 'offer-stopped', status: 409, title: 'Offerta fermata da una barra regole (KO)' } } } });
    // destinazioni dei ritorni indietro: in fondo al do, mai raggiunte in sequenza (offer-completed/offer-no-products terminano, offer-stopped solleva)
    goTasks.forEach(function (t) { doList.push(t); });

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
