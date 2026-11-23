# BPM AI Offer Designer — prototipo

Prototipo statico (HTML/CSS/JS, nessun build) della dashboard per configurare il processo di vendita di un'offerta composta da 1..N prodotti. Produce un **Execution Plan** (JSON + vista leggibile) da consegnare ai team che sviluppano i servizi di backend / il motore di processo.

## Avvio
Apri `generate.html` con doppio click (Edge/Chrome). Non serve un server per la dashboard: i dati sono salvati nel `localStorage` del browser. La generazione da specifiche richiede invece il backend [offer-agent](../offer-agent/README.md), che serve la dashboard e apre `generate.html` alla radice (`/`).
Al primo avvio vengono caricati i dati demo (prodotti Conto, Evo, Lib Min, TIM; task Oracolo, Oracolo 2, Pregiudizievoli, Cribis, ...; tre offerte: il bundle ricostruito dallo schizzo, «Solo Conto» e **«Demo»**, che mostra insieme blocchi paralleli impilati, blocchi «SE …», liste in input e output, condizioni su liste, rami paralleli, gate di un solo ramo e join, ritorno indietro / salto / stop dai gate, KO con task, Non attendere e callback). "↺ Reset demo" li ripristina: chi ha già dati salvati nel browser deve premerlo per vedere l'offerta nuova.

## Le pagine
Nell'ordine del flusso di lavoro (barra in alto). La pagina di configurazione usa tutta la larghezza per la timeline: i task del catalogo sono una barra di chip trascinabili sopra la griglia e i dettagli di blocco/gate stanno in un pannello in basso. Entrambi si comprimono (la preferenza resta salvata nel browser); il pannello si apre da solo alla selezione di un blocco o di un gate e si ridimensiona trascinandone il bordo superiore.

| Pagina | Scopo |
|---|---|
| `generate.html` — Genera da specifiche | **1.** Caricamento di un file di specifiche (Markdown/testo): l'agente AI propone l'offerta, che si apre nella dashboard. Richiede il backend [offer-agent](../offer-agent/README.md). |
| `index.html` — Configurazione offerta | **2.** Griglia libera **prodotti (righe) × ordine di esecuzione (colonne)**, senza step fissi: blocchi e gate sono mattoncini collegati da «Dopo»; le colonne si calcolano dalle dipendenze. Viste nel toggle: **Visuale**, **Grafo** e **Diagramma DSL** (sola lettura, a tutta pagina); per le offerte generate dall'agente compare anche **JSON modello** (sola lettura). In alto: **Valida**, **Simulazione** ed **Execution Plan**. |
| `catalog.html` — Catalogo prodotti & task | **3.** Definizione dei prodotti e dei task riutilizzabili: sync/async, servizio (metodo + path), prodotti compatibili, input/output, esiti supportati (OK, KO, KO con task), estensioni pluggable, default (retry, coda task manuale, topic callback). |

## Generazione da specifiche (agente AI)
Flusso: carica il file → l'agente genera la **configurazione dell'offerta** (non il DSL) → validazione e correzione automatica → esito.
- **SUCCESS:** la dashboard si apre sull'offerta generata.
- **WARNING:** la dashboard si apre con un banner che elenca gli avvisi: assunzioni dell'agente su punti ambigui, richieste fuori catalogo, avvisi di validazione. "Segna come verificati" li chiude.
- **ERROR:** la dashboard non si apre; la pagina mostra errori e tentativi e nessuna offerta viene aggiunta.

Il DSL viene poi generato dalla dashboard come sempre. Dettagli, modello e limiti sono in [offer-agent](../offer-agent/README.md). Per usare la generazione aprire la dashboard servita dal backend (`http://localhost:8090/`).

**Tab JSON modello (sola lettura).** Le offerte generate conservano la risposta JSON del modello (`{ offer, assunzioni }`, mai il testo delle specifiche), consultabile, copiabile e scaricabile. È uno snapshot di provenienza per capire cosa ha prodotto l'AI: non si modifica e non segue le modifiche successive. La fonte di verità resta la dashboard: il DSL si genera da lì e non si rilegge.

**Tema.** Testata gialla con testo blu (`--poste-yellow` `#EEDC00`, `--poste-blue` `#0445B8`, ricavati dal sito Poste) in `css/styles.css`; la parte centrale (griglia, blocchi, gate, pannelli, grafo) mantiene la palette originale blu/arancione.

