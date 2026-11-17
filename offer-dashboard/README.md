# Offer Process Designer — prototipo

Prototipo statico (HTML/CSS/JS, nessun build) della dashboard per configurare il processo di vendita di un'offerta composta da 1..N prodotti. Produce un **Execution Plan** (JSON + vista leggibile) da consegnare ai team che sviluppano i servizi di backend / il motore di processo.

## Avvio
Apri `index.html` con doppio click (Edge/Chrome). Non serve un server: i dati sono salvati nel `localStorage` del browser.
Al primo avvio vengono caricati i dati demo (prodotti Conto, Evo, Lib Min, TIM; task Oracolo, Oracolo 2, Pregiudizievoli, Cribis, ...; offerta d'esempio ricostruita dallo schizzo). "↺ Reset demo" li ripristina.

## Le due dashboard
| Pagina | Scopo |
|---|---|
| `catalog.html` — Catalogo prodotti & task | Definizione dei prodotti e dei task riutilizzabili: ambito (common/verticale), sync/async, servizio (metodo + path), prodotti compatibili, step ammessi, input/output, esiti supportati (OK, KO, KO con task), estensioni pluggable, default (retry, coda task manuale, topic callback). |
| `index.html` — Configurazione offerta | Griglia **prodotti (righe) × step (colonne)** con i 5 step fissi: Verifiche Preliminari → Verifiche Verticali → Verifiche BO → Attivazioni → Post Attivazioni. |

## Funzionalità della configurazione offerta
- **Prodotti dinamici**: aggiungi/rimuovi/ordina i prodotti dell'offerta scegliendoli dal catalogo.
- **Blocchi (blu)**: trascina un task dalla palette
  - su una riga prodotto di uno step → blocco per quel prodotto (se lo step contiene già lo stesso task, il prodotto viene aggiunto al blocco condiviso; con **Alt** si crea un blocco separato);
  - sull'intestazione dello step → blocco condiviso su tutti i prodotti compatibili (es. Oracolo per Conto/Evo/Lib Min);
  - trascina un blocco esistente su un altro step per spostarlo.
- **Configurazione blocco** (pannello a destra): prodotti coinvolti, 1 chiamata per N prodotti vs 1 per prodotto, dipendenze "Esegui dopo" (sequenza nello step; senza dipendenze = parallelo), retry, mapping input sulla memoria condivisa della pratica, output, gestione esiti **OK / KO / KO con task manuale** (coda + SLA), notifiche mail, callback asincrona.
- **Barre regole (arancioni)** tra gli step, anche più di una per transizione. Regole:
  - *Non attendere: &lt;blocco&gt;* — si prosegue senza l'esito del blocco (es. Oracolo 2);
  - *Manda solo gli OK* — i prodotti KO escono, gli OK proseguono (default se non ci sono regole sui KO);
  - *Ferma tutto se ci sono KO* — opzionalmente limitato ad alcuni prodotti;
  - *Prosegui anche con KO*.
- **Validazione**: compatibilità task/prodotto, prodotti non in offerta, dipendenze circolari o tra step diversi, regole che puntano a blocchi inesistenti, input obbligatori non mappati, coda mancante per "KO con task", ecc. Gli errori sono evidenziati sui blocchi/barre.
- **Simulazione** (▶): scegli l'esito di ogni blocco per prodotto (OK, KO, KO + task, In attesa) e vedi come i prodotti avanzano, si fermano o restano in attesa ai gate, con log degli eventi. "🎲 Scenario casuale" genera esiti random.
- **Execution Plan** (⚙): quattro viste
  - *Vista leggibile* (stampabile);
  - *Albero*: l'offerta è la radice e si dirama in una corsia per prodotto; i blocchi condivisi congiungono più corsie e poi le ridiramano; i gate/milestone sono barre orizzontali arancioni che tagliano l'albero; le linee tratteggiate indicano esiti "non attesi". Scaricabile in SVG;
  - *Diagramma BPMN*: anteprima navigabile (bpmn-js) del processo Camunda 8 generato;
  - *Export motori*: file nativi per i motori di processo (vedi sotto), con anteprima, download e copia;
  - *JSON* e *YAML* (stesso contenuto), scaricabili e copiabili.
- **Esporta/Importa**: l'intera configurazione (cataloghi + offerte) in JSON.

## Export verso motori esistenti
Ogni exporter (`js/exporters/*.js`) legge **solo l'Execution Plan**: la dashboard non dipende dal motore e se ne possono aggiungere altri registrandoli con `Exporters.register({ id, label, notes, files(plan) })`. I file sono **scheletri importabili**: i worker/servizi vanno implementati (stream 1).

| Concetto | Camunda 8 (BPMN + DMN) | Flowable (CMMN + DMN) | Conductor (JSON) | Serverless Workflow 1.0 (YAML) | Temporal (YAML + interprete TS) |
|---|---|---|---|---|---|
| Step | sub-process | stage (autoComplete) | sequenza di task | task `do` | statement `step` |
| Blocchi paralleli | parallel gateway | plan item senza sentry tra loro | FORK_JOIN + JOIN | `fork` | `parallel` (Promise.all) |
| Esegui dopo | sequence flow | entry sentry | ordine | ordine in `do` | ordine in `sequence` |
| 1 chiamata per prodotto | multi-instance su `activeProducts` | repetition rule | INLINE + FORK_JOIN_DYNAMIC | `for` | `perProduct` |
| Retry | `zeebe:taskDefinition retries` | (campo documentato) | taskDef retryCount | try/catch + retry | retry policy activity |
| Task async (callback) | receive task + messaggio = topic | event listener + milestone | WAIT | `listen` | signal `callback` |
| KO con task | errore BPMN `KO_TASK` → user task (candidateGroups = coda) | human task | SWITCH → HUMAN | emit + listen | signal `manual-task-completed` |
| Barra arancione | business rule task (DMN `Gate_<STEP>`) + gateway; STOP → terminate | decision task → milestone / exit criterion | INLINE + SWITCH → TERMINATE / SET_VARIABLE | `switch` + `raise` + `set` | statement `gate` |
| Non attendere | ramo parallelo separato | plan item a livello di case | ramo FORK escluso da `joinOn` | `run: workflow` con `await: false` (sotto-workflow in file separato) | child workflow ABANDON |

Convenzioni comuni: variabile `activeProducts` (prodotti ancora in corsa), i worker restituiscono `outcome` e `productOutcomes { PRODOTTO: OK|KO|KO_TASK }`, i prodotti KO finiscono in `koProducts` che il gate valuta. Come usarli:
- **Camunda 8**: apri `.bpmn` e `.dmn` in Camunda Modeler / Web Modeler e deploya entrambi.
- **Flowable**: importa `.cmmn` e `.dmn` in Flowable Design/Modeler (o deploy via REST).
- **Conductor**: `POST /api/metadata/taskdefs` (array `taskDefs`) e `POST /api/metadata/workflow` (`workflowDef`).
- **Serverless Workflow**: file conformi allo schema DSL 1.0.0 (es. SonataFlow/Apache KIE).
- **Temporal**: `offer-interpreter.workflow.ts` si deploya una volta; ogni offerta è un nuovo YAML passato come input al workflow `offerInterpreterWorkflow`.

Verifiche eseguite sui file generati (demo + varianti + offerta vuota): BPMN/DMN/CMMN letti senza avvisi con bpmn-moddle (+ estensioni Zeebe), dmn-moddle e cmmn-moddle e visualizzati con bpmn-js/cmmn-js; Serverless Workflow valido contro lo JSON Schema ufficiale 1.0.0; controlli strutturali Conductor; interprete TS compilato con `tsc --strict` e `@temporalio/workflow`. Non è stato provato su motori in esecuzione.

## Struttura dell'Execution Plan (JSON / YAML)
```text
planVersion, generatedAt
offer { id, name, description }
products [ { id, name, category } ]
summary { products, activities, services, gates, valid }
steps [
  { order, stepId, name,
    stages [ { stage, execution: SINGLE|PARALLEL,
      activities [ { activityId, taskId, taskName, service {method,path},
        executionType: SYNC|ASYNC_CALLBACK,
        invocation { mode: SINGLE_CALL_FOR_N_PRODUCTS|ONE_CALL_PER_PRODUCT, calls },
        products[], dependsOn[], input[{name,required,source}], output[{name,target}],
        retry {maxAttempts,intervalSec},
        outcomes { OK, KO, KO_WITH_TASK {queue, slaHours} },
        notification?, async {callbackTopic,timeoutHours}?, extensionPoints? } ] } ],
    exitGate { to, gates[{gateId, rules[]}],
      effectivePolicy { waitFor[], dontWait[], stopOnKo, koProducts: EXCLUDE|CONTINUE, description[] } } }
]
servicesToDevelop [ { taskId, name, service, scope, executionType, inputs, outputs, outcomes, extensionPoints, usedIn[] } ]
validation { errors[], warnings[], infos[] }
```

## Semantica dei gate (usata da simulazione ed Execution Plan)
1. Si attendono gli esiti di tutti i blocchi dello step, tranne quelli marcati *Non attendere*. Un esito "In attesa" o "KO con task" (task manuale aperto) blocca la transizione.
2. Se c'è *Ferma tutto se ci sono KO* e un prodotto nel suo perimetro è KO, l'intera offerta si ferma.
3. Altrimenti i prodotti KO vengono esclusi (*Solo OK*, default) oppure proseguono (*Prosegui anche con KO*).
4. Un blocco che dipende da un blocco KO non viene eseguito per quel prodotto.

## File
```text
index.html, catalog.html
css/styles.css
js/seed.js            dati demo
js/store.js           Util (DOM, toast, modal), Model (dominio), Store (localStorage, import/export)
js/validation.js      controlli di coerenza
js/simulator.js       motore di simulazione
js/execution-plan.js  generazione e rendering dell'Execution Plan
js/exporters/         common (registry, YAML, util), bpmn, dmn, cmmn, conductor, serverless, temporal
js/vendor/bpmn-js/    bpmn-js viewer 18.33 (bpmn.io license, il logo deve restare visibile)
js/offer.js           UI configurazione offerta
js/catalog.js         UI catalogo
```
