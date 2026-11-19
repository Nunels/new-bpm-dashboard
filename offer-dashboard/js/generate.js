/* Generazione di un'offerta da un file di specifiche tramite l'agente (backend offer-agent). */
(function () {
  const h = Util.h, toast = Util.toast;
  const BACKEND_KEY = 'offerDashboard.agentUrl';
  const sameOrigin = /^https?:$/.test(location.protocol);
  let backend = sameOrigin ? '' : (localStorage.getItem(BACKEND_KEY) || 'http://localhost:8090');
  let config = null;        // { model, configured, maxAttempts, maxSpecChars }
  let configError = null;
  let file = null;          // { name, text }
  let job = null;
  let polling = null;

  const $ = function (id) { return document.getElementById(id); };

  function api(path, opts) {
    return fetch(backend + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
        return body;
      });
    });
  }

  function loadConfig() {
    config = null; configError = null; render();
    api('/api/config').then(function (c) { config = c; render(); })
      .catch(function (e) { configError = 'Backend non raggiungibile (' + (backend || location.origin) + '): ' + e.message; render(); });
  }

  function readFile(f) {
    if (!f) return;
    if (!/\.(md|markdown|txt)$/i.test(f.name)) { toast('Formato non supportato: carica un file .md o .txt', 'error'); return; }
    const reader = new FileReader();
    reader.onload = function () { file = { name: f.name, text: String(reader.result) }; job = null; render(); };
    reader.readAsText(f, 'utf-8');
  }

  function start() {
    const data = Store.load();
    const body = { fileName: file.name, specText: file.text, catalog: { products: data.products, tasks: data.tasks, practice: data.practice } };
    job = { status: 'RUNNING', progress: 'Invio delle specifiche…', attempts: [] };
    render();
    api('/api/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { poll(r.id); })
      .catch(function (e) { job = { status: 'ERROR', errors: [e.message], attempts: [] }; render(); });
  }

  function poll(id) {
    clearTimeout(polling);
    api('/api/generations/' + encodeURIComponent(id)).then(function (j) {
      job = j;
      if (j.status === 'RUNNING') { render(); polling = setTimeout(function () { poll(id); }, 1000); return; }
      if (j.status === 'SUCCESS' || j.status === 'WARNING') { openDashboard(j); return; }
      render();
    }).catch(function (e) { job = { status: 'ERROR', errors: ['Stato della generazione non disponibile: ' + e.message], attempts: [] }; render(); });
  }

  /* Salva l'offerta generata (con id univoco e avvisi) e apre la dashboard su quella offerta. */
  function openDashboard(j) {
    const data = Store.load();
    const offer = JSON.parse(JSON.stringify(j.offer));
    const ids = data.offers.map(function (o) { return o.id; });
    if (ids.indexOf(offer.id) >= 0) offer.id = Util.uniqueId(offer.id, ids);
    offer.generation = { jobId: j.id, model: j.model, source: j.fileName, at: j.finishedAt, warnings: j.warnings || [], reviewed: false, modelOutput: j.modelOutput || null };
    data.offers.push(offer);
    Store.save(Model.normalize(data));
    location.href = 'index.html?offer=' + encodeURIComponent(offer.id);
  }

  function render() {
    const el = $('gen'); el.innerHTML = '';
    const busy = job && job.status === 'RUNNING';
    el.append(h('section', { class: 'gen-card' },
      h('h2', null, 'Genera un\'offerta dalle specifiche'),
      h('p', { class: 'muted' }, 'Carica le specifiche dell\'offerta (Markdown o testo). L\'agente propone la configurazione usando solo prodotti e task del catalogo, la valida e genera il DSL Serverless Workflow. Se va a buon fine si apre la dashboard, dove puoi rivedere e modificare tutto prima di esportare.'),
      backendBox(),
      h('div', { class: 'gen-drop' + (file ? ' has-file' : ''),
        ondragover: function (e) { e.preventDefault(); e.currentTarget.classList.add('drop-over'); },
        ondragleave: function (e) { e.currentTarget.classList.remove('drop-over'); },
        ondrop: function (e) { e.preventDefault(); e.currentTarget.classList.remove('drop-over'); readFile(e.dataTransfer.files[0]); } },
        file ? h('div', null, h('b', null, '📄 ' + file.name), h('span', { class: 'muted' }, ' · ' + file.text.length + ' caratteri'),
          config && file.text.length > config.maxSpecChars ? h('div', { class: 'msg error' }, 'Il file supera il limite di ' + config.maxSpecChars + ' caratteri.') : null)
          : h('div', { class: 'muted' }, 'Trascina qui il file .md, oppure'),
        h('label', { class: 'btn' }, file ? 'Cambia file' : 'Scegli file', h('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain', hidden: true, onchange: function (e) { readFile(e.target.files[0]); e.target.value = ''; } }))),
      file ? h('details', { class: 'gen-preview' }, h('summary', null, 'Anteprima'), h('pre', null, file.text.slice(0, 4000) + (file.text.length > 4000 ? '\n…' : ''))) : null,
      h('div', { class: 'gen-actions' },
        h('button', { class: 'primary', disabled: !file || busy || !config || !config.configured || file.text.length > config.maxSpecChars, onclick: start }, busy ? '⏳ Generazione in corso…' : '✨ Genera offerta')),
      job ? jobBox() : null));
  }

  function backendBox() {
    const parts = [];
    if (!sameOrigin) {
      parts.push(h('div', { class: 'gen-backend' }, h('span', { class: 'lbl' }, 'Backend'),
        h('input', { type: 'text', value: backend, onchange: function (e) { backend = e.target.value.replace(/\/+$/, ''); localStorage.setItem(BACKEND_KEY, backend); loadConfig(); } }),
        h('span', { class: 'muted' }, 'La dashboard aperta da file usa un archivio locale diverso da quella servita dal backend: l\'offerta generata compare qui.')));
    }
    if (configError) parts.push(h('div', { class: 'msg error' }, configError));
    else if (!config) parts.push(h('div', { class: 'muted' }, 'Verifica del backend…'));
    else if (!config.configured) parts.push(h('div', { class: 'msg error' }, 'Il modello ' + config.model + ' non è configurato sul backend (variabile GEMINI_API_KEY).'));
    else parts.push(h('div', { class: 'msg info' }, 'Modello: ', h('b', null, config.model), ' · fino a ' + config.maxAttempts + ' tentativi con correzione automatica. ',
      h('b', null, 'Le specifiche vengono inviate al servizio del modello: usa solo contenuti autorizzati.')));
    return parts;
  }

  function jobBox() {
    const j = job;
    const cls = { RUNNING: 'info', SUCCESS: 'ok', WARNING: 'warning', ERROR: 'error' }[j.status];
    return h('div', { class: 'gen-job' },
      h('div', { class: 'msg ' + cls }, h('b', null, { RUNNING: '⏳ ', SUCCESS: '✔ ', WARNING: '⚠ ', ERROR: '✖ ' }[j.status] + (j.progress || j.status))),
      j.status === 'ERROR' ? h('div', null,
        h('h4', null, 'L\'offerta non è stata generata'),
        h('ul', { class: 'gen-errors' }, (j.errors || []).map(function (e) { return h('li', null, e); })),
        h('p', { class: 'muted' }, 'Puoi chiarire le specifiche e riprovare. Nessuna offerta è stata aggiunta alla dashboard.'),
        h('button', { onclick: start, disabled: !file }, '↻ Riprova')) : null,
      (j.attempts || []).length ? h('details', { open: j.status === 'ERROR' }, h('summary', null, 'Tentativi (' + j.attempts.length + ')'),
        h('ol', null, j.attempts.map(function (a) {
          return h('li', null, (a.kind === 'REPAIR' ? 'Correzione' : 'Generazione') + ' · ' + (a.millis / 1000).toFixed(1) + ' s · ' + (a.errors.length ? a.errors.length + ' errori' : 'valido'),
            a.errors.length ? h('ul', null, a.errors.slice(0, 10).map(function (e) { return h('li', { class: 'muted' }, e); })) : null);
        }))) : null);
  }

  loadConfig();
})();
