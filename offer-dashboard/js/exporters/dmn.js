/* Exporter DMN 1.3: una decision table per ogni transizione tra step (regole delle barre arancioni). */
(function () {
  const X = Exporters;

  function feelList(arr) { return '[' + arr.map(function (p) { return JSON.stringify(p); }).join(', ') + ']'; }

  function build(plan) {
    const decisions = [], shapes = [];
    let col = 0;
    plan.steps.forEach(function (st, i) {
      if (!st.exitGate) return;
      const pol = st.exitGate.effectivePolicy;
      const next = plan.steps[i + 1];
      const id = 'Gate_' + X.sid(st.stepId);
      const scoped = Array.isArray(pol.stopOnKo);
      const continueProducts = pol.koProducts === 'CONTINUE' ? 'activeProducts' : 'activeProducts[not(list contains(koProducts, item))]';
      const inputs = [
        { id: id + '_in_ko', label: 'Ci sono prodotti KO?', expr: 'count(koProducts) > 0' }
      ];
      if (scoped) inputs.push({ id: id + '_in_scope', label: 'KO su ' + pol.stopOnKo.join(', ') + '?', expr: 'some p in koProducts satisfies list contains(' + feelList(pol.stopOnKo) + ', p)' });
      const rules = [];
      if (pol.stopOnKo === 'ALL') rules.push({ when: ['true'].concat(scoped ? ['-'] : []), action: '"STOP"', products: '[]', note: 'Ferma tutto se ci sono KO' });
      if (scoped) rules.push({ when: ['-', 'true'], action: '"STOP"', products: '[]', note: 'Ferma tutto se KO su ' + pol.stopOnKo.join(', ') });
      rules.push({ when: inputs.map(function () { return '-'; }), action: '"CONTINUE"', products: continueProducts,
        note: pol.koProducts === 'CONTINUE' ? 'Prosegui anche con KO' : 'Manda solo gli OK' });

      const dontWait = pol.dontWait.length ? ' Non attesi: ' + pol.dontWait.join(', ') + '.' : '';
      decisions.push(
        '  <decision id="' + id + '" name="' + X.xml('Gate ' + st.name + ' → ' + next.name) + '">\n' +
        '    <description>' + X.xml(pol.description.join(' · ') + dontWait) + '</description>\n' +
        '    <decisionTable id="' + id + '_table" hitPolicy="FIRST">\n' +
        inputs.map(function (inp) {
          return '      <input id="' + inp.id + '" label="' + X.xml(inp.label) + '">\n' +
            '        <inputExpression id="' + inp.id + '_expr" typeRef="boolean"><text>' + X.xml(inp.expr) + '</text></inputExpression>\n      </input>\n';
        }).join('') +
        '      <output id="' + id + '_out_action" label="Azione" name="action" typeRef="string" />\n' +
        '      <output id="' + id + '_out_products" label="Prodotti che proseguono" name="activeProducts" />\n' +
        '      <annotation name="Regola" />\n' +
        rules.map(function (r, ri) {
          const rid = id + '_r' + (ri + 1);
          return '      <rule id="' + rid + '">\n' +
            r.when.map(function (w, wi) { return '        <inputEntry id="' + rid + '_i' + (wi + 1) + '"><text>' + X.xml(w) + '</text></inputEntry>\n'; }).join('') +
            '        <outputEntry id="' + rid + '_o1"><text>' + X.xml(r.action) + '</text></outputEntry>\n' +
            '        <outputEntry id="' + rid + '_o2"><text>' + X.xml(r.products) + '</text></outputEntry>\n' +
            '        <annotationEntry><text>' + X.xml(r.note) + '</text></annotationEntry>\n' +
            '      </rule>\n';
        }).join('') +
        '    </decisionTable>\n  </decision>');
      shapes.push('      <dmndi:DMNShape id="' + id + '_di" dmnElementRef="' + id + '"><dc:Bounds x="' + (160 + col * 220) + '" y="100" width="180" height="80" /></dmndi:DMNShape>');
      col++;
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/"' +
      ' xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/" xmlns:modeler="http://camunda.org/schema/modeler/1.0"' +
      ' id="Gates_' + X.sid(plan.offer.id) + '" name="' + X.xml('Gate ' + plan.offer.name) + '" namespace="http://example.com/offers"' +
      ' modeler:executionPlatform="Camunda Cloud" modeler:executionPlatformVersion="8.6.0">\n' +
      decisions.join('\n') + (decisions.length ? '\n' : '') +
      '  <dmndi:DMNDI>\n    <dmndi:DMNDiagram id="DMNDiagram_' + X.sid(plan.offer.id) + '">\n' + shapes.join('\n') + (shapes.length ? '\n' : '') +
      '    </dmndi:DMNDiagram>\n  </dmndi:DMNDI>\n</definitions>\n';
  }

  X.buildDmn = build;
})();
