/* ─── UNLI CHIX — SECURITY ASSESSMENT · MODULE B ───────────────────────────
 * Traffic Resilience & Rate-Limiting Assessment (plawidnwad.md §3 Module B,
 * §6 Stage 3).
 *
 * A bounded, abortable load generator that measures how the app behaves under
 * controlled concurrency. It is deliberately incapable of being destructive:
 *   • 'branches' / 'menu'  → public Firestore READS (no writes).
 *   • 'createReservation'  → DRY-RUN: an intentionally invalid payload the
 *                            server rejects at argument validation, so no
 *                            reservation is ever written.
 * Every ceiling in config.js (max 50 concurrent, max 500 total) is clamped
 * here, and every request rides the run guard's AbortSignal so Emergency
 * Stop halts the whole fleet at once.
 * ───────────────────────────────────────────────────────────────────────── */
import { functions, db } from '../firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { LOAD, SEVERITY } from './config.js';
import { assertAllowedTarget, withDeadline, SafetyError } from './safety-guard.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

// Logical outcome → rough HTTP status, for the status-distribution readout.
function httpish(outcome, code) {
  if (outcome === 'ok') return 200;
  if (code === 'resource-exhausted') return 429;
  if (code === 'unavailable' || code === 'deadline-exceeded') return 503;
  if (code === 'invalid-argument' || code === 'failed-precondition' || code === 'permission-denied' || code === 'not-found') return 400;
  if (code === 'internal' || code === 'unknown') return 500;
  return 0; // aborted / timed out / client-side
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, idx)]);
}

