# Interprete Serverless Workflow su Temporal

Esegue su **Temporal** gli stessi workflow **Serverless Workflow 1.0** (YAML) che la dashboard (`../offer-dashboard`) esporta e che girano su Quarkus Flow (`../quarkus-flow-sim`).
Si deploya **un solo worker Java**: ogni offerta è una definizione YAML pubblicata in una cartella, eseguibile subito, senza build né redeploy.

```text
analista → dashboard → YAML Serverless Workflow 1.0 → cartella definizioni
                                                         │ (letta all'avvio di ogni pratica, versione registrata nella storia)
client / Kafka ──start, event──▶ Temporal Server ◀──gRPC── worker: OfferInterpreterWorkflow + activity
                                  (stato, timer, code)        │ HTTP verso i servizi (stream 1), emit eventi
```

## Come funziona
- **Un workflow Temporal generico** (`OfferInterpreterWorkflow`) riceve `namespace`, `name`, `version` e l'input della pratica.
  - Carica la definizione con un'activity: il testo letto finisce nella storia, quindi la pratica resta legata a quella versione anche se ne viene pubblicata un'altra.
  - Controlla che la definizione sia nel perimetro supportato ed esegue i task.
- **Ogni costrutto usa una primitiva durevole di Temporal**:

| DSL 1.0 | Su Temporal |
|---|---|
| `call: http` | activity `HttpActivities.call` (un tentativo: i retry li decide il workflow) |
| `try` / `catch` + `retry` | ciclo nel workflow con `Workflow.sleep` (timer durevole) tra i tentativi |
| `fork` (compete: false) | thread del workflow (`Async.function`), deterministici |
| `for`, `do`, `set`, `switch`, `raise`, `then` | codice dell'interprete |
| `listen` (to.one, con `correlate` e `timeout`) | `Workflow.await` sulla coda degli eventi ricevuti come signal `event` |
| `emit` | activity `EventActivities.emit` (in produzione: produttore Kafka) |
| `run: workflow` | child workflow; con `await: false` ParentClosePolicy ABANDON: il padre **non** lo aspetta |
| `wait` | `Workflow.sleep` |
| `timeout.after` su `call` e `listen` | timeout dell'activity / del `Workflow.await` |
| `input.schema` del workflow | validazione JSON Schema all'avvio |

- **Espressioni:** jq con **jackson-jq 1.6.5**, la stessa libreria e versione usata da Quarkus Flow 1.3.0, con le funzioni built-in caricate (`BuiltinFunctionLoader`). Il motore è dietro l'interfaccia `ExpressionEngine`, quindi è sostituibile.
- **Monitoraggio:** le query `context` e `currentTask` restituiscono `$context` e il task in esecuzione; la Web UI di Temporal mostra storia, activity, timer e signal.

## Perimetro
Il validatore (`DefinitionValidator`) rifiuta **all'avvio** tutto ciò che è fuori perimetro. Il workflow Temporal fallisce subito, senza retry (`InvalidDefinition`), con l'elenco dei problemi e il percorso di ciascuno.

| Supportato | Non supportato (rifiutato) |
|---|---|
| `do`, `set`, `call: http` (method, endpoint, headers, query, body, output content/response), `try`/`catch` (errors.with, as, when, exceptWhen, retry con delay, backoff constant/linear/exponential, limit.attempt.count, do), `for` (each, in, at, while), `fork` (compete: false), `switch`, `raise` (errore inline), `run: workflow` (await true/false), `listen` (to.one, with, correlate, read data/envelope), `emit`, `wait`, `if`, `input.from`, `output.as`, `export.as`, `then` (continue, exit, end, nome task), `timeout.after` su call e listen, `input.schema` inline, `output.as` del workflow | `call` grpc/openapi/asyncapi/funzioni, `run` container/script/shell, `fork` compete: true, `listen` any/all/until/foreach, filtro `with.data`, riferimenti a `use` (errori, retry, autenticazioni, funzioni), `schedule`, `timeout` del workflow, jitter, `limit.duration`, `evaluate.mode: loose`, schemi esterni |

Sono rifiutate anche le espressioni jq che non compilano e quelle **non deterministiche** (`now`, `env`, `input`, `$ENV`…): nel replay di Temporal darebbero un risultato diverso.

