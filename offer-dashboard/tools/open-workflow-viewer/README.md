# Bundle del viewer Open Workflow

Costruisce `js/vendor/open-workflow-editor/` (script classico + CSS), usato dalla scheda **Diagramma DSL** della dashboard. Serve **solo** per rigenerare il bundle (aggiornare la versione del viewer): per usare la dashboard non serve Node e il risultato è già nel repo.

- Sorgente del viewer: [open-workflow-specification/editor](https://github.com/open-workflow-specification/editor), pacchetto npm `@openworkflowspec/diagram-editor` (componente React 19, Apache-2.0). Versione usata: vedi `package.json`.
- `entry.js` lo monta in sola lettura ed espone `window.OpenWorkflowViewer.mount(container, { content, locale, colorMode })` → `{ update(opts), unmount() }`; React resta interno al bundle.
- Il bundle è uno script classico (IIFE): i moduli ES non si caricano da `file://`, e la dashboard si apre con un doppio click.

## Rigenerare
Serve Node 18+ (provato con 18.20).

```powershell
cd offer-dashboard/tools/open-workflow-viewer
npm install
npm run build        # vite build + copia in ../../js/vendor/open-workflow-editor/ (con NOTICE e licenze)
```

Consiglio: farlo in una copia fuori da cartelle sincronizzate (OneDrive), perché `node_modules` ha migliaia di file. `copy-output.cjs` accetta come argomento la cartella di destinazione.

## Licenze
Apache-2.0 per l'editor; `elkjs` (layout) è `EPL-2.0 OR GPL-3.0-or-later` e si usa sotto EPL-2.0. `copy-output.cjs` scrive `NOTICE.txt` con le librerie principali e copia le licenze di editor ed elkjs accanto al bundle.