## DSL (sola lettura, nell'Execution Plan)
- **Dashboard → DSL:** ogni modifica visuale rigenera il DSL (Serverless Workflow 1.0, lo stesso del target Temporal). La scheda **DSL** dell'Execution Plan è di sola lettura: per cambiare il DSL si modifica l'offerta nella vista visuale. Non esiste il percorso inverso DSL → dashboard.
- "Esporta DSL" scarica il workflow principale e gli eventuali sotto-workflow ("Non attendere"), da pubblicare per [temporal-offer-interpreter](../temporal-offer-interpreter/README.md).
- I `metadata` del DSL (offerta, blocchi, gate) sono solo annotazioni leggibili: nessuno strumento li rilegge.

## Funzionalità della configurazione offerta
- **Prodotti dinamici**: aggiungi/rimuovi/ordina i prodotti dell'offerta scegliendoli dal catalogo.
- **Blocchi (blu)**: trascina un task dalla palette su una **riga prodotto**:
  - parte **dopo il nodo che lo precede su quella riga** (il blocco o gate più vicino a sinistra); se la riga è vuota parte all'inizio, in parallelo agli altri nodi senza dipendenze. Rilasciato nell'ultima colonna («＋ in coda») va in fondo alla riga;
  - se nella stessa colonna c'è già lo stesso task su un altro prodotto, il prodotto viene aggiunto al blocco condiviso (con **Alt** si crea un blocco separato);
  - trascina un blocco esistente su un'altra riga/colonna per cambiare da chi dipende, oppure su un prodotto che non ha per aggiungerlo.
  - **Griglia libera:** non ci sono step. Le colonne sono i livelli di esecuzione calcolati dalle dipendenze ("Dopo"): nodi nella stessa colonna sono paralleli e, se condividono righe prodotto, si impilano uno sopra l'altro (la riga del prodotto si allarga). In quelle righe un blocco su più prodotti è disegnato con una scheda per riga («↑ stesso blocco»).
  - **Prodotti non adiacenti:** se un blocco è su prodotti non contigui (es. Conto e Lib Min, senza Evo) viene disegnato come una scheda per ogni gruppo di righe adiacenti, unite da un riquadro tratteggiato che occupa solo le righe vuote dei prodotti esclusi. «1 chiamata × N» indica il numero reale di prodotti. Cliccando un segmento si seleziona tutto il blocco.
  - Passando il mouse su un task del catalogo compare un tooltip con descrizione, modalità e prodotti compatibili (in verde quelli presenti nell'offerta).
- **Configurazione blocco** (pannello in basso): prodotti coinvolti, 1 chiamata per N prodotti vs 1 per prodotto, **Dopo** (da quali nodi dipende: nessuno = parte subito; più nodi = join), retry, mapping input sulla memoria condivisa della pratica, output, gestione esiti **OK / KO / KO con task manuale** (coda + SLA), notifiche mail, callback asincrona. «⛩ Gate dopo» inserisce un gate subito dopo il blocco.
- **Gate (arancioni)**: mattoncini opzionali del grafo, non più barre obbligatorie tra gli step. Si trascinano dalla palette (⛩ Gate) o si aggiungono dal pannello di un blocco/gate. Un gate con **un solo nodo in «Dopo»** vale per quel ramo; con **più nodi** è un **join** che riunisce i rami (alto quanto i nodi a cui è collegato, cioè sulle righe prodotto di quei blocchi). Senza gate un KO arriva solo ai nodi che dipendono dal blocco KO. Regole:
  - *Non attendere: &lt;blocco&gt;* — il gate non aspetta l'esito di quel blocco (deve essere uno dei collegati e non avere altri dipendenti), es. Oracolo 2;
  - *Manda solo gli OK* — i prodotti KO restano fuori da ciò che segue il gate (default se non ci sono regole sui KO);
  - *Ferma tutto se ci sono KO* — opzionalmente limitato ad alcuni prodotti;
  - *Prosegui anche con KO* — i prodotti KO ripartono;
  - *Instrada se…* — vedi sotto.
- **Blocchi condizionali (`SE …`)**: nel pannello del blocco la sezione «Condizione» fa eseguire il blocco solo se la condizione è vera. Il blocco è disegnato con bordo tratteggiato e badge «SE …».
  - Ogni clausola è `riferimento · operatore · valore`, unite da *tutte (E)* o *una (OPPURE)*. Riferimenti: campi della pratica, output di un blocco già eseguito (`esiti.<blocco>.<campo>`), esito di un blocco (`esito.<blocco>` = OK/KO), `offerta.prodotti` (es. «contiene CONTO») e `prodotto.id` (nei blocchi «1 chiamata per prodotto», dove la condizione vale per ciascun prodotto). Operatori: uguale, diverso, `>` `≥` `<` `≤`, è uno tra, non è uno tra, contiene, non contiene, è valorizzato, non è valorizzato. Niente testo libero: la stessa struttura è valutata dal simulatore e tradotta in jq nel DSL.
  - Un blocco saltato dalla condizione **non è un KO**: non blocca il gate e i blocchi che dipendono da lui partono comunque.
  - Diramazione A oppure B: due blocchi con condizioni opposte. «↔ Crea il ramo Altrimenti» duplica il blocco con la condizione negata.
- **Instradamento dei gate (`Instrada se…`)**: una regola del gate ha una condizione (stessi riferimenti, `esito.<blocco>` = KO se almeno un prodotto è andato KO) e una destinazione, che è un **blocco o gate della sequenza principale** (i nodi fuori dai rami paralleli):
  - **torna a un nodo** precedente (anche il gate stesso) per ripetere il tratto: serve il massimo di ritorni (1-10, default 3) e cosa fare oltre il massimo (ferma l'offerta, oppure prosegui con le altre regole). Si valuta **prima** delle altre regole del gate e riesegue anche i prodotti KO; i KO dei nodi rieseguiti vengono azzerati;
  - **salta a un nodo successivo**: si valuta dopo le regole sui KO, per i prodotti che passano il gate; i nodi saltati lasciano passare ciò che il gate ha lasciato passare;
  - **ferma l'offerta** (anche dai gate dentro un ramo).
  - Ritorno e salto valgono solo per i gate della sequenza principale: nel DSL un `then` non può uscire da un `fork`. La validazione lo segnala.
  - Le regole di instradamento si provano nell'ordine; vince la prima vera. Nel DSL sono `switch` con `then` verso task fratelli e un contatore `loops` nel contesto; i task di ritorno stanno in fondo al `do`.
- **Validazione**: compatibilità task/prodotto, prodotti non in offerta, dipendenze circolari, **grafi non esprimibili nel DSL** (rami che si incrociano: aggiungi un gate join), regole che puntano a nodi inesistenti, input obbligatori non mappati, coda mancante per "KO con task", condizioni con riferimenti non disponibili (blocco non a monte, `prodotto.id` fuori da un blocco per prodotto, valore mancante), instradamenti senza destinazione, fuori dalla sequenza principale o con massimo non valido, ecc. Gli errori sono evidenziati sui blocchi/gate.
- **Simulazione** (▶, nella barra in alto accanto a Execution Plan; dal Grafo riporta alla vista Visuale): scegli l'esito di ogni blocco per prodotto (OK, KO, KO + task, In attesa) e vedi come i prodotti avanzano, si fermano o restano in attesa, con il verdetto di ogni gate e il log degli eventi. "🎲 Scenario casuale" genera esiti random. Se l'offerta ha condizioni compare «Dati dello scenario» (JSON `{ practice, outputs }` con i campi letti dalle condizioni, da compilare); se ha ritorni indietro, «dopo un ritorno: tutto OK» simula la correzione del problema (altrimenti gli stessi esiti si ripetono a ogni giro, fino al massimo).
- **Execution Plan** (⚙): due schede
  - *Vista leggibile* (stampabile), con sequenze, rami paralleli, gate, condizioni e instradamenti;
  - *DSL*: il workflow principale e i sotto-workflow, con copia ed «Esporta DSL».
- **Grafo** (toggle Visuale / Grafo): inizio → blocchi → gate (rombi) → fine, in colonne per livello di esecuzione (stessa colonna = parallelo). Archi: sequenza, «non attesa» tratteggiata, condizioni dei blocchi (`SE …`), ritorni indietro e salti in avanti etichettati con la condizione, stop. Filtro per prodotto, clic su un nodo per evidenziare i collegamenti, zoom, scaricabile in SVG.
- **Diagramma DSL** (toggle): il DSL generato disegnato dal **viewer ufficiale Open Workflow** (@openworkflowspec/diagram-editor, sola lettura), con un selettore per i sotto-workflow e uno per il tema (chiaro, scuro, come il sistema; la scelta resta salvata nel browser). Mostra il workflow così come lo vede un motore (task <blocco>-run/-settle, 	ry/catch, or, ork, switch), quindi è molto più dettagliato e lungo del «Grafo» della dashboard; zoom con la rotella o i pulsanti, trascina per spostarti. È in un iframe perché il suo CSS ha un reset globale. Il bundle è già nel repo (js/vendor/open-workflow-editor/, circa 2,4 MB, con licenze) e si carica solo aprendo la scheda; si rigenera con 	ools/open-workflow-viewer (vedi il suo README). Se il grafo dell'offerta non è valido compare il messaggio al posto del diagramma.
- **Rami e join:** un nodo con «Dopo» continua il ramo del suo genitore: `Cribis → A` e `Pregiudizievoli → B` sono due rami indipendenti (A non aspetta Pregiudizievoli), anche con più figli (rami che si aprono). Un gate (o blocco) che dipende da più nodi li riunisce. Il DSL è fatto di sequenze e `fork` annidati, quindi il grafo deve ridursi a **serie/parallelo**: un join può raccogliere tutti i rami di un gruppo (o un sotto-gruppo), ma non due rami che si incrociano (A→C, A→D, B→D). **Corsie:** ogni ramo ha la propria corsia (sotto-riga della riga prodotto) e un figlio sta sulla corsia del genitore, con la stessa altezza; un **join** è marcato «⋈ JOIN» e si allunga sulle corsie dei suoi genitori se sono libere nella sua colonna, altrimenti sta sulla prima corsia libera. **Selezionando un nodo** gli altri sbiadiscono, i genitori hanno il bordo arancione e i figli il bordo verde; le colonne si allargano per lasciare spazio a frecce a gomito sottili (arancioni dai genitori, verdi verso i figli, con un pallino all'origine). Un avviso segnala i prodotti del blocco che il genitore non copre.
- **Esporta/Importa**: l'intera configurazione (cataloghi + offerte + modello della pratica) in JSON. Le offerte salvate con il vecchio modello a step si convertono da sole al caricamento (ogni step diventa i suoi blocchi più un gate join con le regole delle sue barre; gli instradamenti puntano al primo blocco dello step di destinazione, da correggere se serve).

## Dati: pratica, input e output dei task
I task possono avere decine di campi (fino a ~100). Il flusso dei dati è modellato così:
- **Modello della pratica** (Catalogo → *Modello della pratica*): i dati con cui parte il processo, con percorso (`cliente.documento.numero`), tipo, obbligatorietà e descrizione. Si importa incollando un **JSON Schema** (anche con `$ref` locali; da un OpenAPI serve lo schema del body, non l'intero documento) o un **JSON di esempio**; si può ricavare dai percorsi già usati nei task e scaricare come JSON Schema. `pratica.id` c'è sempre (correlazione degli eventi). Nel DSL diventa lo **schema di input** del workflow.
- **Input/output dei task**: ogni campo ha nome (percorso con il punto = oggetto annidato nel body), tipo e descrizione; tabelle con filtro e import da JSON Schema/esempio.
- **Mappatura input (pannello blocco)**: per ogni input una sorgente scelta da un elenco filtrato per blocco — campo della pratica, `esiti.<blocco>.<campo>` (output di un blocco **già eseguito**: a monte nel grafo, cioè raggiungibile risalendo i «Dopo»), sorgente di sistema (`offerta.prodotti`, `prodotto.id`) o valore fisso. Ogni riga ha lo stato (✔ risolto, ＝ valore fisso, ⚠ avviso, ✖ errore, ○ vuoto); filtro, «solo non mappati» e **⚡ Mappa automaticamente** (per nome, solo se univoco).
- **Output per prodotto**: un blocco "1 chiamata per prodotto" salva il risultato anche in `esitiByProduct[blocco][prodotto]`; un blocco per prodotto che lo consuma legge quello del proprio prodotto, uno per offerta riceve la lista dei risultati.
- **Validazione**: output o blocco inesistente, blocco non ancora eseguito, percorso assente dal modello della pratica, input obbligatorio senza sorgente, liste senza origine o con la riga della lista mancante nel catalogo.
- Limiti: nessuna trasformazione o conversione di tipo tra output e input, nessun merge di più sorgenti in un campo, nessuna iterazione "una chiamata per ogni elemento" (le liste viaggiano dentro una sola chiamata), l'esito resta per prodotto e non per elemento.

### Liste (array) in input e output
- **Campi lista:** `spedizioni[].destinatario.cap` è il campo `destinatario.cap` di ogni elemento della lista `spedizioni` (anche annidate: `spedizioni[].colli[].peso`). Un array di valori (`tags`) resta un campo unico di tipo `array`. L'import da JSON Schema (`items`, `$ref`) o da un esempio (unione dei campi di tutti gli elementi) crea i campi `x[].y`; lo schema di input del workflow ha gli `items`.
- **Input di un task con liste:** nel catalogo si dichiara la **riga della lista** (`spedizioni[]`, tipo `array`) con l'origine di default e i campi dell'elemento (`spedizioni[].cap`). Nel pannello del blocco l'origine decide quanti elementi ha la lista:
  - `offerta.prodotti` → **un elemento per ogni prodotto del blocco** («1 chiamata per N prodotti» con i dati di ogni prodotto); dentro: `prodotto.id` e `prodotti.{prodotto}.campo` (il dato di quel prodotto nella pratica, es. `prodotti.TIM.msisdn`);
  - un campo lista della pratica (`pratica.spedizioni[]`) o l'output lista di un blocco già eseguito (`esiti.<blocco>.righe[]`) → **un elemento per ogni elemento**; dentro: `@.campo` (campo dell'elemento, `@.colli[]` per una sotto-lista), oltre a qualsiasi sorgente globale o valore fisso;
  - riga della lista senza campi → la lista viene passata così com'è.
  - Un input singolo può ricevere una **proiezione** (`pratica.spedizioni[].destinatario.cap` = lista dei CAP) o `x[@]`.
  Il pannello mostra la «Struttura del body inviato» con un elemento d'esempio. Il body è costruito in jq nel DSL; per le GET le liste vanno in query come JSON.
- **Output: lista risultati per prodotto.** Un task può dichiarare (catalogo → Output) che la risposta contiene una lista con un risultato per prodotto: lista, campo prodotto, campo esito, valori di esito OK e KO con task (ogni altro valore = KO). Il DSL ricava da lì `productOutcomes` (se la risposta non contiene la lista resta quello del servizio). I blocchi successivi leggono `esiti.<blocco>.risultati[].campo` (tutti gli elementi) oppure `esiti.<blocco>.risultati[@].campo` (l'elemento del **prodotto corrente**, in un blocco «1 chiamata per prodotto» o dentro una lista di prodotti).
- **Condizioni su liste:** sui riferimenti con `[]` gli operatori sono *almeno uno è uguale / diverso*, *tutti sono uguali*, *nessuno è uguale*, *numero elementi* (= ≠ > ≥ < ≤), *valorizzato / non valorizzato*.
- **Demo:** Oracolo riceve `prodotti[].id` e restituisce `risultati[]` per prodotto; la Presa in carico BO invia `documenti[]` presi da `pratica.documenti[]`.

## Export DSL
L'unico formato di uscita è il **DSL Serverless Workflow 1.0** (YAML), prodotto dall'exporter `js/exporters/serverless.js` a partire dall'Execution Plan (`temporal.js` lo riusa). Il piano è la sola fonte dell'exporter: la dashboard non dipende dal motore.

| Concetto | Serverless Workflow 1.0 / Temporal |
|---|---|
| Sequenza ("Dopo" con un solo nodo) | task in fila nello stesso `do` |
| Rami paralleli (stesso genitore o nessuna dipendenza) | `fork` (anche annidati), ogni ramo è un task o un `do` di task |
| Blocco | task `<id>` = `do` con `<id>-run` (chiamata/for/listen, con `if` se condizionato) e `<id>-settle` (registra i prodotti KO/esclusi) |
| 1 chiamata per prodotto | `for` sui prodotti ancora in corsa |
| Retry | try/catch + retry (su Temporal: timer durevole tra i tentativi) |
| Task async (callback) | `listen` |
| KO con task | emit + listen |
| Gate (join o di ramo) | task nel `do` del suo ramo: `gate-<id>-apply` (`set` + `export`: scrive in `dead[<id>]` i prodotti KO, o `[]` se «Prosegui anche con KO»); STOP su KO = `raise` con `if` (`gate-<id>-stop`) |
| Non attendere | `run: workflow` con `await: false` (sotto-workflow in file separato); su Temporal child workflow abbandonato |
| Blocco condizionale (SE …) | `if` sul `run` del blocco (dentro il `for` per i blocchi per prodotto, dove esiste `$product`) |
| Instrada: torna a un nodo | `gate-<id>-route`: `switch` con caso `condizione e giri < max` → `then: gate-<id>-go-N`; il task `go` aggiorna `loops`, azzera `dead`/`koByBlock` dei nodi da rieseguire e fa `then: <nodo>`. I task `go` stanno in fondo al `do` principale |
| Instrada: salta avanti / ferma | `gate-<id>-skip` dopo `gate-<id>-apply` (`then: gate-<id>-skip-go-N`, che copia i prodotti del gate nei nodi saltati); STOP → `then: offer-stopped` (nei rami: `raise` con `if`) |

Convenzioni: `offerProducts` (prodotti dell'offerta), `dead[<nodo>]` (prodotti KO o esclusi dopo quel nodo, ereditati dai nodi che ne dipendono, anche se un blocco è stato saltato), `koByBlock[<blocco>]` (KO propri del blocco, usati dalle condizioni sull'esito); i worker restituiscono `outcome` e `productOutcomes { PRODOTTO: OK|KO|KO_TASK }`; `loops[<gate>-<n>]` conta i ritorni. A fine flusso `activeProducts` = prodotti non KO nei nodi finali e `status` = `COMPLETED` oppure `NO_PRODUCTS`.

Runtime per la 1.0: Quarkus Flow 1.3.0, reference implementation del Java SDK 7.x o Lemline (SonataFlow/Apache KIE supporta solo la 0.8). Su Temporal si esegue con [temporal-offer-interpreter](../temporal-offer-interpreter/README.md): un server e un worker Java generico deployato una volta; ogni offerta è un nuovo YAML passato come input, senza redeploy. Prova su Quarkus Flow: [quarkus-flow-sim](../quarkus-flow-sim/README.md).

**Cosa è stato verificato.** Il DSL generato è validato staticamente: schema ufficiale 1.0.0, perimetro dell'interprete e sintassi delle espressioni jq (`offer-agent`, `DslChecksTest`), più i test Node sulla struttura. **Il formato a grafo (gate come task nel ramo, `dead`, fork annidati, `<id>-run`/`<id>-settle`) non è stato eseguito su nessun motore.** I flussi nelle cartelle `quarkus-flow-sim` e `temporal-offer-interpreter` (provati su Quarkus Flow 1.3.0 e su Temporal di test) sono stati generati con il modello a step e non sono stati rigenerati: non rappresentano più il DSL attuale. Restano da verificare a runtime l'equivalenza con il simulatore e la scrittura concorrente del contesto da più rami di un `fork` (ogni ramo scrive solo chiavi proprie: `dead[<nodo>]`, `esiti[<blocco>]`).

Gli exporter per Camunda 8 (BPMN/DMN), Flowable (CMMN), Conductor e l'anteprima bpmn-js sono stati rimossi.

## Struttura dell'Execution Plan (JSON / YAML)
```text
planVersion, generatedAt
offer { id, name, description }
products [ { id, name, category } ]
summary { products, activities, services, gates, valid }
flow { type: seq|par|node, items[], kind: activity|gate, id }   // albero serie/parallelo del grafo (null se il grafo non è valido)
top [ id ]                      // nodi della sequenza principale (destinazioni degli instradamenti)
order [ id ]                    // ordine di esecuzione (topologico)
activities [ { activityId, taskId, taskName, service {method,path},
    executionType: SYNC|ASYNC_CALLBACK,
    invocation { mode: SINGLE_CALL_FOR_N_PRODUCTS|ONE_CALL_PER_PRODUCT, calls },
    products[], dependsOn[],   // dependsOn = id di blocchi o gate
    input[{name,required,source}], output[{name,target}],   // le liste hanno righe `x[]` (origine) e `x[].campo`
    productResults? { list, productField, outcomeField, ok[], koTask[] },
    when? { join, clauses[{left,op,value}], text },
    retry {maxAttempts,intervalSec},
    outcomes { OK, KO, KO_WITH_TASK {queue, slaHours} },
    notification?, async {callbackTopic,timeoutHours}?, extensionPoints? } ]
gates [ { gateId, note?, kind: JOIN|BRANCH, dependsOn[], products[], rules[],   // le regole ROUTE hanno when, to, maxIterations?, onExceed?
    routes[{ key, gateId, to, backward, maxIterations, onExceed, condition, text }],
    effectivePolicy { dontWait[], stopOnKo, koProducts: EXCLUDE|CONTINUE, description[] } } ]
servicesToDevelop [ { taskId, name, service, executionType, inputs, outputs, outcomes, extensionPoints, usedIn[] } ]
validation { errors[], warnings[], infos[] }
```

## Semantica dei gate (usata da simulazione ed Execution Plan)
1. Un gate si valuta quando tutti i nodi da cui dipende hanno finito, tranne i blocchi marcati *Non attendere*. Un esito "In attesa" o "KO con task" (task manuale aperto) in uno dei nodi a monte lo blocca.
2. **Instradamenti che tornano indietro o fermano** (*Instrada se…* verso un nodo precedente della sequenza principale, o verso STOP): si provano nell'ordine, prima delle regole sui KO. Se la condizione è vera e i ritorni non hanno raggiunto il massimo, si torna al nodo di destinazione con gli stessi prodotti in corsa (KO compresi) e i KO dei nodi rieseguiti azzerati; oltre il massimo si ferma l'offerta o si prosegue con le regole successive, secondo la regola.
3. Se c'è *Ferma tutto se ci sono KO* e un prodotto nel suo perimetro è KO, l'intera offerta si ferma.
4. Altrimenti i prodotti KO restano fuori da ciò che segue (*Solo OK*, default) oppure ripartono (*Prosegui anche con KO*).
5. **Salti in avanti** (*Instrada se…* verso un nodo successivo): dopo il punto 4; la prima regola vera salta i nodi intermedi, che lasciano passare i prodotti del gate.
6. Un blocco che dipende da un nodo in cui il prodotto è KO (o escluso) non viene eseguito per quel prodotto; un KO non raggiunge i nodi che non dipendono dal blocco, a meno di un join. Un blocco saltato da una condizione (`SE …`) è neutro: non è un KO e i dipendenti partono.
7. A fine flusso un prodotto è completato se non è KO in nessun nodo finale (rami compresi).

## Test
```powershell
node --test tests/     # test: condizioni, instradamenti, liste in input/output, grafo (struttura serie/parallelo, gate di ramo e join, migrazione dagli step), DSL generato, simulatore, validazione, modello dei campi e mappature
```
Nessuna dipendenza: gli script della dashboard vengono caricati in un contesto Node isolato (`tests/harness.js`). Il DSL è validato anche da `offer-agent` (`DslChecksTest`: schema ufficiale 1.0.0 + perimetro dell'interprete Temporal) e le espressioni jq sono **valutate con jackson-jq** (la stessa libreria dell'interprete) su dati d'esempio, senza eseguirlo su un motore.

## File
```text
index.html, catalog.html, generate.html
css/styles.css
schema/offer-generation.schema.json   contratto della risposta dell'agente (offerta + assunzioni); non prevede condizioni né instradamenti: si aggiungono dalla dashboard
js/seed.js            dati demo
js/store.js           Util (DOM, toast, modal), Model (dominio: nodi, grafo, struttura serie/parallelo, layout, migrazione), Store (localStorage, import/export)
js/fields.js          campi dei task e della pratica: classificazione sorgenti, import schema/esempio, stato delle mappature, auto-mapping
js/conditions.js      condizioni strutturate (when / ROUTE): valutazione, negazione, riferimenti disponibili, validazione
js/validation.js      controlli di coerenza
js/simulator.js       motore di simulazione (grafo, condizioni, ritorni, salti)
js/execution-plan.js  generazione dell'Execution Plan e vista leggibile
js/plan-graph.js      grafo dell'Execution Plan (SVG)
js/exporters/         common (registry, YAML, util), serverless, temporal (riusa serverless)
js/generate.js        UI generazione da specifiche
js/vendor/js-yaml/    js-yaml 4.1.0 (MIT)
js/vendor/open-workflow-editor/  bundle del viewer Open Workflow (Apache-2.0; elkjs sotto EPL-2.0) per la scheda Diagramma DSL
tools/open-workflow-viewer/  sorgente e script per rigenerare il bundle (solo sviluppo)
js/offer.js           UI configurazione offerta (tab Visuale, Grafo e Diagramma DSL)
js/catalog.js         UI catalogo
tests/                test Node
```
