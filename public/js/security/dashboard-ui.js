/* ─── UNLI CHIX — SECURITY ASSESSMENT · DASHBOARD UI ────────────────────────
 * Wires the assessment modules to the page (plawidnwad.md §4 architecture,
 * §5 UI spec, §6 Stage 5). Builds the tabs, test cards, resilience controls,
 * live sparkline, output console, audit history, and report export — and routes
 * every run through the safety guard and a shared circuit-breaker.
 * ───────────────────────────────────────────────────────────────────────── */
import { assertSafeToRun, createRunGuard, SafetyError, targetKind } from './safety-guard.js';
import { LOAD, SEVERITY, isEmulatorSession } from './config.js';
import { TAMPERING_TESTS } from './tampering-tests.js';
import { runControlledLoadSimulation, testRateLimitAndThrottleValidator, executeEmergencyStop } from './resilience-tests.js';
import { TasModule } from './tas-tests.js';
import { buildReport, downloadJson, downloadMarkdown } from './report-generator.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

// Shared state ----------------------------------------------------------------
let environment = null;
let activeGuard = null;                 // the circuit-breaker for the current run
const latestResults = new Map();        // id → result object (for report export)
const history = loadHistory();          // past run batches (this tab)

const CARD_DESC = {
  'party-size': 'Submits zero/negative/oversized/non-integer party values to createReservation and expects invalid-argument on every one.',
  'role-escalation': 'Attempts a direct Firestore write to raise your own role to staff/manager; expects PERMISSION_DENIED.',
  'idor': 'Tries to reschedule a ticket you do not own; expects the server to refuse (permission-denied / not-found).',
  'operating-hours': 'Books an active branch at 03:30 and 23:59; expects failed-precondition (outside branch hours).',
  'quota': 'Emulator only. Fills 5 active reservations, expects the 6th to be refused with resource-exhausted, then reverts them.',
};

// ─── CONSOLE ─────────────────────────────────────────────────────────────────
function log(msg, kind = 'info') {
  const box = $('secConsole');
  const ln = el('div', `ln ${kind}`);
  ln.append(el('span', 'ts', new Date().toLocaleTimeString()), el('span', 'msg', msg));
  box.append(ln);
  box.scrollTop = box.scrollHeight;
}

// ─── STARTUP: safety gate ─────────────────────────────────────────────────────
async function start() {
  try {
    environment = await assertSafeToRun();
    showBanner(environment);
    $('secApp').hidden = false;
    $('estop').disabled = false;
    buildTabs();
    buildIntegrityPanel();
    buildResiliencePanel();
    buildTasPanel();
    buildAuditPanel();
    log(`Authorized: ${environment.email} (${environment.role}) on ${environment.host} [${environment.kind}].`, 'ok');
    if (environment.kind === 'staging') log('Staging target: write-bearing tests (quota) are disabled; rejection tests remain active.', 'warn');
    if (!isEmulatorSession()) log('Not an emulator session. Open with ?emulator for the full suite (quota test).', 'info');
  } catch (e) {
    lockOut(e);
  }
}

function showBanner(env) {
  const badge = $('secTargetBadge');
  badge.className = `sec-badge is-${env.kind}`;
  badge.textContent = env.kind === 'local' ? 'LOCAL EMULATOR' : env.kind === 'staging' ? 'AUTHORIZED STAGING' : 'BLOCKED';
  const code = text => el('code', '', String(text));
  $('secBannerText').replaceChildren('Target ', code(env.host), ' · operator ', code(env.email), ' · role ', code(env.role), '. All runs are bounded and abortable.');
}

function lockOut(e) {
  const badge = $('secTargetBadge');
  badge.className = 'sec-badge is-blocked';
  badge.textContent = 'BLOCKED';
  $('secBannerText').textContent = 'Assessment suite is not available here.';
  $('secLocked').hidden = false;
  $('secApp').hidden = true;
  $('estop').disabled = true;
  const msg = (e instanceof SafetyError) ? e.message : (e && e.message) || 'Unknown error.';
  $('secLockedMsg').textContent = msg;
  log(`Locked: ${msg}`, 'fail');
}

