/* Dashboard catalogo: definizione prodotti e task (blocchi riutilizzabili) con input/output/esiti. */
(function () {
  const h = Util.h, toast = Util.toast;
  let data = Store.load();
  let sel = data.tasks.length ? { type: 'task', id: data.tasks[0].id } : null;
  let filter = '';

  const $ = function (id) { return document.getElementById(id); };
  const save = function () { Store.save(data); };
  const pname = function (pid) { return Model.productName(data, pid); };

  function usage(type, id) {
    const res = [];
    data.offers.forEach(function (o) {
      if (type === 'product' && o.products.indexOf(id) >= 0) res.push(o.name);
      if (type === 'task' && o.blocks.some(function (b) { return b.taskId === id; })) res.push(o.name);
    });
    return res;
  }

  function render() { renderLists(); renderEditor(); }

  function renderLists() {
    const el = $('lists'); el.innerHTML = '';
    const f = filter.trim().toLowerCase();
    const match = function (x) { return !f || (x.name + ' ' + x.id).toLowerCase().indexOf(f) >= 0; };
    const item = function (type, x, sub) {
      const active = sel && sel.type === type && sel.id === x.id;
      return h('div', { class: 'list-item' + (active ? ' active' : ''), onclick: function () { sel = { type: type, id: x.id }; render(); } },
        h('div', { class: 'li-name' }, x.name), h('div', { class: 'li-sub' }, sub));
    };
    [
      h('input', { type: 'search', placeholder: 'Cerca…', value: filter, oninput: function (e) { filter = e.target.value; renderLists(); const s = $('lists').querySelector('input'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }),
      h('div', { class: 'list-head' }, h('h3', null, 'Pratica')),
      item('practice', { id: 'practice', name: 'Modello della pratica' }, data.practice.fields.length + ' campi di input generale'),
      h('div', { class: 'list-head' }, h('h3', null, 'Prodotti (' + data.products.length + ')'), h('button', { class: 'small', onclick: newProduct }, '+ Prodotto')),
      data.products.filter(match).map(function (p) { return item('product', p, p.id + (p.category ? ' · ' + p.category : '')); }),
      h('div', { class: 'list-head' }, h('h3', null, 'Task (' + data.tasks.length + ')'), h('button', { class: 'small', onclick: newTask }, '+ Task')),
      data.tasks.filter(match).map(function (t) {
        return item('task', t, h('span', null,
          h('span', { class: 'badge ' + t.scope }, t.scope === 'common' ? 'common' : 'verticale'), ' ',
          h('span', { class: 'badge ' + t.type }, t.type), ' ',
          t.compatibleProducts.map(pname).join(', ')));
      })
    ].flat(Infinity).forEach(function (x) { if (x) el.append(x); });
  }

  function field(label, control, hint) {
    return h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), control, hint ? h('div', { class: 'field-hint' }, hint) : null);
  }
  function section(title) { return h('div', { class: 'psection' }, h('h4', null, title), Array.prototype.slice.call(arguments, 1)); }
  function input(obj, key, opts) {
    opts = opts || {};
    return h('input', {
      type: opts.type || 'text', value: obj[key] == null ? '' : obj[key], placeholder: opts.placeholder || '', min: opts.type === 'number' ? 0 : null,
      oninput: function (e) { obj[key] = opts.type === 'number' ? Math.max(0, Number(e.target.value) || 0) : e.target.value; save(); if (opts.relist) renderLists(); }
    });
  }
  function check(label, checked, onChange) {
    return h('label', { class: 'check inline' }, h('input', { type: 'checkbox', checked: checked, onchange: function (e) { onChange(e.target.checked); save(); } }), label);
  }
  function toggleIn(arr, v, on) { const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); }

  function renderEditor() {
    const el = $('editor'); el.innerHTML = '';
    if (!sel) { el.append(h('div', { class: 'empty' }, 'Seleziona o crea un prodotto o un task.')); return; }
    if (sel.type === 'practice') return el.append(practiceEditor());
    if (sel.type === 'product') {
      const p = Model.product(data, sel.id);
      if (p) return el.append(productEditor(p));
    } else {
      const t = Model.task(data, sel.id);
      if (t) return el.append(taskEditor(t));
    }
    sel = null; renderEditor();
  }

  function productEditor(p) {
    const used = usage('product', p.id);
    const tasks = data.tasks.filter(function (t) { return t.compatibleProducts.indexOf(p.id) >= 0; });
    return h('div', { class: 'editor-card' },
      h('div', { class: 'panel-head' }, h('div', { class: 'panel-kicker' }, 'Prodotto'), h('h3', null, p.name), h('code', null, p.id)),
      section('Dati',
        h('div', { class: 'row2' }, field('Nome', input(p, 'name', { relist: true })), field('Categoria', input(p, 'category', { relist: true, placeholder: 'es. Banking, Telco' }))),
        field('Descrizione', input(p, 'description'))),
      section('Task compatibili',
        tasks.length ? h('div', null, tasks.map(function (t) { return h('span', { class: 'chip' }, t.name); })) : h('div', { class: 'muted' }, 'Nessun task compatibile: abilitalo dal dettaglio del task.')),
      section('Utilizzato nelle offerte', used.length ? h('div', null, used.map(function (n) { return h('span', { class: 'chip' }, n); })) : h('div', { class: 'muted' }, 'Non utilizzato.')),
      h('div', { class: 'panel-actions' }, h('button', { class: 'danger', onclick: function () { deleteProduct(p); } }, '🗑 Elimina prodotto')));
  }

  function taskEditor(t) {
    const used = usage('task', t.id);
    return h('div', { class: 'editor-card' },
      h('div', { class: 'panel-head block-head' }, h('div', { class: 'panel-kicker' }, 'Task / blocco riutilizzabile'), h('h3', null, t.name), h('code', null, t.id)),
      section('Dati generali',
        h('div', { class: 'row2' }, field('Nome', input(t, 'name', { relist: true })), field('Descrizione', input(t, 'description'))),
        h('div', { class: 'row3' },
          field('Ambito', h('select', { value: t.scope, onchange: function (e) { t.scope = e.target.value; save(); renderLists(); } },
            h('option', { value: 'common' }, 'Common (più prodotti)'), h('option', { value: 'vertical' }, 'Verticale (prodotto specifico)'))),
          field('Esecuzione', h('select', { value: t.type, onchange: function (e) { t.type = e.target.value; save(); render(); } },
            h('option', { value: 'sync' }, 'Sincrona (API)'), h('option', { value: 'async' }, 'Asincrona (presa in carico + callback)'))),
          field('Modalità chiamata default', h('select', { value: t.callMode, onchange: function (e) { t.callMode = e.target.value; save(); } },
            h('option', { value: 'perOffer' }, '1 chiamata per N prodotti'), h('option', { value: 'perProduct' }, '1 chiamata per prodotto')))),
        h('div', { class: 'row2' },
          field('Metodo', h('select', { value: t.api.method, onchange: function (e) { t.api.method = e.target.value; save(); } }, ['GET', 'POST', 'PUT', 'PATCH'].map(function (m) { return h('option', { value: m }, m); }))),
          field('Path servizio', input(t.api, 'path', { placeholder: '/servizio/v1/risorsa' })))),
      section('Prodotti compatibili',
        h('div', null, data.products.map(function (p) {
          return check(p.name, t.compatibleProducts.indexOf(p.id) >= 0, function (on) { toggleIn(t.compatibleProducts, p.id, on); renderLists(); });
        }))),
      section('Step in cui può essere usato',
        h('div', null, data.steps.map(function (s) {
          return check(s.name, t.allowedSteps.indexOf(s.id) >= 0, function (on) { toggleIn(t.allowedSteps, s.id, on); });
        })),
        h('div', { class: 'field-hint' }, 'Nessuno selezionato = utilizzabile in qualsiasi step.')),
      section('Input (contratto di request)',
        listEditor(t.inputs, ['name', 'type', 'source', 'required'], { name: 'Nome (percorso)', type: 'Tipo', source: 'Sorgente di default', required: 'Obbl.' },
          function () { return { name: 'nuovoInput', type: 'string', source: '', required: false, description: '' }; }, { importFields: true }),
        h('div', { class: 'field-hint' }, 'Liste: scrivi il campo di un elemento come spedizioni[].cap e aggiungi la riga della lista (spedizioni[], tipo array) con l\'origine di default: offerta.prodotti = un elemento per prodotto, oppure un campo lista come pratica.spedizioni[]. Nei campi dentro la lista: @.campo, prodotto.id, prodotti.{prodotto}.campo.'),
        check('Request pluggable (estendibile per prodotto)', !!t.extensions.request, function (on) { t.extensions.request = on; })),
      section('Output',
        listEditor(t.outputs, ['name', 'type', 'description'], { name: 'Nome (percorso)', type: 'Tipo', description: 'Descrizione' },
          function () { return { name: 'nuovoOutput', type: 'string', description: '' }; }, { importFields: true }),
        productResultsEditor(t)),
      section('Esiti supportati',
        h('div', null,
          check('OK', true, function () { }),
          check('KO', t.outcomes.indexOf('KO') >= 0, function (on) { toggleIn(t.outcomes, 'KO', on); }),
          check('KO con task manuale', t.outcomes.indexOf('KO_TASK') >= 0, function (on) { toggleIn(t.outcomes, 'KO_TASK', on); }),
          check('KO pluggable (gestione KO specifica per prodotto)', !!t.extensions.ko, function (on) { t.extensions.ko = on; }))),
      section('Default per i nuovi blocchi',
        h('div', { class: 'row2' },
          field('Retry (tentativi)', input(t.defaults.retry, 'count', { type: 'number' })),
          field('Intervallo retry (s)', input(t.defaults.retry, 'intervalSec', { type: 'number' }))),
        h('div', { class: 'row2' },
          field('Coda task manuale (KO con task)', input(t.defaults, 'koQueue', { placeholder: 'es. BO_ANTIFRODE' })),
          t.type === 'async' ? field('Topic callback', input(t.defaults, 'callbackTopic', { placeholder: 'es. bo.pratiche.esiti' })) : h('div'))),
      section('Utilizzato nelle offerte', used.length ? h('div', null, used.map(function (n) { return h('span', { class: 'chip' }, n); })) : h('div', { class: 'muted' }, 'Non utilizzato.')),
      h('div', { class: 'panel-actions' },
        h('button', { onclick: function () { duplicateTask(t); } }, '⧉ Duplica'),
        h('button', { class: 'danger', onclick: function () { deleteTask(t); } }, '🗑 Elimina task')));
  }

  /* Il servizio risponde con una lista che ha un risultato per ogni prodotto: da lì la dashboard ricava l'esito di ciascun prodotto. */
  function productResultsEditor(t) {
    const lists = Fields.listKeys(t.outputs).map(function (k) { return k.slice(0, -2); }).filter(function (k) { return k.indexOf('[]') < 0; });
    const pr = t.productResults;
    const csv = function (arr) { return (arr || []).join(', '); };
    const parse = function (v) { return String(v).split(',').map(function (x) { return x.trim(); }).filter(Boolean); };
    return h('div', { class: 'pr-box' },
      check('Il servizio restituisce una lista con un risultato per prodotto', !!pr, function (on) {
        t.productResults = on ? { list: lists[0] || 'risultati', productField: 'prodotto', outcomeField: 'esito', ok: ['OK'], koTask: [] } : null;
        save(); render();
      }),
      pr ? h('div', null,
        h('div', { class: 'row3' },
          field('Lista', h('input', { type: 'text', list: 'pr-lists', value: pr.list, onchange: function (e) { pr.list = e.target.value.trim(); save(); } })),
          field('Campo prodotto', input(pr, 'productField')),
          field('Campo esito', input(pr, 'outcomeField'))),
        h('datalist', { id: 'pr-lists' }, lists.map(function (l) { return h('option', { value: l }); })),
        h('div', { class: 'row2' },
          field('Valori di esito = OK', h('input', { type: 'text', value: csv(pr.ok), onchange: function (e) { pr.ok = parse(e.target.value); save(); } })),
          field('Valori = KO con task manuale', h('input', { type: 'text', value: csv(pr.koTask), onchange: function (e) { pr.koTask = parse(e.target.value); save(); } }))),
        h('div', { class: 'field-hint' }, 'Aggiungi agli output i campi ' + pr.list + '[].' + pr.productField + ' e ' + pr.list + '[].' + pr.outcomeField + '. Ogni altro valore di esito vale KO. Nei blocchi successivi: esiti.<blocco>.' + pr.list + '[].campo = tutti gli elementi, ' + pr.list + '[@].campo = quello del prodotto corrente.')) : h('div', { class: 'field-hint' }, 'Esempio: una chiamata per N prodotti che risponde con { risultati: [ { prodotto, esito, … } ] }. Il worker non deve costruire productOutcomes.'));
  }

  /* Tabella editabile per input/output/campi: tipo, filtro (i task possono avere ~100 campi) e import da JSON Schema o JSON di esempio. */
  function listEditor(arr, cols, labels, factory, opts) {
    opts = opts || {};
    let f = '';
    const tbody = h('tbody');
    const count = h('span', { class: 'muted' });
    const fill = function () {
      tbody.innerHTML = '';
      const q = f.trim().toLowerCase();
      arr.forEach(function (row, i) {
        if (q && (String(row.name || '') + ' ' + String(row.description || '') + ' ' + String(row.source || '')).toLowerCase().indexOf(q) < 0) return;
        tbody.append(h('tr', null, cols.map(function (c) {
          if (c === 'required') return h('td', { class: 'center' }, h('input', { type: 'checkbox', checked: !!row[c], onchange: function (e) { row[c] = e.target.checked; save(); } }));
          if (c === 'type') return h('td', null, h('select', { value: row.type || 'string', onchange: function (e) { row.type = e.target.value; save(); } }, Fields.TYPES.map(function (t) { return h('option', { value: t }, t); })));
          return h('td', null, h('input', { type: 'text', value: row[c] || '', oninput: function (e) { row[c] = e.target.value; save(); } }));
        }), h('td', null, h('button', { class: 'icon danger', title: 'Rimuovi', onclick: function () { arr.splice(i, 1); save(); fill(); } }, '✕'))));
      });
      count.textContent = arr.length + ' campi';
    };
    fill();
    const table = h('table', { class: 'tbl edit' },
      h('thead', null, h('tr', null, cols.map(function (c) { return h('th', null, labels[c]); }), h('th'))), tbody);
    return h('div', null,
      arr.length > 8 || opts.filterable ? h('div', { class: 'map-tools' }, h('input', { type: 'search', placeholder: 'Filtra per nome o descrizione…', oninput: function (e) { f = e.target.value; fill(); } }), count) : null,
      h('div', { class: opts.scroll === false ? '' : 'tbl-scroll' }, table),
      h('div', { class: 'row-actions' },
        h('button', { class: 'small', onclick: function () { arr.push(factory()); save(); fill(); } }, '+ Aggiungi'),
        opts.importFields ? h('button', { class: 'small', title: 'Incolla un JSON Schema (anche con $ref locali) o un JSON di esempio: i campi vengono aggiunti o aggiornati', onclick: function () {
          importModal(function (fields) {
            let added = 0;
            fields.forEach(function (x) {
              const cur = arr.find(function (r) { return r.name === x.name; });
              if (cur) { cur.type = x.type; if (x.description && !cur.description) cur.description = x.description; if (x.required) cur.required = true; return; }
              const row = factory();
              row.name = x.name; row.type = x.type; row.required = !!x.required; row.description = x.description || '';
              arr.push(row); added++;
            });
            save(); fill();
            toast(fields.length + ' campi letti (' + added + ' nuovi)', 'ok');
          });
        } }, '⇪ Importa da JSON Schema / esempio') : null,
        opts.extra || null));
  }

  function importModal(onApply) {
    const ta = h('textarea', { rows: 14, placeholder: 'Incolla qui un JSON Schema (es. lo schema del body da OpenAPI) oppure un JSON di esempio della request/response', style: { width: '100%', fontFamily: 'monospace', fontSize: '12px' } });
    const file = h('input', { type: 'file', accept: '.json,application/json', onchange: function (e) {
      const fl = e.target.files[0]; if (!fl) return;
      const r = new FileReader(); r.onload = function () { ta.value = String(r.result); }; r.readAsText(fl);
    } });
    Util.modal('Importa campi', h('div', null,
      h('p', { class: 'muted' }, 'Gli oggetti annidati diventano nomi con il punto (cliente.documento.numero). Gli array di oggetti diventano campi di lista (spedizioni[].cap); gli array di valori restano un unico campo. Se il campo esiste già ne viene aggiornato il tipo.'),
      file, ta), [{
      label: 'Importa', class: 'primary', onClick: function () {
        const r = Fields.parse(ta.value);
        if (r.error) return toast(r.error, 'error');
        Util.closeModal();
        onApply(r.fields);
      }
    }]);
  }

  function practiceEditor() {
    const fields = data.practice.fields;
    return h('div', { class: 'editor-card' },
      h('div', { class: 'panel-head block-head' }, h('div', { class: 'panel-kicker' }, 'Input generale del processo'), h('h3', null, 'Modello della pratica'),
        h('div', { class: 'muted' }, 'Dati con cui parte la pratica: i task li leggono con percorsi come cliente.codiceFiscale, e diventano lo schema di input del workflow generato. pratica.id è sempre presente (correlazione eventi).')),
      section('Campi',
        listEditor(fields, ['name', 'type', 'required', 'description'], { name: 'Percorso', type: 'Tipo', required: 'Obbl.', description: 'Descrizione' },
          function () { return { name: 'sezione.campo', type: 'string', required: false, description: '' }; },
          {
            filterable: true, importFields: true,
            extra: [
              h('button', { class: 'small', title: 'Aggiunge i percorsi già usati nelle sorgenti dei task', onclick: function () {
                let n = 0;
                Fields.inferPractice(data.tasks).fields.forEach(function (x) { if (!fields.some(function (y) { return y.name === x.name; })) { fields.push(x); n++; } });
                save(); renderEditor(); toast(n + ' campi aggiunti dai task', 'ok');
              } }, 'Ricava dai task'),
              h('button', { class: 'small', onclick: function () { Store.download(Fields.toSchema(fields), 'pratica.schema.json'); } }, '⬇ JSON Schema')
            ]
          })));
  }

  function newProduct() {
    const name = prompt('Nome del prodotto');
    if (!name) return;
    const id = Util.uniqueId(Util.slug(name), data.products.map(function (p) { return p.id; }));
    data.products.push({ id: id, name: name, category: '', description: '' });
    sel = { type: 'product', id: id }; save(); render();
  }

  function newTask() {
    const name = prompt('Nome del task (es. Verifica IBAN)');
    if (!name) return;
    const id = Util.uniqueId(Util.slug(name), data.tasks.map(function (t) { return t.id; }));
    data.tasks.push({
      id: id, name: name, description: '', type: 'sync', scope: 'common', callMode: 'perOffer',
      compatibleProducts: data.products.map(function (p) { return p.id; }), allowedSteps: [],
      api: { method: 'POST', path: '' }, inputs: [], outputs: [], outcomes: ['OK', 'KO'],
      extensions: { request: false, ko: false }, defaults: { retry: { count: 0, intervalSec: 0 }, koQueue: '', callbackTopic: '' }
    });
    sel = { type: 'task', id: id }; save(); render();
  }

  function duplicateTask(t) {
    const c = Util.clone(t);
    c.id = Util.uniqueId(t.id + '_COPIA', data.tasks.map(function (x) { return x.id; }));
    c.name = t.name + ' (copia)';
    data.tasks.push(c);
    sel = { type: 'task', id: c.id }; save(); render();
  }

  function deleteTask(t) {
    const used = usage('task', t.id);
    if (used.length) return alert('Impossibile eliminare: il task è usato nelle offerte:\n- ' + used.join('\n- ') + '\n\nRimuovi prima i blocchi dalle offerte.');
    if (!confirm('Eliminare il task "' + t.name + '"?')) return;
    data.tasks = data.tasks.filter(function (x) { return x !== t; });
    sel = null; save(); render();
  }

  function deleteProduct(p) {
    const used = usage('product', p.id);
    if (!confirm('Eliminare il prodotto "' + p.name + '"?' + (used.length ? '\nVerrà rimosso anche dalle offerte: ' + used.join(', ') + ' (i blocchi rimasti senza prodotti saranno eliminati).' : ''))) return;
    data.products = data.products.filter(function (x) { return x !== p; });
    data.tasks.forEach(function (t) { t.compatibleProducts = t.compatibleProducts.filter(function (x) { return x !== p.id; }); });
    data.offers.forEach(function (o) {
      o.products = o.products.filter(function (x) { return x !== p.id; });
      o.blocks.forEach(function (b) { b.products = b.products.filter(function (x) { return x !== p.id; }); });
      const removed = o.blocks.filter(function (b) { return !b.products.length; }).map(function (b) { return b.id; });
      o.blocks = o.blocks.filter(function (b) { return b.products.length; });
      o.blocks.forEach(function (b) { b.dependsOn = b.dependsOn.filter(function (d) { return removed.indexOf(d) < 0; }); });
      o.gates.forEach(function (g) {
        g.rules = g.rules.filter(function (r) { return !(r.type === 'DONT_WAIT' && removed.indexOf(r.blockId) >= 0); });
        g.rules.forEach(function (r) { if (r.products) r.products = r.products.filter(function (x) { return x !== p.id; }); });
      });
    });
    sel = null; save(); render();
    toast('Prodotto eliminato', 'ok');
  }

  Store.bindTopbar(function () { return data; }, function (d) { data = d; sel = null; render(); });
  window.addEventListener('storage', function () { data = Store.load(); render(); });
  render();
})();
