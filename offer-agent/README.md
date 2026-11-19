# offer-agent — agente che prepopola l'offerta dalle specifiche

Backend Quarkus del flusso **specifiche → agente AI → dashboard → DSL**:
1. L'analista carica un file di specifiche (Markdown/testo) in `generate.html`.
2. L'agente chiama Gemini con **output strutturato** e ottiene la **configurazione dell'offerta**, nel formato della dashboard: prodotti, blocchi, barre di regole.
3. La risposta viene validata. In caso di errori il modello riceve gli errori e corregge, fino a `agent.max-attempts` tentativi.
4. **Controllo di copertura:** se la risposta è valida, una seconda chiamata al modello rilegge la specifica contro la configurazione e riporta i requisiti omessi o alterati (task manuale su KO con coda e SLA, retry, template, topic, dipendenze…). Ogni differenza ha il blocco, la spiegazione e, se riguarda la config del blocco, la **correzione già pronta** (`configPatch`): il backend la applica direttamente alla config (merge, senza toccare gli altri campi), rivalida e registra l'elenco in `appliedFixes` del job, **senza un altro giro di generazione**. Le differenze non automatizzabili (prodotti, dipendenze, barre) tornano al modello come correzione; se restano all'ultimo tentativo diventano avvisi («Controllo di copertura: …»). Se la chiamata di controllo fallisce non blocca la generazione. Costa una chiamata in più per tentativo: si spegne con `AGENT_COVERAGE_CHECK=false`.
4. Esito:
   - **SUCCESS:** la dashboard si apre sull'offerta;
   - **WARNING:** la dashboard si apre con un banner che elenca gli avvisi;
   - **ERROR:** la dashboard non si apre e vengono mostrati errori e tentativi.
5. Il DSL Serverless Workflow 1.0 lo genera l'exporter della dashboard, non il modello. È lo stesso DSL che esegue `../temporal-offer-interpreter`.

Il modello non scrive il DSL: produce un JSON piccolo e controllabile, e il DSL nasce da codice deterministico già verificato (schema ufficiale 1.0.0 e 10 scenari su 10 su Temporal).

