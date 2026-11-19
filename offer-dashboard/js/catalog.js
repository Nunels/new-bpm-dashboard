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
        listEditor(t.inputs, ['name', 'source', 'required'], { name: 'Nome', source: 'Sorgente di default', required: 'Obbl.' }, function () { return { name: 'nuovoInput', source: '', required: false }; }),
        check('Request pluggable (estendibile per prodotto)', !!t.extensions.request, function (on) { t.extensions.request = on; })),
      section('Output',
        listEditor(t.outputs, ['name', 'description'], { name: 'Nome', description: 'Descrizione' }, function () { return { name: 'nuovoOutput', description: '' }; })),
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

  /* Tabella editabile per input/output. */
  function listEditor(arr, cols, labels, factory) {
    const table = h('table', { class: 'tbl edit' },
      h('thead', null, h('tr', null, cols.map(function (c) { return h('th', null, labels[c]); }), h('th'))),
      h('tbody', null, arr.map(function (row, i) {
        return h('tr', null, cols.map(function (c) {
          if (c === 'required') return h('td', { class: 'center' }, h('input', { type: 'checkbox', checked: !!row[c], onchange: function (e) { row[c] = e.target.checked; save(); } }));
          return h('td', null, h('input', { type: 'text', value: row[c] || '', oninput: function (e) { row[c] = e.target.value; save(); } }));
        }), h('td', null, h('button', { class: 'icon danger', title: 'Rimuovi', onclick: function () { arr.splice(i, 1); save(); renderEditor(); } }, '✕')));
      })));
    return h('div', null, table, h('button', { class: 'small', onclick: function () { arr.push(factory()); save(); renderEditor(); } }, '+ Aggiungi'));
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
