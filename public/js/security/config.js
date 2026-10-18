/* ─── UNLI CHIX — SECURITY ASSESSMENT · CONFIG ─────────────────────────────
 * Central, read-only configuration for the authorized resilience & integrity
 * assessment suite (plawidnwad.md §1, §6 Stage 1).
 *
 * Everything that bounds a run — where it may point, how hard it may push,
 * which error codes count as "server protected me" — lives here so the limits
 * are in one auditable place and never scattered through the test code.
 * ───────────────────────────────────────────────────────────────────────── */

// Hosts the suite is hard-locked to. Any other origin is refused before a
// single request leaves the browser (safety-guard.js). Loopback is for the
// Firebase emulator; the staging host is the one explicitly authorized target.
export const ALLOWED_HOSTS = Object.freeze(['localhost', '127.0.0.1']);
export const ALLOWED_STAGING = Object.freeze(['demo-unli.web.app']);
export const ALLOWED_ALL = Object.freeze([...ALLOWED_HOSTS, ...ALLOWED_STAGING]);

// Only a manager may open the dashboard (plawidnwad.md §3 Role Verification).
export const REQUIRED_ROLE = 'manager';

// Controlled load ceilings (plawidnwad.md §1.2, Module B). These are maximums:
// the UI sliders may ask for less, never more, and the generator clamps to them.
export const LOAD = Object.freeze({
  MIN_CONCURRENCY: 1,
  MAX_CONCURRENCY: 50,     // hard ceiling on simultaneous in-flight requests
  MIN_REQUESTS: 10,
  MAX_REQUESTS: 500,       // hard ceiling on total requests per run
  MIN_RAMP_MS: 1000,
  MAX_RAMP_MS: 10000,
  DEFAULT_CONCURRENCY: 10,
  DEFAULT_REQUESTS: 100,
  DEFAULT_RAMP_MS: 3000,
  PER_REQUEST_TIMEOUT_MS: 8000,
  RUN_HARD_TIMEOUT_MS: 120000, // a run is force-stopped after this no matter what
});

// Read-only / non-mutating targets the load simulator is allowed to exercise.
// 'createReservation' runs in DRY-RUN only: it is called with a deliberately
// invalid payload so the server rejects it at argument validation and never
// writes a document (see resilience-tests.js).
export const LOAD_TARGETS = Object.freeze([
  { id: 'branches', label: 'Branches (Firestore read)', kind: 'read' },
  { id: 'menu', label: 'Menu items (Firestore read)', kind: 'read' },
  { id: 'createReservation', label: 'createReservation (dry-run, rejected payload)', kind: 'callable-dryrun' },
]);

// Firebase error codes that mean the backend correctly refused us. A tampering
// test PASSES when it sees the expected code here — rejection is the good result.
export const EXPECTED_REJECTIONS = Object.freeze({
  INVALID_ARGUMENT: 'invalid-argument',
  PERMISSION_DENIED: 'permission-denied',
  FAILED_PRECONDITION: 'failed-precondition',
  RESOURCE_EXHAUSTED: 'resource-exhausted',
  NOT_FOUND: 'not-found',
  UNAUTHENTICATED: 'unauthenticated',
  // Firestore client surfaces rule denials under this code.
  FIRESTORE_PERMISSION_DENIED: 'permission-denied',
});

export const SEVERITY = Object.freeze({
  PASS: 'pass',       // control verified working
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  INFO: 'info',
  SKIPPED: 'skipped',
});

// Prefix for any document the suite is forced to create (quota test). Every such
// doc is tracked by testRunId and reverted on completion (plawidnwad.md §3).
export const TEST_MARKER = 'secsuite';

export function newRunId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${TEST_MARKER}-${Date.now().toString(36)}-${rand}`;
}

// True only when this tab is actually wired to the local emulator. Write-bearing
// tests (e.g. quota) refuse to run anywhere else, so real data is never touched.
export function isEmulatorSession() {
  try {
    return ALLOWED_HOSTS.includes(location.hostname)
      && sessionStorage.getItem('unli-emulator') === '1';
  } catch { return false; }
}
