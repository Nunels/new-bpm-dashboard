# Prova su Quarkus Flow

Verifica se il workflow Open Workflow (Serverless Workflow 1.0) generato dalla dashboard (`../offer-dashboard`) si comporta come il **simulatore** della dashboard quando viene eseguito da un runtime reale: **Quarkus Flow 1.3.0** (su Quarkus 3.39.0, Java 17).

Tutti i servizi chiamati sono simulati da questa stessa applicazione: non serve nessun endpoint esterno.

> **Attenzione:** i flussi in `src/main/resources/flow/`, i piani e gli scenari sono stati generati con il modello a **step** della dashboard e provati in quella forma. La dashboard ora produce un DSL a grafo (gate come task nel ramo, `dead`, fork annidati, blocchi `<id>-run`/`<id>-settle`) che **non è stato eseguito** su Quarkus Flow: `tools/generate.js` non è stato adeguato né rieseguito e va aggiornato prima di rigenerare i flussi.

## Cosa contiene
| Percorso | Scopo |
|---|---|
| `tools/generate.js` | Riusa il codice della dashboard: costruisce due offerte di prova (solo servizi sincroni), genera i YAML in `src/main/resources/flow/`, gli Execution Plan in `src/main/resources/plans/` e gli scenari con gli esiti attesi calcolati dal **simulatore** in `src/test/resources/scenarios.json`. |
| `src/main/java/it/sim/MockResource.java` | Servizi simulati sotto `/mock/...` (stessi path del catalogo della dashboard). Risposta: `{ outcome, productOutcomes: { PRODOTTO: OK/KO } }`. |
| `src/main/java/it/sim/RunResource.java` | `POST /run/{workflow}` avvia un workflow e restituisce `{ status, output o error }`. `GET /run` elenca i workflow caricati. |
| `src/main/java/it/sim/java/` | **Variante B**: stesso Execution Plan eseguito da funzioni Java (Java DSL di Quarkus Flow). |
| `src/test/java/it/sim/ScenarioTest.java` | Esegue ogni scenario e confronta con il simulatore. |
| `tools/run-scenarios.js` | Stesso confronto contro un'istanza già avviata, più rapido da usare. |

Comandi di controllo dei servizi simulati: `POST /sim/reset`, `PUT /sim/outcomes` (es. `{"ORACOLO":{"EVO":"KO"}}`), `PUT /sim/latency` (es. `{"ORACOLO_2":3000}` ms), `GET /sim/calls` (registro delle chiamate ricevute).

## Come si esegue
Servono JDK 17+ (`JAVA_HOME`) e Maven 3.8+. Le dipendenze vengono scaricate dal repository Maven configurato nel tuo `settings.xml`.

```powershell
node tools/generate.js                       # rigenera YAML, piani e scenari dalla dashboard
mvn test -Dsim.variant=a                     # variante A: YAML generato
mvn test -Dsim.variant=b                     # variante B: funzioni Java
mvn test -Dsim.only=cribis                   # solo gli scenari il cui nome contiene "cribis"

mvn package -DskipTests; java -jar target/quarkus-app/quarkus-run.jar   # avvio come servizio (porta 8089)
node tools/run-scenarios.js --variant a      # poi, da un altro terminale
```

## Scenari
Due offerte: `OFF_SIM` (Conto, Evo, Lib Min, TIM) con tutte le regole dei gate, e `OFF_SIM_MONO` (solo Conto).

| Scenario | Cosa verifica |
|---|---|
| tutto-ok | percorso completo, 1 chiamata per N prodotti (Oracolo) e 1 per prodotto (stampa, attivazione) |
| evo-ko-in-oracolo, conto-ed-evo-ko-in-oracolo | "Solo OK": i prodotti KO escono, gli altri proseguono; **Pregiudizievoli (dipende da Oracolo) non viene eseguito per i prodotti KO** |
| cribis-ko-ferma-tutto | "Ferma tutto se ci sono KO" |
| pregiudizievoli-ko-libmin, stampa-ko-in-bo-esclude-evo | esclusione in step diversi |
| attivazione-ko-prosegue | "Prosegui anche con KO" |
| oracolo2-lento-non-attendere | "Non attendere": Oracolo 2 impiega 4 s, il processo non deve aspettarlo |
| OFF_SIM_MONO: oracolo-ko-nessun-prodotto | nessun prodotto supera la barra |

Per ogni scenario si confrontano: stato finale, prodotti ancora attivi, numero di chiamate per servizio, **prodotti inviati a ogni servizio** e, per "Non attendere", i tempi.

## Risultati

| | Variante A (YAML generato) | Variante B (funzioni Java) |
|---|---|---|
| Scenari identici al simulatore | **9 / 10** | **10 / 10** |
| "Non attendere" | **non funziona**: 4,1 s | funziona: circa 70 ms |

Il solo scenario che differisce in A è "Non attendere". Nel test Maven della variante A quel caso è un **segnale d'allarme**: passa finché il runtime attende il ramo, e fallisce se una versione futura rispetterà `await: false`, ricordando di aggiornare la documentazione.

## Cosa è emerso (da sapere prima di scegliere il runtime)
1. **Il runtime valida i workflow contro lo schema ufficiale già in fase di build.** Un `input` di sotto-workflow scritto come espressione unica è stato rifiutato (deve essere un oggetto). Utile: gli errori escono subito.
2. **jackson-jq non è tutto jq.** `IN/1` non esiste. Il generatore ora usa confronti espliciti (`. == "A" or . == "B"`). Regola: ogni espressione generata va provata sul runtime di destinazione.
3. **In `export.as` il `.` è il contesto, non l'output del task**, diversamente dal testo della specifica. L'output si legge con `$output` (che la specifica prevede): il generatore ora lo usa.
4. **`run: workflow` con `await: false` viene ignorato**: il chiamante aspetta comunque il sotto-workflow. Anche `fork` con `compete: true` aspetta. Senza un broker (Kafka/AMQP, qui non disponibile) il YAML standard non ha un modo per lanciare un ramo senza attenderlo su questo runtime. Via d'uscita provata: un'attività Java (variante B). Via standard non provata: emissione di un evento che fa partire un altro workflow, che richiede un broker.
5. **I workflow definiti in Java hanno come identificatore il nome della classe**, quelli YAML `namespace:nome`. Il ricaricamento a caldo non vede nuovi file YAML: serve riavviare.
6. **Un difetto del generatore trovato e corretto:** un blocco che dipende da un altro (es. Pregiudizievoli dopo Oracolo) veniva chiamato anche per i prodotti andati in KO nel blocco precedente, a differenza del simulatore. Ora YAML e interprete Java li escludono; il test lo controlla.
7. **Il `GET` non portava i prodotti e il path con `{codiceFiscale}` non veniva sostituito:** corretto (prodotti in query, parametri nel path calcolati dall'input).

## Limiti di questa prova
- Solo servizi **sincroni**. Non coperti: BO e TIM asincroni (callback), task manuale su "KO con task", durabilità dopo un riavvio, carico.
- I servizi sono simulati: non misura la correttezza dei veri contratti.
- La variante B è un interprete scritto per questa prova: mostra la personalizzabilità, ma la manutenzione di quel codice sarebbe vostra.
- Gli stessi scenari sono stati eseguiti anche su Temporal con un interprete Java ([temporal-offer-interpreter](../temporal-offer-interpreter/README.md)): 10 su 10, incluso "Non attendere". Non su altri runtime (Lemline, Java SDK di riferimento, Synapse).
- Il Nexus aziendale è stato usato così com'è; nessuna modifica a `settings.xml`.