## Validazione di ogni risposta
| Controllo | Esito se fallisce |
|---|---|
| JSON leggibile (accettato anche dentro un blocco di codice ```json) | errore → correzione |
| Schema della risposta (`../offer-dashboard/schema/offer-generation.schema.json`) con gli **id del catalogo come enum**: il modello non può inventare prodotti, task o step | errore → correzione |
| Id di blocchi e barre univoci | errore → correzione |
| Validazione della dashboard: compatibilità task/prodotto, step, dipendenze circolari o tra step, regole che puntano a blocchi inesistenti, coda mancante per "KO con task" | errori → correzione; avvisi → WARNING |
| DSL generato: schema ufficiale DSL 1.0.0 e perimetro dell'interprete Temporal | errore |
| DSL riconvertibile nella stessa offerta (andata e ritorno) | errore |
| Simulazione con tutti gli esiti OK: deve arrivare a COMPLETED | avviso |
| `assumptions` del modello: scelte fatte dove la specifica era ambigua, o richieste fuori catalogo | avvisi |

Validazione, export e importer sono **il codice JavaScript della dashboard** eseguito in GraalJS (copiato nel classpath a build time da `../offer-dashboard`): una sola fonte di verità, nessuna riscrittura in Java. Il perimetro del DSL usa `DefinitionValidator` di `temporal-offer-interpreter`.

## Modello
- API REST **interactions** di Gemini con `response_format` JSON Schema (https://ai.google.dev/gemini-api/docs/structured-output), header `Api-Revision: 2026-05-20`.
- Il modello è configurabile; il default è `gemini-4-hydrogen`, citato nella documentazione ufficiale.
- La chiave sta **solo sul server** (variabile `GEMINI_API_KEY`): il browser non la vede mai.
- Il testo delle specifiche non viene loggato (salvo `GEMINI_LOG_PAYLOADS=true`, vedi "Log delle chiamate"). Il prompt tratta il file come dato tra delimitatori (`<<<SPECIFICA … SPECIFICA>>>`) e contiene solo le regole del dominio, il catalogo (senza endpoint) e la specifica.
- Errori transitori (429, 5xx, rete): un nuovo tentativo dopo 2 s. Errori permanenti (es. chiave non valida): ERROR immediato.

### Log delle chiamate a Gemini
Ogni chiamata produce due righe (categoria `it.sim.agent.GeminiOfferModel`), correlate con l'id della generazione (`job=`):
```
gemini#3 job=9f2c… richiesta: POST https://generativelanguage.googleapis.com/v1beta/interactions model=gemini-4-hydrogen apiRevision=2026-05-20 promptChars=8123 schemaChars=5210 bodyBytes=13620 timeout=PT2M
gemini#3 job=9f2c… risposta: status=200 millis=14210 responseBytes=6901 textChars=2480 requestId=- tokensInput=3100 tokensOutput=1250 tokensThought=… tokensTotal=…
gemini#4 job=9f2c… risposta: status=429 millis=310 responseBytes=212 requestId=- retryable=true errore=Resource exhausted   (WARN)
```
Gli errori di rete, i timeout e le risposte non utilizzabili sono loggati a WARN con la durata. **La chiave non viene mai loggata.** Prompt, specifiche e risposte compaiono solo con `GEMINI_LOG_PAYLOADS=true` (da usare in sviluppo con dati fittizi, mai con specifiche reali). Per spegnere questi log: `quarkus.log.category."it.sim.agent.GeminiOfferModel".level=WARN`.

> **La chiave non va nel codice né in `application.properties`.** Passarla con la variabile d'ambiente `GEMINI_API_KEY` o, in locale, nel file `.env` della cartella `offer-agent` (letto da Quarkus, escluso da `.gitignore`).

> **Prima di usare specifiche reali**: inviare le specifiche delle offerte a un servizio esterno va autorizzato secondo le policy aziendali. Finché non c'è l'autorizzazione, usare solo specifiche fittizie (come quelle in `src/test/resources/specs`).

## Esecuzione
Servono JDK 17+ e Maven. Le dipendenze arrivano dal repository Maven configurato. `temporal-offer-interpreter` va installato prima nel repository locale:
```powershell
cd ..\temporal-offer-interpreter; mvn -q install -DskipTests; cd ..\offer-agent
mvn package -DskipTests
$env:GEMINI_API_KEY = "..."                        # obbligatoria
$env:GEMINI_MODEL = "gemini-4-hydrogen"            # facoltativa
java -jar target\quarkus-app\quarkus-run.jar      # http://localhost:8090/generate.html
```
Il backend serve anche la dashboard (`http://localhost:8090/index.html`). Usare questo indirizzo: la dashboard aperta da file (`file://`) ha un archivio locale separato, quindi non vedrebbe le offerte generate. Funziona comunque anche da file, perché il CORS è abilitato e l'indirizzo del backend si imposta nella pagina.

**Prova senza chiave reale.** Un finto Gemini restituisce le offerte attese delle specifiche di esempio:
```powershell
mvn -q test-compile exec:java "-Dexec.mainClass=it.sim.agent.FakeGeminiServer" "-Dexec.classpathScope=test"   # stampa GEMINI_BASE_URL
$env:GEMINI_BASE_URL = "http://127.0.0.1:<porta>"; $env:GEMINI_API_KEY = "test"; java -jar target\quarkus-app\quarkus-run.jar
```
Poi carica un file di `src/test/resources/specs`. Con un file chiamato `irreparabile.md` si vede l'esito ERROR.

| Proprietà | Default | Significato |
|---|---|---|
| `GEMINI_API_KEY` | — | chiave del modello |
| `GEMINI_MODEL` | `gemini-4-hydrogen` | modello |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | endpoint (per test o proxy aziendale) |
| `GEMINI_LOG_PAYLOADS` | `false` | logga anche prompt e risposte (solo dati fittizi) |
| `agent.max-attempts` | 3 | tentativi totali (generazione + correzioni) |
| `AGENT_COVERAGE_CHECK` | `true` | controllo di copertura della specifica (una chiamata in più) |
| `agent.max-spec-chars` | 60000 | dimensione massima del file |

## API
- `GET /api/config` → `{ model, configured, maxAttempts, maxSpecChars }`
- `POST /api/generations` `{ fileName, specText, catalog: { products, tasks, practice? } }` → `202 { id }`. Il catalogo è quello della dashboard di chi carica.
- `GET /api/generations/{id}` → `{ status: RUNNING|SUCCESS|WARNING|ERROR, progress, attempts[], offer, files[], warnings[], errors[], simulation }`

## Test e valutazione
`mvn test` esegue 26 test, tutti verdi, con un **finto Gemini** che usa lo stesso formato HTTP dell'API reale:
- esiti SUCCESS, WARNING (assunzioni, richieste fuori catalogo) ed ERROR (errore permanente dopo 3 tentativi, chiave rifiutata);
- correzione riuscita al secondo tentativo, con gli errori inviati al modello;
- nuovo tentativo su errore 503, JSON dentro un blocco di codice;
- contenuto della richiesta: chiave nell'header, schema con gli enum del catalogo e senza l'ultimo step per le barre, specifica tra delimitatori;
- dashboard servita dal backend.

`DashboardJsTest` verifica che il codice della dashboard in GraalJS dia lo stesso risultato del browser.

Set di valutazione in `src/test/resources/specs` (dati fittizi), ciascuno con l'offerta attesa `*.expected.json`:

| Specifica | Cosa mette alla prova | Esito atteso |
|---|---|---|
| `conto-mono.md` | sequenza nello step, "ferma tutto se KO" | SUCCESS |
| `famiglia.md` | blocco condiviso, back office asincrono con callback e task manuale, retry, una chiamata per prodotto, mail | SUCCESS |
| `conto-tim-ambigua.md` | linguaggio vago, "non aspettare" | WARNING (3 assunzioni) |
| `casa-fuori-catalogo.md` | prodotto e attività non nel catalogo | WARNING (non inventati) |

Con il **modello reale**, solo dopo l'autorizzazione, `EvalRunner` esegue le specifiche e confronta le offerte con quelle attese: prodotti, blocchi (step + task + prodotti), dipendenze e regole delle barre, con un punteggio da 0 a 1.
```powershell
$env:GEMINI_API_KEY = "..."; mvn -q test-compile exec:java "-Dexec.mainClass=it.sim.agent.EvalRunner" "-Dexec.classpathScope=test"
```
**Non eseguito:** non c'era né chiave né autorizzazione, quindi la qualità del modello reale su queste specifiche non è ancora misurata.

## Limiti
- Job e risultati in memoria: un riavvio li perde; nessuno storico né approvazione.
- Input solo testo/Markdown (PDF e Word esclusi per scelta).
- L'agente produce una **proposta**: la validazione intercetta incoerenze e richieste fuori catalogo, non scelte plausibili ma sbagliate nel merito. Revisione dell'analista e simulazione restano necessarie.
- GraalJS 23.1 su JDK 17 gira senza compilazione JIT: sufficiente per questo uso, da rivedere sotto carico.
- Task con molti campi: al modello arriva un catalogo compatto (input obbligatori senza sorgente, output limitati a 12, elenco dei campi della pratica limitato a 80); la mappatura dettagliata dei campi non è generata dall'agente ma completata dall'analista in dashboard («⚡ Mappa automaticamente»). Il catalogo inviato può includere `practice` (modello della pratica).