// ─── TABS ─────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'integrity', label: 'Parameter Integrity' },
  { id: 'resilience', label: 'Traffic Resilience' },
  { id: 'tas', label: 'TAS (Reserved)' },
  { id: 'audit', label: 'Audit History' },
];
function buildTabs() {
  const bar = $('secTabs');
  TABS.forEach((t, i) => {
    const b = el('button', 'sec-tab', t.label);
    b.id = `tab-${t.id}`; b.type = 'button'; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    b.setAttribute('aria-controls', `panel-${t.id}`);
    b.tabIndex = i === 0 ? 0 : -1;
    b.addEventListener('click', () => selectTab(t.id));
    bar.append(b);
  });
  // ARIA tabs: arrow keys, Home and End move between tabs.
  bar.addEventListener('keydown', e => {
    const i = TABS.findIndex(t => `tab-${t.id}` === document.activeElement.id);
    if (i < 0) return;
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const t = TABS[(to + TABS.length) % TABS.length];
    selectTab(t.id);
    $(`tab-${t.id}`).focus();
  });
}
function selectTab(id) {
  TABS.forEach(t => {
    $(`tab-${t.id}`).setAttribute('aria-selected', String(t.id === id));
    $(`tab-${t.id}`).tabIndex = t.id === id ? 0 : -1;
    $(`panel-${t.id}`).hidden = t.id !== id;
  });
  if (id === 'audit') renderAudit();
}

// ─── PANEL A: PARAMETER INTEGRITY ──────────────────────────────────────────────
function buildIntegrityPanel() {
  const p = $('panel-integrity');
  p.innerHTML = '';
  const bar = el('div', 'sec-runbar');
  const runAll = el('button', 'btn-primary', 'Run all integrity tests');
  runAll.type = 'button';
  runAll.addEventListener('click', () => runIntegritySuite(runAll));
  const dlJson = el('button', 'btn-ghost', 'Download JSON report');
  dlJson.type = 'button';
  dlJson.addEventListener('click', () => exportReport('json'));
  const dlMd = el('button', 'btn-ghost', 'Download Markdown report');
  dlMd.type = 'button';
  dlMd.addEventListener('click', () => exportReport('md'));
  bar.append(runAll, dlJson, dlMd);
  p.append(bar);

  const grid = el('div', 'sec-grid');
  grid.id = 'integrityGrid';
  TAMPERING_TESTS.forEach(t => grid.append(buildCard(t)));
  p.append(grid);
}

function buildCard(test) {
  const card = el('div', 'sec-card');
  card.id = `card-${test.id}`;
  card.dataset.verdict = 'pending';
  const verdict = el('span', 'sec-verdict', 'NOT RUN');
  verdict.dataset.v = 'pending';
  card.append(verdict);
  card.append(el('h3', null, test.title));
  card.append(el('p', 'sec-desc', CARD_DESC[test.id] || ''));
  const summary = el('p', 'sec-summary');
  summary.hidden = true;
  card.append(summary);
  const steps = el('ul', 'sec-steps'); steps.hidden = true;
  card.append(steps);
  const run = el('button', 'btn-ghost', 'Run test');
  run.type = 'button';
  run.addEventListener('click', () => runOne(test, run));
  card.append(run);
  return card;
}

function paintCard(test, res, { running = false } = {}) {
  const card = $(`card-${test.id}`);
  if (!card) return;
  card.dataset.running = String(running);
  const verdict = card.querySelector('.sec-verdict');
  const summary = card.querySelector('.sec-summary');
  const steps = card.querySelector('.sec-steps');
  if (running) {
    card.dataset.verdict = 'running';
    verdict.dataset.v = 'running'; verdict.textContent = 'RUNNING…';
    summary.hidden = true; steps.hidden = true;
    return;
  }
  const v = res.passed === true ? 'pass' : res.passed === false ? res.severity : 'skipped';
  card.dataset.verdict = v;
  verdict.dataset.v = v;
  verdict.textContent = res.passed === true ? 'PASS' : res.passed === false ? `FAIL · ${String(res.severity).toUpperCase()}` : 'SKIPPED';
  summary.textContent = res.summary || '';
  summary.hidden = !res.summary;
  steps.innerHTML = '';
  (res.steps || []).forEach(s => {
    const li = el('li');
    const mk = el('span', `mk ${s.status}`, s.status === 'ok' ? '✓' : s.status === 'fail' ? '✗' : s.status === 'warn' ? '!' : '·');
    const body = el('span');
    body.append(el('span', null, s.label));
    if (s.detail) { body.append(document.createTextNode(' ')); body.append(el('span', 'st-detail', `— ${s.detail}`)); }
    li.append(mk, body);
    steps.append(li);
  });
  steps.hidden = !(res.steps && res.steps.length);
}

