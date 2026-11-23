/* Controlli di coerenza sull'offerta configurata. */
(function () {
  function validateOffer(data, offer) {
    const errors = [], warnings = [], infos = [];
    const add = function (list, msg, ref) { list.push({ msg: msg, ref: ref || null }); };

    if (!offer.products.length) add(errors, 'L\'offerta non contiene prodotti.', { type: 'offer' });
    offer.products.forEach(function (pid) {
      if (!Model.product(data, pid)) add(errors, 'Prodotto "' + pid + '" non presente nel catalogo.', { type: 'offer' });
      if (!offer.blocks.some(function (b) { return b.products.indexOf(pid) >= 0; }))
        add(warnings, 'Il prodotto ' + Model.productName(data, pid) + ' non ha nessun blocco configurato.', { type: 'offer' });
    });

    offer.blocks.forEach(function (b) {
      const ref = { type: 'block', id: b.id };
      const t = Model.task(data, b.taskId);
      if (!t) { add(errors, 'Blocco ' + b.id + ': task "' + b.taskId + '" non presente nel catalogo.', ref); return; }
      const name = t.name;
      if (!b.products.length) add(errors, name + ': nessun prodotto assegnato.', ref);
      b.products.forEach(function (pid) {
        if (offer.products.indexOf(pid) < 0) add(errors, name + ': il prodotto ' + Model.productName(data, pid) + ' non fa parte dell\'offerta.', ref);
        else if (t.compatibleProducts.indexOf(pid) < 0) add(errors, name + ': task non compatibile con ' + Model.productName(data, pid) + '.', ref);
      });
      b.dependsOn.forEach(function (d) {
        const dep = Model.block(offer, d);
        if (d === b.id) add(errors, name + ' [' + b.id + ']: dipende da se stesso.', ref);
        else if (!dep && !Model.isGate(offer, d)) add(errors, name + ' [' + b.id + ']: dipende da un nodo inesistente (' + d + ').', ref);
        else if (dep) {
          const missing = b.products.filter(function (p) { return dep.products.indexOf(p) < 0; });
          if (missing.length) add(warnings, name + ' [' + b.id + ']: dipende da ' + dep.id + ' che non copre ' + missing.map(function (p) { return Model.productName(data, p); }).join(', ') + ': per questi prodotti l\'attesa non ha effetto.', ref);
        }
      });
      t.inputs.forEach(function (i) {
        const st = Fields.status(data, offer, b, i);
        if (st.level === 'none') {
          if (i.required) add(warnings, name + ' [' + b.id + ']: input obbligatorio "' + i.name + '" senza sorgente/valore.', ref);
        } else if (st.level === 'error') add(errors, name + ' [' + b.id + ']: input "' + i.name + '": ' + st.msg + '.', ref);
        else if (st.level === 'warn') add(warnings, name + ' [' + b.id + ']: input "' + i.name + '": ' + st.msg + '.', ref);
      });
      // liste: ogni campo dentro una lista ha bisogno della riga della lista (con la sua origine) nel catalogo
      t.inputs.forEach(function (i) {
        for (let k = Fields.parentList(i.name); k; k = Fields.parentList(k)) {
          const row = t.inputs.find(function (x) { return x.name === k; });
          if (!row) { add(errors, name + ' [' + b.id + ']: input "' + i.name + '": manca la riga della lista "' + k + '" nel catalogo (serve per indicarne l\'origine).', ref); break; }
          if (!String((b.config.inputMapping || {})[k] || '').trim() && i !== row) { add(errors, name + ' [' + b.id + ']: la lista "' + k + '" non ha un\'origine: gli elementi di "' + i.name + '" non si possono costruire.', ref); break; }
        }
      });
      if (t.productResults) {
        const pr = t.productResults;
        [['campo prodotto', pr.productField], ['campo esito', pr.outcomeField]].forEach(function (f) {
          if (!t.outputs.some(function (o) { return o.name === pr.list + '[].' + f[1]; })) add(errors, name + ': lista risultati per prodotto: manca l\'output "' + pr.list + '[].' + f[1] + '" (' + f[0] + ') nel catalogo.', ref);
        });
        if (!(pr.ok || []).length) add(errors, name + ': lista risultati per prodotto: indica almeno un valore di esito OK.', ref);
      }
      if (b.config.koTask.enabled && t.outcomes.indexOf('KO_TASK') >= 0 && !String(b.config.koTask.queue || '').trim())
        add(errors, name + ': "KO con task" attivo ma coda del task manuale non indicata.', ref);
      if (t.type === 'async' && !String(b.config.async.callbackTopic || '').trim())
        add(warnings, name + ': task asincrono senza topic di callback.', ref);
      if (b.config && b.config.notify && (b.config.notify.onOk || b.config.notify.onKo) && !String(b.config.notify.template || '').trim())
        add(warnings, name + ': notifica mail attiva senza template.', ref);
      Conditions.check(data, offer, b.config.when, { block: b }).forEach(function (c) {
        add(c.level === 'error' ? errors : warnings, name + ' [' + b.id + '] condizione: ' + c.msg + '.', ref);
      });
      t.inputs.forEach(function (i) {
        const c = Fields.classify((b.config.inputMapping || {})[i.name], null);
        const src = c.kind === 'result' ? Fields.resolveBlock(offer, c.ref) : null;
        if (src && Conditions.isActive(src.config.when))
          add(warnings, name + ' [' + b.id + ']: input "' + i.name + '" letto da un blocco condizionale (' + src.id + '): se il blocco viene saltato il valore manca.', ref);
      });
    });

    // struttura: il grafo deve ridursi a sequenze e rami paralleli, altrimenti il DSL non lo esprime
    const st = Model.structure(offer);
    const graph = st.graph;
    Model.structureErrors(data, offer, st).forEach(function (m, i) { add(errors, m, { type: 'block', id: st.errors[i].ids[0] }); });
    const topIdx = {};
    st.top.forEach(function (id, i) { topIdx[id] = i; });
    offer.blocks.forEach(function (b) {
      if ((graph.deps[b.id] || []).length > 1)
        add(infos, '"' + Model.blockLabel(data, offer, b.id) + '" dipende da più nodi (join): parte quando tutti hanno finito.', { type: 'block', id: b.id });
    });

    offer.gates.forEach(function (g) {
      const ref = { type: 'gate', id: g.id };
      const label = 'Gate ' + g.id;
      (g.dependsOn || []).forEach(function (d) {
        if (d === g.id) add(errors, label + ': dipende da se stesso.', ref);
        else if (!Model.node(offer, d)) add(errors, label + ': dipende da un nodo inesistente (' + d + ').', ref);
      });
      if (!(graph.deps[g.id] || []).length) add(warnings, label + ': non è collegato a nessun blocco (scegli "Dopo").', ref);
      g.rules.forEach(function (r) {
        if (!Model.RULE_TYPES[r.type]) add(errors, label + ': regola sconosciuta ' + r.type + '.', ref);
        if (r.type === 'DONT_WAIT') {
          if (!r.blockId) add(errors, label + ': "Non attendere" senza blocco selezionato.', ref);
          else if (!Model.block(offer, r.blockId)) add(errors, label + ': "Non attendere" riferisce un blocco eliminato.', ref);
          else if ((graph.deps[g.id] || []).indexOf(r.blockId) < 0) add(errors, label + ': "Non attendere" vale solo per un blocco collegato direttamente al gate (tra i suoi "Dopo").', ref);
          else if ((graph.kids[r.blockId] || []).length > 1) add(errors, label + ': "Non attendere" non è possibile su un blocco da cui dipendono altri nodi.', ref);
        }
        if (r.type === 'STOP_ON_KO' && r.products) r.products.forEach(function (p) {
          if (offer.products.indexOf(p) < 0) add(errors, label + ': "Ferma tutto" riferisce un prodotto non in offerta.', ref);
        });
        if (r.type === 'ROUTE') {
          const where = label + ': instradamento';
          Conditions.check(data, offer, r.when, { gate: g.id }, { required: true }).forEach(function (c) {
            add(c.level === 'error' ? errors : warnings, where + ': ' + c.msg + '.', ref);
          });
          if (r.to !== 'STOP') {
            if (!r.to) add(errors, where + ': destinazione mancante.', ref);
            else if (!Model.node(offer, r.to)) add(errors, where + ': la destinazione "' + r.to + '" non esiste.', ref);
            else if (!st.errors.length) {
              if (topIdx[r.to] == null) add(errors, where + ': la destinazione "' + Model.nodeName(data, offer, r.to) + '" è dentro rami paralleli: nel DSL si può saltare solo a un nodo della sequenza principale.', ref);
              if (topIdx[g.id] == null) add(errors, where + ': il gate è dentro un ramo parallelo: ritorno e salto sono ammessi solo per i gate della sequenza principale (nel ramo resta lo STOP).', ref);
              if (topIdx[r.to] != null && topIdx[g.id] != null && topIdx[r.to] <= topIdx[g.id])
                add(infos, where + ': ritorno a "' + Model.nodeName(data, offer, r.to) + '" (al massimo ' + r.maxIterations + ' volte, poi ' + (r.onExceed === 'CONTINUE' ? 'si prosegue' : 'l\'offerta si ferma') + ').', ref);
            }
            if (!(r.maxIterations >= 1 && r.maxIterations <= Model.MAX_ITERATIONS_LIMIT))
              add(errors, where + ': il numero massimo di ripetizioni deve essere tra 1 e ' + Model.MAX_ITERATIONS_LIMIT + '.', ref);
          }
        }
      });
      const pol = Model.effectivePolicy([g]);
      if (pol.conflict) add(warnings, label + ': "Solo OK" e "Prosegui anche con KO" in conflitto, prevale "Solo OK".', ref);
      if (!pol.explicit) add(infos, label + ': nessuna regola sui KO, si applica il default "Manda solo gli OK".', ref);
    });
    return { errors: errors, warnings: warnings, infos: infos, ok: errors.length === 0 };
  }

  window.Validation = { validateOffer: validateOffer };
})();
