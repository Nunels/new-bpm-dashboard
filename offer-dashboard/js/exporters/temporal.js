/* Target Temporal: emette il piano come Serverless Workflow 1.0 (stesso YAML di Quarkus Flow, validato)
 * da eseguire con l'interprete Java generico in temporal-offer-interpreter. */
(function () {
  const X = Exporters;

  X.register({
    id: 'temporal',
    label: 'Temporal (Serverless Workflow 1.0 → interprete Java)',
    notes: [
      'Il YAML è Serverless Workflow 1.0 (document/do), identico a quello di Quarkus Flow: Temporal non ha un formato di processo proprio.',
      'Si esegue con temporal-offer-interpreter: un server Temporal e un worker Java generico deployato una volta. Ogni offerta è un YAML pubblicato nella cartella delle definizioni: nessun build né redeploy; ogni pratica resta sulla versione letta all\'avvio.',
      'Espressioni jq con jackson-jq 1.6.5 (la stessa libreria e versione di Quarkus Flow), funzioni built-in di jq caricate.',
      'Callback (ticket, back office, partner) = "listen" su eventi inviati al workflow come signal (in produzione da un consumer Kafka); "KO con task" = emit (activity) + listen. "Non attendere" = child workflow abbandonato: il padre non lo aspetta.',
      'Verifica a runtime: 10 scenari su 10 identici al simulatore su ambiente Temporal di test, ma con i flussi del formato precedente (a step). Il formato a grafo (gate come task nel ramo, fork annidati, dead) non è stato eseguito: da riprovare prima dell\'uso.'
    ],
    files: function (plan) {
      return X.get('serverless').files(plan);
    }
  });
})();