// One unit of work for the chosen target. Returns a sample describing the
// outcome and latency — it never throws, so the pool keeps its accounting.
function makeRequest(target) {
  if (target === 'branches') {
    return () => getDocs(collection(db, 'branches')).then(() => ({ outcome: 'ok' }));
  }
  if (target === 'menu') {
    return () => getDocs(collection(db, 'menuItems')).then(() => ({ outcome: 'ok' }));
  }
  if (target === 'createReservation') {
    // DRY-RUN: party 0 is rejected with invalid-argument before any write.
    const fn = httpsCallable(functions, 'createReservation');
    return () => fn({ branch: 'dryrun', date: '1970-01-01', slot: '12:00', name: 'dryrun', party: 0 })
      .then(() => ({ outcome: 'ok' })) // would be a surprise (payload is invalid)
      .catch((e) => {
        const code = String(e.code || e.name || 'unknown').replace(/^functions\//, '');
        // The expected rejection is a *successful* probe of request handling.
        return { outcome: code === 'invalid-argument' ? 'rejected-expected' : 'error', code };
      });
  }
  throw new SafetyError(`Unknown load target "${target}".`, 'bad-target');
}

/* Runs the bounded simulation.
 * opts: { concurrency, totalRequests, rampMs, target, guard, onSample, onProgress }
 *   guard      — from safety-guard.createRunGuard(); provides .signal and .stop()
 *   onSample   — called per completed request with { t, latency, outcome, code }
 *   onProgress — called periodically with the live summary
 * Resolves with the final summary.
 */
export async function runControlledLoadSimulation(opts = {}) {
  assertAllowedTarget();
  const concurrency = clamp(opts.concurrency, LOAD.MIN_CONCURRENCY, LOAD.MAX_CONCURRENCY);
  const totalRequests = clamp(opts.totalRequests, LOAD.MIN_REQUESTS, LOAD.MAX_REQUESTS);
  const rampMs = clamp(opts.rampMs, LOAD.MIN_RAMP_MS, LOAD.MAX_RAMP_MS);
  const target = opts.target || 'branches';
  const guard = opts.guard;
  if (!guard) throw new SafetyError('A run guard is required (circuit breaker).', 'no-guard');
  const work = makeRequest(target);

  const latencies = [];
  const statusDist = {}; // httpish code → count
  const outcomeDist = { ok: 0, 'rejected-expected': 0, error: 0, aborted: 0 };
  const started = performance.now();
  let completed = 0, dispatched = 0;

  const bump = (k, map) => { map[k] = (map[k] || 0) + 1; };

  function summarize(done = false) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const elapsedS = (performance.now() - started) / 1000;
    const errors = outcomeDist.error + outcomeDist.aborted;
    return {
      module: 'B', id: 'load-sim', title: 'Controlled Concurrency Simulation',
      target, concurrency, totalRequests, rampMs,
      dispatched, completed,
      latency: { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: percentile(sorted, 100), avg: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0 },
      rps: elapsedS > 0 ? +(completed / elapsedS).toFixed(2) : 0,
      elapsedS: +elapsedS.toFixed(2),
      statusDist: { ...statusDist },
      outcomeDist: { ...outcomeDist },
      errorRate: completed ? +((errors / completed) * 100).toFixed(1) : 0,
      done,
      stopped: guard.stopped,
      finishedAt: done ? new Date().toISOString() : null,
    };
  }

  // Light pacing during ramp-up: delay before launching each worker so the
  // fleet grows over rampMs rather than all at once.
  const workerStagger = concurrency > 1 ? rampMs / concurrency : 0;
  let progressTimer = null;
  if (typeof opts.onProgress === 'function') {
    progressTimer = setInterval(() => { if (!guard.stopped) opts.onProgress(summarize(false)); }, 400);
  }

  async function worker(launchDelay) {
    if (launchDelay) await sleep(launchDelay, guard);
    while (!guard.stopped && dispatched < totalRequests) {
      const myIndex = dispatched++;
      if (myIndex >= totalRequests) break;
      const t0 = performance.now();
      let sample;
      try {
        const res = await withDeadline(work(), LOAD.PER_REQUEST_TIMEOUT_MS, guard);
        sample = { latency: performance.now() - t0, outcome: res.outcome, code: res.code };
      } catch (e) {
        const aborted = (e && e.code === 'aborted');
        sample = { latency: performance.now() - t0, outcome: aborted ? 'aborted' : 'error', code: e && e.code };
      }
      completed++;
      latencies.push(sample.latency);
      bump(sample.outcome, outcomeDist);
      bump(httpish(sample.outcome === 'rejected-expected' ? 'error' : sample.outcome, sample.code), statusDist);
      if (typeof opts.onSample === 'function') {
        opts.onSample({ t: performance.now() - started, latency: Math.round(sample.latency), outcome: sample.outcome, code: sample.code });
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker(Math.round(i * workerStagger)));
  await Promise.all(workers);

  if (progressTimer) clearInterval(progressTimer);
  const final = summarize(true);
  final.severity = final.errorRate === 0 ? SEVERITY.PASS : (final.errorRate < 5 ? SEVERITY.LOW : SEVERITY.MEDIUM);
  final.summary = guard.stopped
    ? `Stopped early (${guard.reason}): ${completed}/${totalRequests} completed, p95 ${final.latency.p95}ms.`
    : `${completed} requests at ${final.rps} RPS · p50 ${final.latency.p50}ms · p95 ${final.latency.p95}ms · p99 ${final.latency.p99}ms · error rate ${final.errorRate}%.`;
  guard.finish();
  return final;
}

// ─── Rate-Limiting & Backoff Validator ──────────────────────────────────────
// Fires a tight burst of dry-run calls and reports whether the backend damps the
// burst (429 / resource-exhausted / rising latency) or serves it all flat. On a
// bare emulator throttling is usually absent — that is reported as INFO, not a
// failure, since rate-limiting belongs to the hosting/App Check layer in prod.
export async function testRateLimitAndThrottleValidator(opts = {}) {
  assertAllowedTarget();
  const guard = opts.guard;
  if (!guard) throw new SafetyError('A run guard is required.', 'no-guard');
  const burst = clamp(opts.burst || 30, 5, 50);
  const work = makeRequest('createReservation'); // dry-run, non-mutating

  const samples = [];
  const t0 = performance.now();
  const calls = Array.from({ length: burst }, async () => {
    const s = performance.now();
    let code = 'ok';
    try { const res = await withDeadline(work(), LOAD.PER_REQUEST_TIMEOUT_MS, guard); code = res.code || res.outcome; }
    catch (e) { code = (e && e.code) || 'error'; }
    samples.push({ latency: performance.now() - s, code });
  });
  await Promise.all(calls);

  const throttled = samples.filter(s => s.code === 'resource-exhausted' || s.code === 'unavailable').length;
  const sorted = samples.map(s => s.latency).sort((a, b) => a - b);
  const r = {
    module: 'B', id: 'rate-limit', title: 'Rate-Limiting & Backoff',
    burst, throttled,
    latency: { p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: percentile(sorted, 100) },
    elapsedS: +((performance.now() - t0) / 1000).toFixed(2),
    steps: [
      { label: `burst of ${burst} dry-run calls`, status: 'info', detail: `${throttled} throttled, p95 ${percentile(sorted, 95)}ms` },
    ],
    finishedAt: new Date().toISOString(),
  };
  r.passed = throttled > 0 ? true : null;
  r.severity = throttled > 0 ? SEVERITY.PASS : SEVERITY.INFO;
  r.summary = throttled > 0
    ? `Backend damped the burst: ${throttled}/${burst} calls were throttled (resource-exhausted/unavailable).`
    : `No throttling observed on this target. Rate-limiting in production is enforced by hosting/App Check, not the emulator.`;
  guard.finish();
  return r;
}

// ─── Emergency Stop ─────────────────────────────────────────────────────────
// The circuit breaker. Aborts every in-flight request through the shared guard.
export function executeEmergencyStop(guard, reason = 'emergency-stop') {
  if (guard && typeof guard.stop === 'function') guard.stop(reason);
}

function sleep(ms, guard) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    guard?.signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(new SafetyError('Aborted during ramp.', 'aborted')); }, { once: true });
  });
}
