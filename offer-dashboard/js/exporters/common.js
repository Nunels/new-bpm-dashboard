/* Registry degli exporter verso motori esterni + utilità condivise (XML, id, YAML, mapping delle sorgenti). */
(function () {
  const list = [];

  function xml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /* Id validi come NCName XML (BPMN/DMN/CMMN). */
  function sid(s) {
    const v = String(s || 'id').replace(/[^A-Za-z0-9_.-]/g, '_');
    return /^[A-Za-z_]/.test(v) ? v : '_' + v;
  }
  function kebab(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  }
  function snake(s) { return kebab(s).replace(/-/g, '_'); }

  /* ---------------- YAML ---------------- */
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function keysOf(o) { return Object.keys(o).filter(function (k) { return o[k] !== undefined; }); }
  function yamlScalar(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    const s = String(v);
    const needsQuotes = s === '' || /^\s|\s$/.test(s) || /^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) || /: | #|:$/.test(s) ||
      /^(true|false|null|yes|no|on|off|y|n|~)$/i.test(s) || /^[-+]?(\d|\.\d)/.test(s) || /[\n\r\t]/.test(s);
    return needsQuotes ? JSON.stringify(s) : s;
  }
  function yamlKey(k) { return /^[A-Za-z_][\w.-]*$/.test(k) ? k : JSON.stringify(k); }
  function isEmptyComposite(v) { return (Array.isArray(v) && !v.length) || (isObj(v) && !keysOf(v).length); }
  function yamlInline(v) { return Array.isArray(v) ? '[]' : isObj(v) ? '{}' : yamlScalar(v); }
  function toYamlRec(v, ind) {
    if (Array.isArray(v)) {
      if (!v.length) return ind + '[]';
      return v.map(function (x) {
        if (isObj(x) && keysOf(x).length) return ind + '- ' + toYamlRec(x, ind + '  ').slice(ind.length + 2);
        if (Array.isArray(x) && x.length) return ind + '-\n' + toYamlRec(x, ind + '  ');
        return ind + '- ' + yamlInline(x);
      }).join('\n');
    }
    if (isObj(v)) {
      const ks = keysOf(v);
      if (!ks.length) return ind + '{}';
      return ks.map(function (k) {
        const x = v[k];
        if ((isObj(x) || Array.isArray(x)) && !isEmptyComposite(x)) return ind + yamlKey(k) + ':\n' + toYamlRec(x, ind + '  ');
        return ind + yamlKey(k) + ': ' + yamlInline(x);
      }).join('\n');
    }
    return ind + yamlScalar(v);
  }
  function toYaml(v) { return toYamlRec(v, '') + '\n'; }

  /* ---------------- helper sul piano ---------------- */
  /*
   * Classifica la sorgente di un input: risultato di un'altra attività (esiti.X.campo), sorgente di sistema,
   * percorso nei dati della pratica (es. cliente.codiceFiscale) oppure valore fisso (es. WELCOME_KIT).
   * Con il piano si riconoscono come percorsi solo quelli che partono da una radice del modello della pratica.
   */
  function source(src, plan) {
    return window.Fields.classify(src, plan && plan.practice ? plan.practice.roots : null);
  }

  /* Id dei blocchi "non attesi": quelli indicati da una regola Non attendere di un gate. */
  function detachedIds(plan) {
    const ids = [];
    plan.gates.forEach(function (g) { g.effectivePolicy.dontWait.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); }); });
    return ids;
  }
  /* Attività riferita da esiti.<X>.<campo>: X può essere l'id del blocco o l'id del task. */
  function findActivity(plan, ref) {
    let found = null;
    allActivities(plan).forEach(function (a) { if (!found && (a.activityId === ref || a.taskId === ref)) found = a; });
    return found;
  }

  function allActivities(plan) { return plan.activities.slice(); }

  function hasKoTask(a) { return !!a.outcomes.KO_WITH_TASK; }
  function isAsync(a) { return a.executionType === 'ASYNC_CALLBACK'; }
  function perProduct(a) { return a.invocation.mode === 'ONE_CALL_PER_PRODUCT'; }

  window.Exporters = {
    list: list,
    register: function (e) { list.push(e); },
    get: function (id) { return list.find(function (e) { return e.id === id; }); },
    xml: xml, sid: sid, kebab: kebab, snake: snake, toYaml: toYaml,
    source: source, detachedIds: detachedIds, findActivity: findActivity, allActivities: allActivities,
    hasKoTask: hasKoTask, isAsync: isAsync, perProduct: perProduct,
    BASE_URL: 'https://api.example.internal'
  };
})();
