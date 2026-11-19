# Offerta "Mondo Famiglia + TIM": Conto, Evo, Lib Min e TIM

Offerta bundle venduta online con **quattro prodotti**, nell'ordine:

1. **Conto** (conto corrente online)
2. **Evo** (carta di debito evoluta)
3. **Lib Min** (libretto minori)
4. **TIM** (offerta telco del partner)

Il cliente sottoscrive tutto in un'unica pratica. Il processo attraversa **tutti e cinque gli step** (verifiche preliminari, verifiche verticali, verifiche back office, attivazioni, post attivazioni).

---

## 1. Verifiche preliminari

### 1.1 Verifica documento
- Controllo del documento d'identità del cliente, **una sola chiamata** per tutti e quattro i prodotti.
- Fino a 1 nuovo tentativo a distanza di 10 secondi.
- Se il documento risulta KO si apre un task manuale sulla coda `BO_DOCUMENTI`, con SLA di 4 ore.
- È il primo controllo: **tutti gli altri controlli preliminari partono solo dopo la verifica documento**.

### 1.2 Oracolo (antifrode/antiriciclaggio) condiviso
- Un unico controllo Oracolo per **Conto, Evo e Lib Min** (una sola chiamata, non una per prodotto), da eseguire dopo la verifica documento.
- 3 tentativi a distanza di 30 secondi.
- Su KO si apre un task manuale sulla coda `BO_ANTIFRODE`, SLA 8 ore.

### 1.3 Oracolo 2 (partner telco)
- Controllo specifico solo per **TIM**, da eseguire dopo la verifica documento, in parallelo a Oracolo.
- 2 tentativi a distanza di 60 secondi.
- Il partner può rispondere con molto ritardo: **non si deve attendere l'esito di Oracolo 2** per passare allo step successivo. La risposta, quando arriva, viene gestita in autonomia.

### 1.4 Pregiudizievoli
- Controllo pregiudizievoli e protesti **solo per Conto e Lib Min**. Per Evo non serve: è una carta di debito senza esposizione di credito.
- Da eseguire dopo Oracolo. Come dato di input usa il punteggio di rischio prodotto da Oracolo (`scoreRischio`).
- 2 tentativi a distanza di 30 secondi.
- Su KO si apre un task manuale sulla coda `BO_CREDITO`, SLA 24 ore.

### Regole di passaggio verso le verifiche verticali
- Se **Conto** ha un KO, l'**intera offerta si ferma**: il conto è il prodotto principale del bundle.
- Per tutti gli altri prodotti, quelli in KO escono dall'offerta e gli altri proseguono.
- Non si attende l'esito di Oracolo 2 (vedi sopra).

---

## 2. Verifiche verticali

### 2.1 Cribis
- Verifica del rating "in rosso" **solo per il Conto**, una chiamata per prodotto.
- 2 tentativi a distanza di 30 secondi.

### 2.2 Oracolo rafforzato per carta e libretto
- Un secondo controllo Oracolo, questa volta **solo per Evo e Lib Min** (prodotti con intestatario minore o carta), una sola chiamata per entrambi.
- Si esegue in parallelo a Cribis, con **2 tentativi** a distanza di 30 secondi (diverso dall'Oracolo preliminare).
- Su KO si apre un task manuale sulla coda `BO_ANTIFRODE`, SLA 8 ore.

TIM non ha controlli verticali: attraversa lo step senza attività.

### Regole di passaggio verso il back office
- I prodotti in KO escono dall'offerta, gli altri proseguono.

---

## 3. Verifiche back office

### 3.1 Stampa contratti
- Generazione dei contratti PDF per **Conto, Evo e Lib Min**, **una chiamata per ciascun prodotto**, con 3 tentativi a distanza di 10 secondi.

### 3.2 Presa in carico back office
- Invio della pratica al back office per **tutti e quattro i prodotti**, in una sola chiamata, **dopo** la stampa dei contratti.
- L'esito è **asincrono**: arriva sul topic `bo.pratiche.esiti`.
- Se il back office segnala un KO si apre un task manuale sulla coda `BO_RILAVORAZIONE`, SLA 8 ore.

### Regole di passaggio verso le attivazioni
- Se dopo il back office c'è **anche un solo KO**, l'intera offerta si ferma.

---

## 4. Attivazioni

### 4.1 Attivazione prodotto bancario
- Attivazione su core banking per **Conto, Evo e Lib Min**, **una chiamata per ciascun prodotto**.
- 3 tentativi a distanza di 60 secondi.
- Su KO si apre un task manuale sulla coda `BO_ATTIVAZIONI`, SLA 4 ore.

### 4.2 Attivazione TIM
- Attivazione della linea presso il partner, solo per **TIM**, in parallelo all'attivazione bancaria.
- L'esito è **asincrono**, può arrivare dopo minuti o giorni, sul topic `partner.tim.attivazioni`.
- 1 nuovo tentativo a distanza di 5 minuti.
- Su KO si apre un task manuale sulla coda `BO_PARTNER`, SLA 48 ore.

### Regole di passaggio verso le post attivazioni
- Le comunicazioni al cliente **partono comunque**, anche se un'attivazione è fallita: i prodotti in KO proseguono.
- **Non si attende l'esito dell'attivazione TIM**, che può impiegare giorni.

---

## 5. Post attivazioni

### 5.1 Mail di benvenuto
- Invio al cliente della mail di benvenuto con il template `WELCOME_KIT`, una sola comunicazione per tutta l'offerta (tutti e quattro i prodotti).
- 3 tentativi a distanza di 60 secondi.

### 5.2 Comunicazione specifica TIM
- Dopo la mail di benvenuto, invio di una seconda comunicazione **solo per TIM** con il template `TIM_SIM_SPEDITA`.

---

## Requisiti non coperti dal catalogo attuale
- **Firma digitale con OTP** del contratto, da richiedere al cliente dopo la stampa dei contratti e prima della presa in carico del back office.
- **Controllo geolocalizzazione del dispositivo** nelle verifiche preliminari, solo per Conto.

Questi due servizi devono comparire nell'offerta se esistono nel catalogo; in caso contrario vanno segnalati e non inventati.
