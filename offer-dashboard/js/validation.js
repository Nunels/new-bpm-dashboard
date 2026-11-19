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
      });
      t.inputs.forEach(function (i) {
        if (i.required && !String(b.config.inputMapping[i.name] || '').trim())
          add(warnings, name + ' [' + b.id + ']: input obbligatorio "' + i.name + '" senza sorgente/valore.', ref);
      });
      if (b.config.koTask.enabled && t.outcomes.indexOf('KO_TASK') >= 0 && !String(b.config.koTask.queue || '').trim())
        add(errors, name + ': "KO con task" attivo ma coda del task manuale non indicata.', ref);
      if (t.type === 'async' && !String(b.config.async.callbackTopic || '').trim())
        add(warnings, name + ': task asincrono senza topic di callback.', ref);
      if (b.config.notify && (b.config.notify.onOk || b.config.notify.onKo) && !String(b.config.notify.template || '').trim())
        add(warnings, name + ': notifica mail attiva senza template.', ref);
    });

    data.steps.forEach(function (s, i) {
      const blocks = Model.blocksInStep(offer, s.id);
      const lv = Model.levels(blocks);
      if (lv.cycle.length) add(errors, s.name + ': dipendenze circolari tra blocchi (' + lv.cycle.map(function (id) { return Model.blockLabel(data, offer, id); }).join(' ↔ ') + ').', { type: 'block', id: lv.cycle[0] });
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