async function runOne(test, btn) {
  if (btn) btn.disabled = true;
  paintCard(test, null, { running: true });
  log(`▶ ${test.title}…`, 'info');
  try {
    const res = await test.run();
    latestResults.set(res.id, res);
    paintCard(test, res);
    log(`${verdictWord(res)} — ${test.title}: ${res.summary || ''}`, res.passed === true ? 'ok' : res.passed === false ? 'fail' : 'warn');
    return res;
  } catch (e) {
    const res = { id: test.id, module: 'A', title: test.title, passed: null, severity: SEVERITY.SKIPPED, summary: e.message, steps: [{ label: 'error', status: 'warn', detail: e.message }], finishedAt: new Date().toISOString() };
    latestResults.set(test.id, res);
    paintCard(test, res);
    log(`⚠ ${test.title}: ${e.message}`, 'warn');
    return res;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runIntegritySuite(btn) {
  btn.disabled = true;
  const batch = [];
  log('━━ Running full parameter-integrity suite ━━', 'info');
  for (const t of TAMPERING_TESTS) batch.push(await runOne(t));
  recordHistory('Parameter Integrity', batch);
  btn.disabled = false;
  log('━━ Integrity suite complete ━━', 'info');
}

const verdictWord = (r) => r.passed === true ? '✅ PASS' : r.passed === false ? '❌ FAIL' : '➖ SKIP';

// ─── PANEL B: TRAFFIC RESILIENCE ───────────────────────────────────────────────
function buildResiliencePanel() {
  const p = $('panel-resilience');
  p.innerHTML = '';
  const cfg = el('div', 'sec-config');

  const conc = rangeField('Concurrency (simulated users)', 'cfgConcurrency', LOAD.MIN_CONCURRENCY, LOAD.MAX_CONCURRENCY, LOAD.DEFAULT_CONCURRENCY, `Max ${LOAD.MAX_CONCURRENCY}.`);
  const total = rangeField('Total requests', 'cfgTotal', LOAD.MIN_REQUESTS, LOAD.MAX_REQUESTS, LOAD.DEFAULT_REQUESTS, `Max ${LOAD.MAX_REQUESTS}.`, 10);
  const ramp = rangeField('Ramp-up (seconds)', 'cfgRamp', LOAD.MIN_RAMP_MS / 1000, LOAD.MAX_RAMP_MS / 1000, LOAD.DEFAULT_RAMP_MS / 1000, 'Spreads worker start-up.');

  const targetField = el('div', 'sec-field');
  targetField.append(el('label', null, 'Target route'));
  const sel = el('select'); sel.id = 'cfgTarget';
  [['branches', '/branches — public read'], ['menu', '/menu — public read'], ['createReservation', 'createReservation — dry-run (rejected payload, no writes)']]
    .forEach(([v, t]) => { const o = el('option', null, t); o.value = v; sel.append(o); });
  targetField.append(sel);
  targetField.append(el('p', 'form-hint', 'Reads are non-mutating; the callable runs in dry-run only and never writes a reservation.'));

  cfg.append(conc.field, total.field, ramp.field, targetField);
  p.append(cfg);

  const bar = el('div', 'sec-runbar'); bar.style.marginTop = '1.5rem';
  const run = el('button', 'btn-primary', 'Run load simulation'); run.type = 'button'; run.id = 'runLoad';
  const burst = el('button', 'btn-ghost', 'Rate-limit burst probe'); burst.type = 'button'; burst.id = 'runBurst';
  run.addEventListener('click', () => runLoad(run, burst));
  burst.addEventListener('click', () => runBurst(run, burst));
  bar.append(run, burst);
  p.append(bar);

  // Live metrics
  const metrics = el('div', 'sec-metrics'); metrics.id = 'loadMetrics';
  [['mRps', 'RPS', ''], ['mP50', 'p50', 'ms'], ['mP95', 'p95', 'ms'], ['mP99', 'p99', 'ms'], ['mErr', 'Error rate', '%'], ['mDone', 'Completed', '']]
    .forEach(([id, label, unit]) => {
      const m = el('div', 'sec-metric');
      m.append(el('span', 'label', label));
      const strong = el('strong', null, '—'); strong.id = id;
      m.append(strong);
      if (unit) m.append(el('small', null, unit));
      metrics.append(m);
    });
  p.append(metrics);

  const chartWrap = el('div', 'sec-chart-wrap');
  chartWrap.append(el('h3', null, 'Live latency & throughput'));
  chartWrap.append(el('p', 'label', 'Per-request latency (ms) over the run'));
  const canvas = el('canvas', 'sec-chart'); canvas.id = 'loadChart'; canvas.width = 900; canvas.height = 160;
  chartWrap.append(canvas);
  p.append(chartWrap);
}

function rangeField(label, id, min, max, def, hint, stepAttr) {
  const field = el('div', 'sec-field');
  field.append(el('label', null, label));
  const row = el('div', 'sec-range-row');
  const input = el('input'); input.type = 'range'; input.id = id; input.min = min; input.max = max; input.value = def;
  if (stepAttr) input.step = stepAttr;
  const out = el('output', null, String(def));
  input.addEventListener('input', () => { out.textContent = input.value; });
  row.append(input, out);
  field.append(row);
  if (hint) field.append(el('p', 'form-hint', hint));
  return { field, input };
}

function resetMetrics() {
  ['mRps', 'mP50', 'mP95', 'mP99', 'mErr', 'mDone'].forEach(id => { $(id).textContent = '—'; });
}
function paintMetrics(s) {
  $('mRps').textContent = s.rps; $('mP50').textContent = s.latency.p50; $('mP95').textContent = s.latency.p95;
  $('mP99').textContent = s.latency.p99; $('mErr').textContent = s.errorRate; $('mDone').textContent = `${s.completed}/${s.totalRequests}`;
}

// Simple rolling sparkline drawn from latency samples.
const chartSamples = [];
function resetChart() { chartSamples.length = 0; drawChart(); }
function pushSample(sample) { chartSamples.push(sample.latency); if (chartSamples.length > 500) chartSamples.shift(); drawChart(); }
function drawChart() {
  const c = $('loadChart'); if (!c) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!chartSamples.length) return;
  const max = Math.max(...chartSamples, 1);
  const n = chartSamples.length;
  const stepX = c.width / Math.max(n - 1, 1);
  // area + line
  ctx.beginPath();
  chartSamples.forEach((v, i) => {
    const x = i * stepX;
    const y = c.height - (v / max) * (c.height - 12) - 6;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#d94b26'; ctx.lineWidth = 2; ctx.stroke();
  // max label
  ctx.fillStyle = '#785e4d'; ctx.font = "11px 'DM Mono', monospace";
  ctx.fillText(`max ${Math.round(max)}ms · ${n} reqs`, 8, 14);
}

function newGuard(onStopMsg) {
  activeGuard = createRunGuard({
    onStop: (why) => { log(`■ Stopped (${why}).`, 'warn'); if (onStopMsg) onStopMsg(why); },
  });
  return activeGuard;
}

async function runLoad(runBtn, burstBtn) {
  const concurrency = +$('cfgConcurrency').value;
  const totalRequests = +$('cfgTotal').value;
  const rampMs = (+$('cfgRamp').value) * 1000;
  const target = $('cfgTarget').value;
  runBtn.disabled = true; burstBtn.disabled = true;
  resetMetrics(); resetChart();
  log(`▶ Load sim: ${concurrency} users · ${totalRequests} reqs · ${rampMs / 1000}s ramp · target ${target}`, 'info');
  const guard = newGuard();
  try {
    const summary = await runControlledLoadSimulation({
      concurrency, totalRequests, rampMs, target, guard,
      onSample: pushSample,
      onProgress: paintMetrics,
    });
    paintMetrics(summary);
    latestResults.set('load-sim', summary);
    recordHistory('Traffic Resilience', [summary]);
    log(`${summary.stopped ? '■' : '✓'} Load sim: ${summary.summary}`, summary.stopped ? 'warn' : 'ok');
  } catch (e) {
    log(`⚠ Load sim failed: ${e.message}`, 'fail');
  } finally {
    runBtn.disabled = false; burstBtn.disabled = false; activeGuard = null;
  }
}

async function runBurst(runBtn, burstBtn) {
  runBtn.disabled = true; burstBtn.disabled = true;
  log('▶ Rate-limit burst probe (30 dry-run calls)…', 'info');
  const guard = newGuard();
  try {
    const res = await testRateLimitAndThrottleValidator({ burst: 30, guard });
    latestResults.set('rate-limit', res);
    recordHistory('Rate-Limit Probe', [res]);
    log(`${res.passed ? '✓' : '·'} ${res.summary}`, res.passed ? 'ok' : 'info');
  } catch (e) {
    log(`⚠ Burst probe failed: ${e.message}`, 'fail');
  } finally {
    runBtn.disabled = false; burstBtn.disabled = false; activeGuard = null;
  }
}

// ─── PANEL C: TAS (RESERVED) ───────────────────────────────────────────────────
async function buildTasPanel() {
  const p = $('panel-tas');
  p.innerHTML = '';
  const res = await TasModule.run();
  const box = el('div', 'sec-tas');
  box.append(el('span', 'sec-badge', TasModule.status));
  box.append(el('h3', null, 'TAS Assessment'));
  (res.steps || []).forEach(s => box.append(el('p', 'sec-desc', s.detail)));
  p.append(box);
}

// ─── PANEL D: AUDIT HISTORY ─────────────────────────────────────────────────────
function buildAuditPanel() { renderAudit(); }
function renderAudit() {
  const p = $('panel-audit');
  p.innerHTML = '';
  const bar = el('div', 'sec-runbar');
  const dlJson = el('button', 'btn-ghost', 'Download latest (JSON)'); dlJson.type = 'button';
  const dlMd = el('button', 'btn-ghost', 'Download latest (Markdown)'); dlMd.type = 'button';
  dlJson.addEventListener('click', () => exportReport('json'));
  dlMd.addEventListener('click', () => exportReport('md'));
  const clear = el('button', 'btn-ghost', 'Clear history'); clear.type = 'button';
  clear.addEventListener('click', () => { history.length = 0; saveHistory(); renderAudit(); });
  bar.append(dlJson, dlMd, clear);
  p.append(bar);

  if (!history.length) { p.append(el('div', 'sec-empty', 'No runs recorded yet in this session.')); return; }
  const list = el('div', 'sec-audit');
  [...history].reverse().forEach(h => {
    const row = el('div', 'sec-audit-row');
    const meta = el('div', 'meta', h.label);
    meta.append(el('small', null, new Date(h.at).toLocaleString()));
    const tally = el('div', 'sec-audit-tally');
    tally.append(el('span', 'sec-tally pass', `${h.passed} pass`));
    tally.append(el('span', 'sec-tally fail', `${h.failed} fail`));
    tally.append(el('span', 'sec-tally skip', `${h.skipped} skip`));
    row.append(meta, tally);
    list.append(row);
  });
  p.append(list);
}

function recordHistory(label, results) {
  let passed = 0, failed = 0, skipped = 0;
  results.forEach(r => { if (r.passed === true) passed++; else if (r.passed === false) failed++; else skipped++; });
  history.push({ label, at: new Date().toISOString(), passed, failed, skipped });
  if (history.length > 50) history.shift();
  saveHistory();
  if (!$('panel-audit').hidden) renderAudit();
}
function loadHistory() {
  try { return JSON.parse(sessionStorage.getItem('unli-sec-history') || '[]'); } catch { return []; }
}
function saveHistory() {
  try { sessionStorage.setItem('unli-sec-history', JSON.stringify(history)); } catch { /* storage blocked */ }
}

// ─── REPORT EXPORT ──────────────────────────────────────────────────────────────
function exportReport(fmt) {
  if (!latestResults.size) { log('Nothing to export yet — run a test first.', 'warn'); return; }
  const report = buildReport({ results: [...latestResults.values()], environment });
  if (fmt === 'json') downloadJson(report); else downloadMarkdown(report);
  log(`Downloaded ${fmt.toUpperCase()} report (${report.results.length} results).`, 'ok');
}

// ─── EMERGENCY STOP ───────────────────────────────────────────────────────────
$('estop').addEventListener('click', () => {
  if (activeGuard && !activeGuard.stopped) { executeEmergencyStop(activeGuard); log('■ EMERGENCY STOP pressed.', 'fail'); }
  else log('No run is currently active.', 'info');
});

// Wait for the session to settle, then gate.
if (window.UnliSession && UnliSession.ready()) start();
else window.addEventListener('unli-auth-ready', start, { once: true });
