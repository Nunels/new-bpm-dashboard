# Offerta "Famiglia": Evo + Libretto Minori

Prodotti: **Evo** e **Lib Min**.

## Verifiche preliminari
- Un solo controllo Oracolo per entrambi i prodotti (una chiamata).
- Dopo Oracolo, controllo dei pregiudizievoli.

## Verifiche back office
La pratica va in carico al back office. L'esito arriva in asincrono sul topic `bo.pratiche.esiti`.
Se il back office segnala un KO, si apre un task manuale sulla coda `BO_RILAVORAZIONE` con SLA di 8 ore.
Se dopo il back office c'è anche un solo KO, l'offerta si ferma.

## Attivazioni
Attivazione su core banking, **una chiamata per ciascun prodotto**, con 3 tentativi a distanza di 60 secondi.

## Post attivazioni
Mail di benvenuto al cliente con il template `WELCOME_KIT`.
