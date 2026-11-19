/* Ponte tra il backend e il codice della dashboard (eseguito in GraalJS dopo gli script della dashboard). */
function analyzeOffer(catalogJson, offerJson) {
  const catalog = JSON.parse(catalogJson);
  const input = JSON.parse(offerJson);
  const data = Model.normalize({ products: catalog.products || [], tasks: catalog.tasks || [], offers: [input] });
  const offer = data.offers[0];
  const v = Validation.validateOffer(data, offer);
  const out = {
    offer: Model.canonicalOffer(offer),
    validation: {
      errors: v.errors.map(function (e) { return e.msg; }),
      warnings: v.warnings.map(function (e) { return e.msg; }),
      infos: v.infos.map(function (e) { return e.msg; })
    },
    files: [], simulation: null, roundTrip: null
  };
  if (v.errors.length) return JSON.stringify(out);
  const plan = ExecutionPlan.build(data, offer);
  out.files = Exporters.get('temporal').files(plan).map(function (f) { return { name: f.name, content: f.content }; });
  const sim = Simulator.run(data, offer, {});
  out.simulation = { status: sim.final.status, message: sim.final.message };
  const rt = DslImport.apply(data, out.files[0].content, null);
  out.roundTrip = { ok: rt.ok, errors: rt.errors || [] };
  return JSON.stringify(out);
}

function stepsJson() {
  return JSON.stringify(window.SEED.steps);
}

/* Catalogo e offerte demo della dashboard (seed). */
function seedJson() {
  return JSON.stringify(window.SEED);
}
