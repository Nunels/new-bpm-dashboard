/*
 * Condizioni strutturate (when) di blocchi e regole di instradamento dei gate.
 *
 * Una condizione è { join: 'AND'|'OR', clauses: [{ left, op, value }] }. `left` è un riferimento:
 *   - percorso della pratica            (es. modulo.causale)
 *   - output di un blocco già eseguito  (es. esiti.CRIBIS.score)
 *   - esito di un blocco                (es. esito.B_CRIBIS, valori OK | KO)
 *   - sorgente di sistema               (offerta.prodotti, prodotto.id)
 * Non c'è testo libero: la stessa struttura viene valutata dal simulatore e tradotta in jq dall'exporter,
 * quindi le due strade restano equivalenti per costruzione.
 */
(function (global) {
  const OPS = {
    '==': { label: 'è uguale a', neg: '!=' },
    '!=': { label: 'è diverso da', neg: '==' },
    '>': { label: '>', neg: '<=', ordered: true },
    '>=': { label: '≥', neg: '<', ordered: true },
    '<': { label: '<', neg: '>=', ordered: true },
    '<=': { label: '≤', neg: '>', ordered: true },
    'in': { label: 'è uno tra', neg: 'nin', list: true },
    'nin': { label: 'non è uno tra', neg: 'in', list: true },
    'contains': { label: 'contiene', neg: 'ncontains' },
    'ncontains': { label: 'non contiene', neg: 'contains' },
    'exists': { label: 'è valorizzato', neg: 'nexists', unary: true },
    'nexists': { label: 'non è valorizzato', neg: 'exists', unary: true },
    // operatori sulle liste (riferimenti con [])
    'anyEq': { label: 'almeno uno è uguale a', neg: 'noneEq', onList: true },
    'anyNe': { label: 'almeno uno è diverso da', neg: 'allEq', onList: true },
    'allEq': { label: 'tutti sono uguali a', neg: 'anyNe', onList: true },
    'noneEq': { label: 'nessuno è uguale a', neg: 'anyEq', onList: true },
    'countEq': { label: 'numero elementi =', neg: 'countNe', count: true, onList: true },
    'countNe': { label: 'numero elementi ≠', neg: 'countEq', count: true, onList: true },
    'countGt': { label: 'numero elementi >', neg: 'countLte', count: true, onList: true },
    'countGte': { label: 'numero elementi ≥', neg: 'countLt', count: true, onList: true },
    'countLt': { label: 'numero elementi <', neg: 'countGte', count: true, onList: true },
    'countLte': { label: 'numero elementi ≤', neg: 'countGt', count: true, onList: true }
  };
  const OUTCOME_VALUES = ['OK', 'KO'];
  const OUTCOME_RE = /^esito\.([A-Za-z0-9_]+)$/;
  const PATH_RE = /^[A-Za-z_]\w*(?:\[\])?(?:\.\w+(?:\[\])?)*$/;

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function isActive(when) { return !!when && Array.isArray(when.clauses) && when.clauses.length > 0; }
  function emptyWhen() { return { join: 'AND', clauses: [] }; }
  function emptyClause() { return { left: '', op: '==', value: '' }; }
  function isPerProduct(block) { return !!block && !!block.config && block.config.callMode !== 'perOffer'; }

  /* Classifica il riferimento di una clausola. */
  function leftKind(left) {
    const s = String(left == null ? '' : left).trim();
    if (!s) return { kind: 'none' };
    const o = OUTCOME_RE.exec(s);
    if (o) return { kind: 'outcome', ref: o[1] };
    const c = global.Fields.classify(s, null);
    if (c.kind === 'result' || c.kind === 'system') return c;
    if (PATH_RE.test(s)) return { kind: 'path', path: s };
    return { kind: 'invalid', value: s };
  }

  /* Tipo del valore riferito (guida la scrittura dei letterali): number, integer, boolean, array, string, outcome. Per una lista è il tipo degli elementi. */
  function leftType(data, offer, left) {
    const k = leftKind(left);
    if (k.kind === 'outcome') return 'outcome';
    if (k.kind === 'system') return global.Fields.SYSTEM[k.path].type;
    const plain = global.Fields.plain;
    if (k.kind === 'path') {
      const f = ((data.practice && data.practice.fields) || []).find(function (x) { return plain(x.name) === plain(k.path); });
      return f ? f.type || 'string' : 'string';
    }
    if (k.kind === 'result') {
      const b = global.Fields.resolveBlock(offer, k.ref);
      const t = b && data.tasks.find(function (x) { return x.id === b.taskId; });
      const o = t && (t.outputs || []).find(function (x) { return plain(x.name) === plain(k.field); });
      return o ? o.type || 'string' : 'string';
    }
    return 'string';
  }
  /* Il riferimento è una lista (contiene []): servono gli operatori sulle liste. */
  function isListLeft(left) { return /\[\]/.test(String(left || '')); }
  /* Operatori ammessi per un riferimento: sulle liste quelli di lista (più valorizzato/non valorizzato), altrimenti i normali. */
  function opsFor(left, outcome) {
    return Object.keys(OPS).filter(function (k) {
      if (outcome) return k === '==' || k === '!=';
      if (isListLeft(left)) return OPS[k].onList || k === 'exists' || k === 'nexists';
      return !OPS[k].onList;
    });
  }

  /* Letterale tipizzato: il testo scritto nella clausola diventa numero o booleano se il campo lo è. */
  function typed(raw, type) {
    const s = String(raw == null ? '' : raw).trim();
    if ((type === 'number' || type === 'integer') && s !== '' && isFinite(Number(s))) return Number(s);
    if (type === 'boolean' && (s === 'true' || s === 'false')) return s === 'true';
    return s;
  }
  function listOf(raw, type) {
    return String(raw == null ? '' : raw).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; }).map(function (x) { return typed(x, type); });
  }

  /* ---------------- valutazione (simulatore) ---------------- */
  function testClause(c, actual, type) {
    const op = c.op;
    const has = actual !== undefined && actual !== null && actual !== '';
    const arr = Array.isArray(actual) ? actual : [];
    switch (op) {
      case 'anyEq': return arr.some(function (x) { return x === typed(c.value, type); });
      case 'anyNe': return arr.some(function (x) { return x !== typed(c.value, type); });
      case 'allEq': return arr.every(function (x) { return x === typed(c.value, type); });
      case 'noneEq': return !arr.some(function (x) { return x === typed(c.value, type); });
      case 'countEq': return arr.length === (Number(c.value) || 0);
      case 'countNe': return arr.length !== (Number(c.value) || 0);
      case 'countGt': return arr.length > (Number(c.value) || 0);
      case 'countGte': return arr.length >= (Number(c.value) || 0);
      case 'countLt': return arr.length < (Number(c.value) || 0);
      case 'countLte': return arr.length <= (Number(c.value) || 0);
      case 'exists': return Array.isArray(actual) ? actual.length > 0 : has;
      case 'nexists': return Array.isArray(actual) ? actual.length === 0 : !has;
      case '==': return actual === typed(c.value, type);
      case '!=': return actual !== typed(c.value, type);
      case '>': case '>=': case '<': case '<=': {
        if (actual === undefined || actual === null) return false;
        const v = typed(c.value, type);
        return op === '>' ? actual > v : op === '>=' ? actual >= v : op === '<' ? actual < v : actual <= v;
      }
      case 'in': return listOf(c.value, type).some(function (v) { return actual === v; });
      case 'nin': return !listOf(c.value, type).some(function (v) { return actual === v; });
      case 'contains': case 'ncontains': {
        const r = Array.isArray(actual) ? actual.some(function (x) { return x === String(c.value).trim(); }) : String(actual == null ? '' : actual).indexOf(String(c.value).trim()) >= 0;
        return op === 'contains' ? r : !r;
      }
      default: return false;
    }
  }

  /* env = { value(left) → valore, type(left) → tipo }. Una condizione vuota è sempre vera. */
  function evaluate(when, env) {
    if (!isActive(when)) return true;
    const rs = when.clauses.map(function (c) { return testClause(c, env.value(c.left), env.type(c.left)); });
    return when.join === 'OR' ? rs.some(Boolean) : rs.every(Boolean);
  }

  /* "Altrimenti": negazione (De Morgan) della condizione. */
  function negate(when) {
    if (!isActive(when)) return emptyWhen();
    return {
      join: when.join === 'OR' ? 'AND' : 'OR',
      clauses: when.clauses.map(function (c) { return { left: c.left, op: (OPS[c.op] || {}).neg || c.op, value: c.value }; })
    };
  }

  /* ---------------- testo leggibile ---------------- */
  function leftLabel(data, offer, left) {
    const k = leftKind(left);
    if (k.kind === 'outcome') return 'esito di ' + global.Model.blockLabel(data, offer, k.ref);
    return String(left || '?');
  }
  function clauseText(data, offer, c) {
    const op = OPS[c.op] || { label: c.op };
    return leftLabel(data, offer, c.left) + ' ' + op.label + (op.unary ? '' : ' ' + (c.value === '' ? '?' : c.value));
  }
  function describe(data, offer, when) {
    if (!isActive(when)) return '';
    return when.clauses.map(function (c) { return clauseText(data, offer, c); }).join(when.join === 'OR' ? ' OPPURE ' : ' E ');
  }

  /* ---------------- riferimenti proponibili ---------------- */
  function stepIdx(data, id) { return data.steps.findIndex(function (s) { return s.id === id; }); }

  /* Blocchi già eseguiti: per un blocco i suoi predecessori; per un gate (ctx.stepId) tutti i blocchi fino a quello step. */
  function producers(data, offer, ctx) {
    if (ctx.block) return global.Fields.producersFor(data, offer, ctx.block);
    const last = stepIdx(data, ctx.stepId);
    return offer.blocks.filter(function (b) { return stepIdx(data, b.stepId) <= last; });
  }

  function references(data, offer, ctx) {
    const practice = ((data.practice && data.practice.fields) || []).map(function (f) { return { path: f.name, type: f.type || 'string', label: f.description || '' }; });
    const results = [], outcomes = [];
    producers(data, offer, ctx).forEach(function (p) {
      const t = data.tasks.find(function (x) { return x.id === p.taskId; });
      outcomes.push({ path: 'esito.' + p.id, type: 'outcome', label: 'Esito ' + global.Model.blockLabel(data, offer, p.id) });
      ((t && t.outputs) || []).forEach(function (o) { results.push({ path: 'esiti.' + p.id + '.' + o.name, type: o.type || 'string', label: (t ? t.name : p.taskId) + (o.description ? ' · ' + o.description : '') }); });
      // elemento del prodotto corrente nella lista risultati per prodotto (solo dove esiste un prodotto corrente)
      if (t && t.productResults && ctx.block && isPerProduct(ctx.block)) {
        const pre = t.productResults.list + '[].';
        (t.outputs || []).filter(function (o) { return o.name.indexOf(pre) === 0; }).forEach(function (o) {
          results.push({ path: 'esiti.' + p.id + '.' + t.productResults.list + '[@].' + o.name.slice(pre.length), type: o.type || 'string', label: t.name + ' · del prodotto corrente' });
        });
      }
    });
    const system = [{ path: 'offerta.prodotti', type: 'array', label: global.Fields.SYSTEM['offerta.prodotti'].label }];
    if (ctx.block && isPerProduct(ctx.block)) system.push({ path: 'prodotto.id', type: 'string', label: 'Prodotto corrente' });
    return { practice: practice, outcomes: outcomes, results: results, system: system };
  }

  /* ---------------- validazione ---------------- */
  /* ctx = { block } per un blocco, { stepId } per un gate. Ritorna [{ level: 'error'|'warn', msg }]. */
  function check(data, offer, when, ctx, opts) {
    opts = opts || {};
    const out = [];
    const add = function (level, msg) { out.push({ level: level, msg: msg }); };
    if (!isActive(when)) { if (opts.required) add('error', 'condizione vuota: aggiungi almeno una clausola'); return out; }
    const fields = (data.practice && data.practice.fields) || [];
    const before = producers(data, offer, ctx);
    when.clauses.forEach(function (c, n) {
      const tag = 'clausola ' + (n + 1);
      const k = leftKind(c.left);
      const op = OPS[c.op];
      if (!op) { add('error', tag + ': operatore sconosciuto (' + c.op + ')'); return; }
      if (k.kind === 'none') { add('error', tag + ': riferimento mancante'); return; }
      if (k.kind === 'invalid') { add('error', tag + ': riferimento non valido (' + c.left + ')'); return; }
      if (k.kind === 'path' && fields.length && !global.Fields.pathExists(fields, k.path)) add('warn', tag + ': il campo "' + k.path + '" non è nel modello della pratica');
      if (k.kind === 'system' && k.path === 'prodotto.id' && !(ctx.block && isPerProduct(ctx.block))) add('error', tag + ': "prodotto.id" esiste solo nei blocchi "1 chiamata per prodotto"');
      if (k.kind === 'result' || k.kind === 'outcome') {
        const src = global.Fields.resolveBlock(offer, k.ref);
        if (!src) { add('error', tag + ': il blocco "' + k.ref + '" non è nell\'offerta'); return; }
        if (ctx.block && src.id === ctx.block.id) { add('error', tag + ': un blocco non può leggere il proprio esito/output'); return; }
        if (!before.some(function (b) { return b.id === src.id; })) { add('error', tag + ': il blocco "' + src.id + '" non è eseguito prima ' + (ctx.block ? 'di questo (serve uno step precedente o "Esegui dopo")' : 'di questo gate')); return; }
        if (k.kind === 'result') {
          const t = data.tasks.find(function (x) { return x.id === src.taskId; });
          if (t && (t.outputs || []).length && !global.Fields.pathExists(t.outputs, k.field)) add('warn', tag + ': l\'output "' + k.field + '" non è definito nel task ' + src.taskId);
          if (/\[@\]/.test(k.field)) {
            if (!t || !t.productResults) { add('error', tag + ': [@] richiede la lista risultati per prodotto dichiarata nel task ' + src.taskId); return; }
            if (!(ctx.block && isPerProduct(ctx.block))) { add('error', tag + ': [@] si usa solo nei blocchi "1 chiamata per prodotto"'); return; }
          }
        }
      }
      if (k.kind === 'outcome') {
        if (['==', '!='].indexOf(c.op) < 0) add('error', tag + ': sull\'esito di un blocco si può usare solo "è uguale a" / "è diverso da"');
        else if (OUTCOME_VALUES.indexOf(String(c.value).trim()) < 0) add('error', tag + ': il valore dell\'esito deve essere OK o KO');
        return;
      }
      const list = isListLeft(c.left);
      if (list && !(op.onList || op.unary)) { add('error', tag + ': "' + c.left + '" è una lista: usa almeno uno / tutti / nessuno / numero elementi'); return; }
      if (!list && op.onList) { add('error', tag + ': "' + op.label + '" si usa solo su un riferimento lista (con [])'); return; }
      if (!op.unary && String(c.value == null ? '' : c.value).trim() === '') add('error', tag + ': valore mancante');
      if (op.count && !isFinite(Number(c.value))) add('error', tag + ': "' + c.value + '" non è un numero');
      if (op.ordered) {
        const type = leftType(data, offer, c.left);
        if ((type === 'number' || type === 'integer') && !isFinite(Number(c.value))) add('error', tag + ': "' + c.value + '" non è un numero');
      }
    });
    return out;
  }

  global.Conditions = {
    OPS: OPS, OUTCOME_VALUES: OUTCOME_VALUES, clone: clone, isActive: isActive, emptyWhen: emptyWhen, emptyClause: emptyClause,
    leftKind: leftKind, leftType: leftType, typed: typed, listOf: listOf, evaluate: evaluate, negate: negate, isListLeft: isListLeft, opsFor: opsFor,
    describe: describe, clauseText: clauseText, references: references, producers: producers, check: check, isPerProduct: isPerProduct
  };
})(typeof window !== 'undefined' ? window : globalThis);
