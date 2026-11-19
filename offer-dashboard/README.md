# BPM AI Offer Designer — prototipo

Prototipo statico (HTML/CSS/JS, nessun build) della dashboard per configurare il processo di vendita di un'offerta composta da 1..N prodotti. Produce un **Execution Plan** (JSON + vista leggibile) da consegnare ai team che sviluppano i servizi di backend / il motore di processo.

## Avvio
Apri `index.html` con doppio click (Edge/Chrome). Non serve un server: i dati sono salvati nel `localStorage` del browser.
Al primo avvio vengono caricati i dati demo (prodotti Conto, Evo, Lib Min, TIM; task Oracolo, Oracolo 2, Pregiudizievoli, Cribis, ...; offerta d'esempio ricostruita dallo schizzo). "↺ Reset demo" li ripristina.

## Le pagine
| Pagina | Scopo |
|---|---|
| `catalog.html` — Catalogo prodotti & task | Definizione dei prodotti e dei task riutilizzabili: ambito (common/verticale), sync/async, servizio (metodo + path), prodotti compatibili, step ammessi, input/output, esiti supportati (OK, KO, KO con task), estensioni pluggable, default (retry, coda task manuale, topic callback). |
| `index.html` — Configurazione offerta | Griglia **prodotti (righe) × step (colonne)** con i 5 step fissi: Verifiche Preliminari → Verifiche Verticali → Verifiche BO → Attivazioni → Post Attivazioni. Due tab: **Visuale** e **DSL**; per le offerte generate dall'agente compare anche **JSON modello** (sola lettura). |
| `generate.html` — Genera da specifiche | Caricamento di un file di specifiche (Markdown/testo): l'agente AI propone l'offerta, che si apre nella dashboard. Richiede il backend [offer-agent](../offer-agent/README.md). |

## Generazione da specifiche (agente AI)
Flusso: carica il file → l'agente genera la **configurazione dell'offerta** (non il DSL) → validazione e correzione automatica → esito.
- **SUCCESS:** la dashboard si apre sull'offerta generata.
- **WARNING:** la dashboard si apre con un banner che elenca gli avvisi: assunzioni dell'agente su punti ambigui, richieste fuori catalogo, avvisi di validazione. "Segna come verificati" li chiude.
- **ERROR:** la dashboard non si apre; la pagina mostra errori e tentativi e nessuna offerta viene aggiunta.

Il DSL viene poi generato dalla dashboard come sempre. Dettagli, modello e limiti sono in [offer-agent](../offer-agent/README.md). Per usare la generazione aprire la dashboard servita dal backend (`http://localhost:8090/`).

**Tab JSON modello (sola lettura).** Le offerte generate conservano la risposta JSON del modello (`{ offer, assunzioni }`, mai il testo delle specifiche), consultabile, copiabile e scaricabile. È uno snapshot di provenienza per capire cosa ha prodotto l'AI: non si modifica e non segue le modifiche successive. La fonte di verità resta la dashboard, cioè il DSL.

**Tema.** Testata gialla con testo blu (`--poste-yellow` `#EEDC00`, `--poste-blue` `#0445B8`, ricavati dal sito Poste) in `css/styles.css`; la parte centrale (griglia, blocchi, barre, pannelli, albero) mantiene la palette originale blu/arancione.

## Tab DSL (sincronizzazione nei due sensi)
- **Dashboard → DSL:** ogni modifica visuale rigenera il DSL (Serverless Workflow 1.0, lo stesso del target Temporal).
- **DSL → dashboard:** "Applica alla dashboard" (Ctrl+S) ricostruisce l'offerta dal DSL. Funziona sul **DSL canonico**, cioè quello prodotto dalla dashboard, che porta nei `metadata` ciò che serve a ricostruire l'offerta:
  - si possono modificare `document.title` (nome), `document.metadata.offer` (id, descrizione, prodotti), `metadata.block` di ogni blocco (prodotti, dipendenze, configurazione), `metadata.gates` delle barre (regole) e il retry nel corpo (`catch.retry`);
  - il resto del corpo è generato. Una modifica lì che non corrisponde alla forma canonica viene **rifiutata con il punto esatto** (es. `/do/1/step-preliminari/…/endpoint/uri`) e resta come bozza: la scheda DSL mostra `•` finché non la applichi o la scarti;
  - una modifica ai metadata riscrive il corpo di conseguenza: ad esempio cambiare `koTask.queue` aggiorna anche l'evento di richiesta del task.
- "Esporta DSL" scarica il workflow principale e gli eventuali sotto-workflow ("Non attendere"), da pubblicare per [temporal-offer-interpreter](../temporal-offer-interpreter/README.md).

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

| Concetto | Camunda 8 (BPMN + DMN) | Flowable (CMMN + DMN) | Conductor (JSON) | Serverless Workflow 1.0 (YAML) | Temporal (Serverless 1.0 + interprete Java) |
|---|---|---|---|---|---|
| Step | sub-process | stage (autoComplete) | sequenza di task | task `do` | task `do` |
| Blocchi paralleli | parallel gateway | plan item senza sentry tra loro | FORK_JOIN + JOIN | `fork` | `fork` (thread del workflow Temporal) |
| Esegui dopo | sequence flow | entry sentry | ordine | ordine in `do` | ordine in `do` |
| 1 chiamata per prodotto | multi-instance su `activeProducts` | repetition rule | INLINE + FORK_JOIN_DYNAMIC | `for` | `for` |
| Retry | `zeebe:taskDefinition retries` | (campo documentato) | taskDef retryCount | try/catch + retry | try/catch + retry (timer durevole tra i tentativi) |
| Task async (callback) | receive task + messaggio = topic | event listener + milestone | WAIT | `listen` | `listen` (evento ricevuto come signal `event`, in coda finché non consumato) |
| KO con task | errore BPMN `KO_TASK` → user task (candidateGroups = coda) | human task | SWITCH → HUMAN | emit + listen | emit (activity) + listen |
| Barra arancione | business rule task (DMN `Gate_<STEP>`) + gateway; STOP → terminate | decision task → milestone / exit criterion | INLINE + SWITCH → TERMINATE / SET_VARIABLE | `switch` + `raise` + `set` | `switch` + `raise` + `set` |
| Non attendere | ramo parallelo separato | plan item a livello di case | ramo FORK escluso da `joinOn` | `run: workflow` con `await: false` (sotto-workflow in file separato) | `run: workflow` → child workflow con ParentClosePolicy ABANDON (non attende davvero) |

Convenzioni comuni: variabile `activeProducts` (prodotti ancora in corsa), i worker restituiscono `outcome` e `productOutcomes { PRODOTTO: OK|KO|KO_TASK }`, i prodotti KO finiscono in `koProducts` che il gate valuta. Come usarli:
- **Camunda 8**: apri `.bpmn` e `.dmn` in Camunda Modeler / Web Modeler e deploya entrambi.
- **Flowable**: importa `.cmmn` e `.dmn` in Flowable Design/Modeler (o deploy via REST).
- **Conductor**: `POST /api/metadata/taskdefs` (array `taskDefs`) e `POST /api/metadata/workflow` (`workflowDef`).
- **Serverless Workflow**: file conformi allo schema DSL 1.0.0; runtime per la 1.0: Quarkus Flow 1.3.0 (provato, vedi sotto), reference implementation del Java SDK 7.x o Lemline (SonataFlow/Apache KIE supporta solo la 0.8). Prova su Quarkus Flow: [quarkus-flow-sim](../quarkus-flow-sim/README.md).
- **Temporal**: il target emette lo stesso Serverless Workflow 1.0 di Quarkus Flow. Si esegue con [temporal-offer-interpreter](../temporal-offer-interpreter/README.md): un server Temporal e un worker Java generico, che si deploya una volta; ogni offerta è un nuovo YAML passato come input, senza redeploy.

Verifiche eseguite sui file generati (demo + varianti + offerta vuota): BPMN/DMN/CMMN letti senza avvisi con bpmn-moddle (+ estensioni Zeebe), dmn-moddle e cmmn-moddle e visualizzati con bpmn-js/cmmn-js; Serverless Workflow valido contro lo JSON Schema ufficiale 1.0.0 **ed eseguito su Quarkus Flow 1.3.0** (9 scenari su 10 identici al simulatore, vedi `../quarkus-flow-sim`); controlli strutturali Conductor. Camunda, Flowable e Conductor non sono stati provati su motori in esecuzione. Il target Temporal è stato **eseguito dal worker Java** (vedi `../temporal-offer-interpreter`): gli stessi 10 scenari, tutti identici al simulatore incluso "Non attendere", più l'offerta demo completa con callback e "KO con task"; ambiente Temporal di test (in memoria e via gRPC), non un cluster Temporal di produzione.

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

## Test
```powershell
node --test tests/     # 10 test: andata e ritorno offerta ⇄ DSL (offerte demo + 300 casuali), modifiche ammesse e rifiutate
```
Nessuna dipendenza: gli script della dashboard vengono caricati in un contesto Node isolato (`tests/harness.js`).

## File
```text
index.html, catalog.html, generate.html
css/styles.css
schema/offer-generation.schema.json   contratto della risposta dell'agente (offerta + assunzioni)
js/seed.js            dati demo
js/store.js           Util (DOM, toast, modal), Model (dominio, forma canonica), Store (localStorage, import/export)
js/validation.js      controlli di coerenza
js/simulator.js       motore di simulazione
js/execution-plan.js  generazione e rendering dell'Execution Plan
js/exporters/         common (registry, YAML, util), bpmn, dmn, cmmn, conductor, serverless (con metadata canonici), temporal (riusa serverless)
js/dsl-import.js      DSL canonico → offerta (tab DSL; usato anche dal backend)
js/generate.js        UI generazione da specifiche
js/vendor/bpmn-js/    bpmn-js viewer 18.33 (bpmn.io license, il logo deve restare visibile)
js/vendor/js-yaml/    js-yaml 4.1.0 (MIT), parser YAML del tab DSL
js/offer.js           UI configurazione offerta (tab Visuale e DSL)
js/catalog.js         UI catalogo
tests/                test Node (andata e ritorno DSL)
```