## Scelte di semantica (da validare)
La specifica 1.0 non è esplicita su alcuni punti. Le scelte fatte sono queste:
1. **Esiti.** Un errore Serverless Workflow non gestito (`raise`, retry esauriti, timeout di un `listen`, input non valido) chiude il workflow con `status: FAULTED` e l'errore in formato Problem Details. È un esito della pratica.
   Una definizione illeggibile, fuori perimetro o non pubblicata fa invece **fallire** il workflow Temporal: è un difetto della pubblicazione.
2. **Retry esauriti senza `catch.do`:** l'errore si propaga. Un errore catturato senza retry né `do` viene assorbito (il `try` restituisce il proprio input).
3. **Limite dei retry:** un `retry` senza `limit.attempt.count` ritenta senza limite.
4. **Eventi:** restano in coda finché un `listen` non li consuma. Una callback arrivata prima che il workflow la attenda non va persa; un evento che non corrisponde (per esempio un'altra pratica) resta in coda.
5. **Output del `listen`:** come da specifica è l'**array** degli eventi consumati. L'exporter usa `output.as: ${ .[0] }` per lavorare sull'evento.
   Questa è una correzione fatta all'exporter durante questo lavoro: prima leggeva `$output.productOutcomes` direttamente, cosa che sui runtime conformi non avrebbe funzionato. Su Quarkus Flow non era emerso perché gli scenari erano solo sincroni.
6. **Contesto iniziale:** `$context` parte dall'input trasformato del workflow (sezione Data Flow della specifica).
7. **Stato dell'offerta:** è derivato da `OfferOutcome` secondo le convenzioni dell'exporter. `output.status` vale COMPLETED o NO_PRODUCTS; l'errore `.../offer-stopped` diventa STOPPED.

## Esecuzione
Servono JDK 17+ e Maven 3.8+. Le dipendenze vengono dal repository Maven configurato nel `settings.xml`.

```powershell
mvn test                                    # tutti i test (ambiente Temporal in memoria, nessun server esterno)
mvn test -Dtest=ScenarioTest                # solo i 10 scenari di quarkus-flow-sim
```

Prova manuale con worker e CLI (worker, client e server sono processi separati):
```powershell
mvn -q test-compile dependency:build-classpath -Dmdep.includeScope=test -Dmdep.outputFile=target\cp.txt
$cp = "target\classes;target\test-classes;" + (Get-Content target\cp.txt -Raw).Trim()

java -cp $cp io.temporal.testserver.TestServer 7233        # 1) server Temporal di test (oppure: temporal server start-dev)
$env:DEFINITIONS_DIR = "examples\definitions"               # 2) worker
java -cp $cp it.sim.temporal.app.InterpreterWorker
java -cp $cp it.sim.temporal.app.Cli start demo ticket-callback latest examples\input.json pratica-PRA-42   # 3) pratica in attesa del ticket
java -cp $cp it.sim.temporal.app.Cli context pratica-PRA-42                  # task corrente e $context
java -cp $cp it.sim.temporal.app.Cli event pratica-PRA-42 examples\event.json   # callback del ticket → la pratica si chiude
```
Variabili d'ambiente: `TEMPORAL_ADDRESS` (default `127.0.0.1:7233`), `TEMPORAL_NAMESPACE` (`default`), `TASK_QUEUE` (`offer-interpreter`), `DEFINITIONS_DIR` (`./definitions`).

**Pubblicare un'offerta** significa copiare nella cartella delle definizioni il YAML esportato dalla dashboard (target "Temporal" o "Serverless Workflow"). La pratica si avvia con `version` esplicita oppure `latest`.

**Callback da Kafka:** serve un piccolo consumer che legge il topic di callback (es. `bo.pratiche.esiti`) e invia l'evento con il signal `event` al workflow della pratica. Con un `workflowId` derivato dall'id pratica (es. `pratica-<id>`) il consumer non ha bisogno di mappature. Non è incluso: nei test le callback sono inviate come signal.

## Test (29, tutti verdi)
| Test | Cosa verifica |
|---|---|
| `ScenarioTest` | i **10 scenari** di quarkus-flow-sim sugli stessi YAML: stato, prodotti attivi, chiamate per servizio, prodotti inviati a ogni servizio, tempo di "Non attendere". **10 su 10** (Quarkus Flow con YAML: 9 su 10): "Non attendere" chiude la pratica in circa 100 ms con Oracolo 2 a 4 s. Ogni esecuzione viene rigiocata con `WorkflowReplayer` (determinismo). |
| `BundleCallbackTest` | offerta demo completa esportata dalla dashboard. Callback del back office con "KO con task" (emit della richiesta sulla coda `BO_RILAVORAZIONE`, attesa del completamento), callback di attivazione TIM, ramo non atteso completato, callback in anticipo o di un'altra pratica, stop al gate BO con un KO. Più il replay. |
| `PerimeterTest` | retry riuscito e retry esaurito (errore communication 503 con `instance`), `catch.do` con variabile d'errore, timeout del `listen` (408), `for` con `at`/`while`, salto con `switch`, `then: end`, input non valido (400), rifiuto dei costrutti fuori perimetro e delle definizioni non pubblicate |
| `PublicationTest` | worker reale via gRPC su un server di test: una nuova versione copiata nella cartella è usata subito come `latest` senza riavviare il worker, e la versione precedente resta avviabile |
| `ConformanceTest` | tutti i YAML eseguiti sono validi contro lo **schema ufficiale DSL 1.0.0** (`src/test/resources/schema`) |
| `JqExpressionEngineTest` | tutte le espressioni dei YAML compilano; casi chiave (KO da `productOutcomes`, `unique`, differenza di array, `@uri`); rilevamento delle funzioni non deterministiche |

I workflow in `src/test/resources/flows` sono copie generate: `offer-off-sim*` da `quarkus-flow-sim`, `offer-off-bundle*` dall'exporter della dashboard. Gli URL dei servizi vengono riscritti verso il mock in memoria.

## Motore delle espressioni: alternative valutate
| Opzione | Esito |
|---|---|
| **jackson-jq 1.6.5 con built-in caricate** | **scelta**: copre tutte le espressioni generate, stessa semantica di Quarkus Flow. Manca solo `IN`, che l'exporter già evita |
| jackson-jq 2.0.0-alpha1 | scartata: alpha, basata su Jackson 3 (`tools.jackson`) |
| `com.arakelian:java-jq` (jq nativo via JNA) | jq al 100%, ma con binari nativi da distribuire e approvare. È l'alternativa se servisse un jq completo: basta implementare `ExpressionEngine` |
| `serverlessworkflow-impl-jq` | è il wrapper usato da Quarkus Flow sopra la stessa jackson-jq: non aggiunge copertura |
| JSONata, CEL, GraalJS, JsonPath | scartate: cambiano il linguaggio delle espressioni (`evaluate.language`), quindi exporter da riscrivere e niente compatibilità con Quarkus Flow |

## Limiti
- **Nessun cluster reale:** provato su ambiente Temporal di test (in memoria e via gRPC). Non su un cluster Temporal o Temporal Cloud, né sotto carico.
- **Kafka:** consumer per le callback e produttore per `emit` non inclusi; ci sono le interfacce (signal `event`, `EventActivitiesImpl` con publisher sostituibile).
- **Sicurezza:** nessuna autenticazione verso i servizi (`call.with.endpoint.authentication` non supportato) e nessun TLS verso Temporal.
- **Manutenzione:** l'interprete è codice vostro. Gli scenari e i test di perimetro sono la rete di sicurezza per ogni modifica.
- **Evoluzione dell'interprete:** cambiare il codice con pratiche in corso richiede il versioning di Temporal (patching o Worker Versioning). Cambiare un'**offerta** no: è un dato.

## File
```text
src/main/java/it/sim/temporal/
  expr/        ExpressionEngine, JqExpressionEngine, Expressions (valutazione ${ }, determinismo)
  dsl/         DefinitionValidator (perimetro), WorkflowError (Problem Details), Durations
  workflow/    OfferInterpreterWorkflow (+Impl), Interpreter (semantica DSL), RunRequest, RunResult
  activities/  HttpActivities, DefinitionActivities + DefinitionRepository (cartella, memoria), EventActivities
  app/         InterpreterWorker (main), Cli (main: start, event, context), OfferOutcome, Settings
examples/      definizione demo con callback, input e evento per la CLI
```
