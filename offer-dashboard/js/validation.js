/* Controlli di coerenza sull'offerta configurata. */
(function () {
  function validateOffer(data, offer) {
    const errors = [], warnings = [], infos = [];
    const add = function (list, msg, ref) { list.push({ msg: msg, ref: ref || null }); };
    const blockIds = offer.blocks.map(function (b) { return b.id; });

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
      const name = t.name + ' (' + Model.step(data, b.stepId).name + ')';
      if (!b.products.length) add(errors, name + ': nessun prodotto assegnato.', ref);
      b.products.forEach(function (pid) {
        if (offer.products.indexOf(pid) < 0) add(errors, name + ': il prodotto ' + Model.productName(data, pid) + ' non fa parte dell\'offerta.', ref);
        else if (t.compatibleProducts.indexOf(pid) < 0) add(errors, name + ': task non compatibile con ' + Model.productName(data, pid) + '.', ref);
      });
      if (t.allowedSteps.length && t.allowedSteps.indexOf(b.stepId) < 0)
        add(warnings, name + ': step non previsto dal catalogo (ammessi: ' + t.allowedSteps.map(function (s) { return Model.step(data, s).name; }).join(', ') + ').', ref);
      b.dependsOn.forEach(function (d) {
        const dep = offer.blocks.find(function (x) { return x.id === d; });
        if (!dep) add(errors, name + ': dipende da un blocco inesistente (' + d + ').', ref);
        else if (dep.stepId !== b.stepId) add(errors, name + ': dipende da un blocco di un altro step.', ref);
        else {
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

    data.steps.forEach(function (s, i) {
      const blocks = Model.blocksInStep(offer, s.id);
      const lv = Model.levels(blocks);
      if (lv.cycle.length) add(errors, s.name + ': dipendenze circolari tra blocchi (' + lv.cycle.map(function (id) { return Model.blockLabel(data, offer, id); }).join(' ↔ ') + ').', { type: 'block', id: lv.cycle[0] });
      blocks.filter(function (b) { return (b.dependsOn || []).filter(function (d) { return blocks.some(function (x) { return x.id === d; }); }).length > 1; }).forEach(function (b) {
        add(infos, s.name + ': "' + Model.blockLabel(data, offer, b.id) + '" dipende da più blocchi (join): i blocchi collegati formano un gruppo e si attende il completamento di ogni livello.', { type: 'block', id: b.id });
      });
      if (i === data.steps.length - 1) return;
      const gates = Model.gatesAfter(offer, s.id);
      gates.forEach(function (g) {
        const ref = { type: 'gate', id: g.id };
        if (!g.rules.length) add(warnings, 'Gate dopo ' + s.name + ' senza regole.', ref);
        g.rules.forEach(function (r) {
          if (!Model.RULE_TYPES[r.type]) add(errors, 'Gate dopo ' + s.name + ': regola sconosciuta ' + r.type + '.', ref);
          if (r.type === 'DONT_WAIT') {
            if (!r.blockId) add(errors, 'Gate dopo ' + s.name + ': "Non attendere" senza blocco selezionato.', ref);
            else if (blockIds.indexOf(r.blockId) < 0) add(errors, 'Gate dopo ' + s.name + ': "Non attendere" riferisce un blocco eliminato.', ref);
            else if (offer.blocks.find(function (b) { return b.id === r.blockId; }).stepId !== s.id)
              add(errors, 'Gate dopo ' + s.name + ': "Non attendere" riferisce un blocco di un altro step.', ref);
          }
          if (r.type === 'STOP_ON_KO' && r.products) r.products.forEach(function (p) {
            if (offer.products.indexOf(p) < 0) add(errors, 'Gate dopo ' + s.name + ': "Ferma tutto" riferisce un prodotto non in offerta.', ref);
          });
          if (r.type === 'ROUTE') {
            const where = 'Gate dopo ' + s.name + ': instradamento';
            Conditions.check(data, offer, r.when, { stepId: s.id }, { required: true }).forEach(function (c) {
              add(c.level === 'error' ? errors : warnings, where + ': ' + c.msg + '.', ref);
            });
            if (r.to !== 'STOP') {
              const dest = Model.step(data, r.to);
              if (!r.to) add(errors, where + ': destinazione mancante.', ref);
              else if (!dest) add(errors, where + ': lo step di destinazione "' + r.to + '" non esiste.', ref);
              else if (!Model.blocksInStep(offer, r.to).length) add(errors, where + ': lo step di destinazione "' + dest.name + '" non ha blocchi.', ref);
              if (!(r.maxIterations >= 1 && r.maxIterations <= Model.MAX_ITERATIONS_LIMIT))
                add(errors, where + ': il numero massimo di ripetizioni deve essere tra 1 e ' + Model.MAX_ITERATIONS_LIMIT + '.', ref);
              if (dest && Model.stepIndex(data, r.to) <= i) add(infos, where + ': ritorno a "' + dest.name + '" (al massimo ' + r.maxIterations + ' volte, poi ' + (r.onExceed === 'CONTINUE' ? 'si prosegue' : 'l\'offerta si ferma') + ').', ref);
            }
          }
        });
      });
      const pol = Model.effectivePolicy(gates);
      if (pol.conflict) add(warnings, 'Transizione ' + s.name + ' → ' + data.steps[i + 1].name + ': "Solo OK" e "Prosegui anche con KO" in conflitto, prevale "Solo OK".', gates[0] ? { type: 'gate', id: gates[0].id } : null);
      if (!pol.explicit) add(infos, 'Transizione ' + s.name + ' → ' + data.steps[i + 1].name + ': nessuna regola sui KO, si applica il default "Manda solo gli OK".', gates[0] ? { type: 'gate', id: gates[0].id } : null);
    });

    return { errors: errors, warnings: warnings, infos: infos, ok: errors.length === 0 };
  }

  window.Validation = { validateOffer: validateOffer };
})();
