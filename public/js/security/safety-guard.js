/* ─── UNLI CHIX — SECURITY ASSESSMENT · SAFETY GUARD ───────────────────────
 * The gate every assessment must pass through before it touches the network
 * (plawidnwad.md §1 Safety Framework, §3 Safety Controls, §6 Stage 1).
 *
 * Three jobs:
 *   1. Target allowlisting   — refuse any origin that isn't loopback or the one
 *                              authorized staging host.
 *   2. Role verification     — refuse anyone who isn't a signed-in manager.
 *   3. Run lifecycle guard   — an AbortController wired to the Emergency Stop
 *                              button and to hard timeouts, so every run can be
 *                              killed instantly and can never run away.
 *
 * This module never weakens a check based on anything the page passes in — the
 * allowlist and role are read from the live environment each time.
 * ───────────────────────────────────────────────────────────────────────── */
import { ALLOWED_ALL, ALLOWED_HOSTS, ALLOWED_STAGING, REQUIRED_ROLE, LOAD } from './config.js';

export class SafetyError extends Error {
  constructor(message, code) { super(message); this.name = 'SafetyError'; this.code = code || 'blocked'; }
}

// ─── 1. TARGET ALLOWLISTING ─────────────────────────────────────────────────
export function isAllowedHost(hostname = location.hostname) {
  return ALLOWED_ALL.includes(hostname);
}

export function targetKind(hostname = location.hostname) {
  if (ALLOWED_HOSTS.includes(hostname)) return 'local';
  if (ALLOWED_STAGING.includes(hostname)) return 'staging';
  return 'blocked';
}

// Throws unless the current origin is explicitly authorized. Called at the top
// of every test and every load run — not once at startup — so the suite cannot
// be carried onto a disallowed host by navigation or an injected <base>.
export function assertAllowedTarget() {
  if (!isAllowedHost()) {
    throw new SafetyError(
      `Target "${location.hostname}" is not authorized. The suite only runs against ` +
      `${ALLOWED_HOSTS.join(', ')} or ${ALLOWED_STAGING.join(', ')}.`,
      'target-not-allowed',
    );
  }
  // A test may only ever be aimed at the page's own origin. Reject any explicit
  // URL argument that resolves off-origin before it can become a request.
  return true;
}

// Validates an optional explicit target URL (used by the load simulator). Any
// off-origin, non-http(s), or disallowed-host URL is rejected here.
export function assertSameAllowedOrigin(url) {
  let parsed;
  try { parsed = new URL(url, location.href); }
  catch { throw new SafetyError(`"${url}" is not a valid URL.`, 'bad-url'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new SafetyError(`Protocol "${parsed.protocol}" is not allowed.`, 'bad-protocol');
  if (parsed.origin !== location.origin) throw new SafetyError(`"${parsed.origin}" is off-origin.`, 'off-origin');
  if (!isAllowedHost(parsed.hostname)) throw new SafetyError(`Host "${parsed.hostname}" is not authorized.`, 'target-not-allowed');
  return parsed;
}

// ─── 2. ROLE VERIFICATION ───────────────────────────────────────────────────
// Reads the role from UnliSession, which firebase.js fills from Firestore — the
// browser can't fake it (session.js). This is a UX gate; firestore.rules remains
// the real authority on every write the tests attempt.
export async function assertManager() {
  if (typeof window.UnliSession === 'undefined') {
    throw new SafetyError('Session is not initialized.', 'no-session');
  }
  if (!UnliSession.ready()) await UnliSession.whenReady();
  const role = UnliSession.role();
  if (role !== REQUIRED_ROLE) {
    throw new SafetyError(`A ${REQUIRED_ROLE} account is required. Current role: ${role || 'signed out'}.`, 'not-manager');
  }
  return { role, email: UnliSession.email() };
}

// One call that both the dashboard and each test use to confirm it is safe to
// proceed. Returns environment facts the UI shows in its safety banner.
export async function assertSafeToRun() {
  assertAllowedTarget();
  const who = await assertManager();
  return { host: location.hostname, kind: targetKind(), ...who };
}

// ─── 3. RUN LIFECYCLE GUARD (Circuit Breaker) ───────────────────────────────
// Wraps an AbortController with an automatic hard-timeout and a single stop()
// entry point. The Emergency Stop button and every run share one of these, so
// "stop" means every in-flight fetch/callable is aborted at once.
export function createRunGuard({ hardTimeoutMs = LOAD.RUN_HARD_TIMEOUT_MS, onStop } = {}) {
  const controller = new AbortController();
  let stopped = false;
  let reason = null;

  const timer = setTimeout(() => stop('hard-timeout'), hardTimeoutMs);

  function stop(why = 'manual') {
    if (stopped) return;
    stopped = true;
    reason = why;
    clearTimeout(timer);
    try { controller.abort(new SafetyError(`Run stopped (${why}).`, 'aborted')); } catch { /* already aborted */ }
    if (typeof onStop === 'function') { try { onStop(why); } catch { /* listener error is non-fatal */ } }
  }

  function throwIfStopped() {
    if (stopped) throw new SafetyError(`Run stopped (${reason}).`, 'aborted');
  }

  function finish() { clearTimeout(timer); }

  return {
    get signal() { return controller.signal; },
    get stopped() { return stopped; },
    get reason() { return reason; },
    stop,
    throwIfStopped,
    finish,
  };
}

// A timeout helper that races a promise against the guard's signal and a
// per-request deadline, so a single hung call can't stall a bounded run.
export function withDeadline(promise, ms, guard) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => (v) => { if (!settled) { settled = true; clearTimeout(t); cleanup(); fn(v); } };
    const t = setTimeout(() => done(reject)(new SafetyError(`Timed out after ${ms}ms.`, 'timeout')), ms);
    const onAbort = () => done(reject)(new SafetyError('Aborted.', 'aborted'));
    const cleanup = () => guard?.signal?.removeEventListener?.('abort', onAbort);
    guard?.signal?.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve(promise).then(done(resolve), done(reject));
  });
}
