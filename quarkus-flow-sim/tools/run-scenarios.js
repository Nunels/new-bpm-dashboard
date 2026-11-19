/*
 * Esegue gli scenari di src/test/resources/scenarios.json contro un'istanza già avviata (mvn quarkus:dev o java -jar).
 * Uso: node tools/run-scenarios.js [--base http://localhost:8089] [--variant a|b] [--only testo]
 * Stessi confronti di ScenarioTest.java: stato finale, prodotti attivi, chiamate per servizio, tempi.
 */
const fs = require('fs'), path = require('path');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://localhost:8089'), VARIANT = arg('variant', 'a'), ONLY = arg('only', null);
const scenarios = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'src', 'test', 'resources', 'scenarios.json'), 'utf8'))
  .filter(s => !ONLY || (s.offerId + '/' + s.name).includes(ONLY));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
}
const sortedEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  let failed = 0;
  for (const sc of scenarios) {
    const wf = VARIANT === 'b' ? sc.workflow.replace('offers:', 'offers-java:') : sc.workflow;
    await call('POST', '/sim/reset');
    await call('PUT', '/sim/outcomes', sc.mock);
    await call('PUT', '/sim/latency', sc.latency);
    const t0 = Date.now();
    const res = await call('POST', '/run/' + wf, sc.input);
    const elapsed = Date.now() - t0;
    let result; try { result = res.json(); } catch (e) { result = { status: 'HTTP_' + res.status, raw: res.text.slice(0, 300) }; }
    const maxLat = Math.max(0, ...Object.values(sc.latency || {}));
    if (maxLat) await sleep(maxLat + 500);

    const problems = [];
    if (result.status !== sc.expected.status) problems.push(`stato: atteso ${sc.expected.status} ma ottenuto ${result.status}`);
    const got = ((result.output || {}).activeProducts || []).slice().sort();
    if (!sortedEq(got, sc.expected.activeProducts)) problems.push(`prodotti attivi: attesi [${sc.expected.activeProducts}] ma ottenuti [${got}]`);
    const calls = (await call('GET', '/sim/calls')).json();
    const gotCalls = {}; calls.forEach(c => { gotCalls[c.service] = (gotCalls[c.service] || 0) + 1; });
    const expCalls = {}; Object.entries(sc.expectedCalls).forEach(([k, v]) => { if (v > 0) expCalls[k] = v; });
    const keys = [...new Set([...Object.keys(gotCalls), ...Object.keys(expCalls)])].sort();
    if (keys.some(k => (gotCalls[k] || 0) !== (expCalls[k] || 0))) problems.push('chiamate per servizio: attese ' + JSON.stringify(expCalls) + ' ottenute ' + JSON.stringify(gotCalls));
    // prodotti inviati a ciascun servizio: devono coincidere con quelli eseguiti dal simulatore (blocchi dipendenti da un KO esclusi)
    const gotProducts = {}; calls.forEach(c => { gotProducts[c.service] = [...new Set([...(gotProducts[c.service] || []), ...(c.products || [])])].sort(); });
    Object.keys({ ...gotProducts, ...(sc.expectedProducts || {}) }).sort().forEach(k => {
      const exp = (sc.expectedProducts || {})[k] || [], got = gotProducts[k] || [];
      if (exp.length || got.length) if (!sortedEq(got, exp)) problems.push(`prodotti inviati a ${k}: attesi [${exp}] ma ottenuti [${got}]`);
    });
    if (sc.maxMillis && elapsed > sc.maxMillis) problems.push(`tempo: ${elapsed} ms oltre il massimo di ${sc.maxMillis} ms`);
    const notes = [];

    const tag = problems.length ? 'DIFF' : ' OK ';
    if (problems.length) failed++;
    console.log(`[${tag}] ${sc.offerId}/${sc.name}  (${elapsed} ms)`);
    problems.forEach(p => console.log('        - ' + p));
    notes.forEach(n => console.log('        i differenza nota: ' + n));
    if (problems.length && result.error) console.log('        errore: ' + JSON.stringify(result.error).slice(0, 300));
  }
  console.log(`\n${scenarios.length - failed}/${scenarios.length} scenari coincidono con il simulatore (variante ${VARIANT})`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Errore:', e.message); process.exit(2); });
