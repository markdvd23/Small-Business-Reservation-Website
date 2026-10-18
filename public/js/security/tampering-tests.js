/* ─── UNLI CHIX — SECURITY ASSESSMENT · MODULE A ───────────────────────────
 * Parameter Tampering & Business-Logic Integrity (plawidnwad.md §3 Module A,
 * §6 Stage 2).
 *
 * Each validator submits a modified or out-of-policy payload straight to the
 * Cloud Function or Firestore — bypassing the site's own forms — and PASSES
 * only when the server refuses it with the right error. A pass means the
 * backend defends itself; a fail means a client could get past it.
 *
 * Every probe here is non-destructive:
 *   • party / hours / IDOR / role tests send payloads the server rejects, so
 *     nothing is written.
 *   • the quota test must create real reservations to trip the 6th-booking
 *     limit, so it runs on the local emulator ONLY and cancels (reverts) every
 *     ticket it creates, tracked by a per-run testRunId.
 *
 * The tests map 1:1 to the real backend read earlier:
 *   functions/index.js  createReservation / rescheduleReservation
 *   firestore.rules     users/{uid} role lock, tickets ownership
 * ───────────────────────────────────────────────────────────────────────── */
import { functions, db, auth } from '../firebase.js';
import {
  httpsCallable,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import {
  doc, updateDoc, collection, query, where, limit, getDocs, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { EXPECTED_REJECTIONS as REJ, SEVERITY, newRunId, isEmulatorSession } from './config.js';
import { assertAllowedTarget, SafetyError } from './safety-guard.js';

// ─── small helpers ───────────────────────────────────────────────────────────
const errCode = (e) => (e && (e.code || e.name)) ? String(e.code || e.name).replace(/^functions\//, '') : 'unknown';
const errMsg = (e) => (e && e.message) ? String(e.message) : String(e);

function result(base) {
  return {
    module: 'A',
    passed: null,
    severity: SEVERITY.INFO,
    steps: [],
    evidence: {},
    finishedAt: null,
    ...base,
  };
}
const step = (label, status, detail) => ({ label, status, detail: detail ?? '' });

// Calls a callable and resolves to { ok, data?, code?, message? } — never throws,
// so a test can reason about the outcome instead of unwinding.
async function call(name, data) {
  try {
    const res = await httpsCallable(functions, name)(data);
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, code: errCode(e), message: errMsg(e) };
  }
}

const futureDate = (daysAhead) => {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
};

// ─── A1. Party Size Boundary Validator ─────────────────────────────────────
// createReservation must reject non-integer / zero / negative / oversized party
// values with invalid-argument before any booking logic runs.
export async function testPartySizeBoundaryValidator() {
  assertAllowedTarget();
  const r = result({ id: 'party-size', title: 'Party Size Boundary', endpoint: 'createReservation' });
  const payloads = [
    { party: 0, note: 'zero' },
    { party: -4, note: 'negative' },
    { party: 25, note: 'over max (20)' },
    { party: 9999, note: 'absurdly large' },
    { party: 'four', note: 'non-numeric string' },
    { party: 3.5, note: 'fractional' },
  ];
  let rejected = 0;
  for (const p of payloads) {
    const res = await call('createReservation', {
      branch: 'probe-branch', date: futureDate(3), slot: '12:00', name: 'SecSuite Probe', party: p.party,
    });
    const good = !res.ok && res.code === REJ.INVALID_ARGUMENT;
    if (good) rejected++;
    r.steps.push(step(
      `party = ${JSON.stringify(p.party)} (${p.note})`,
      good ? 'ok' : (res.ok ? 'fail' : 'warn'),
      res.ok ? 'ACCEPTED — boundary not enforced' : `rejected: ${res.code} — ${res.message}`,
    ));
  }
  r.evidence = { tested: payloads.length, rejected };
  r.passed = rejected === payloads.length;
  r.severity = r.passed ? SEVERITY.PASS : SEVERITY.HIGH;
  r.summary = r.passed
    ? `All ${payloads.length} invalid party values were rejected with invalid-argument.`
    : `${payloads.length - rejected} of ${payloads.length} invalid party values were NOT rejected.`;
  r.finishedAt = new Date().toISOString();
  return r;
}

// ─── A2. Role Escalation Validator ──────────────────────────────────────────
// A signed-in user must not be able to raise their own role via a direct
// Firestore write. firestore.rules users/{uid} update allows only name/updatedAt.
export async function testRoleEscalationValidator() {
  assertAllowedTarget();
  const r = result({ id: 'role-escalation', title: 'Role Escalation', endpoint: 'firestore:/users/{uid}' });
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid) {
    r.passed = null; r.severity = SEVERITY.SKIPPED;
    r.summary = 'No signed-in user to test against.';
    r.steps.push(step('precondition', 'warn', 'auth.currentUser is null'));
    r.finishedAt = new Date().toISOString();
    return r;
  }
  const ref = doc(db, 'users', uid);
  let denied = 0;
  for (const role of ['manager', 'staff']) {
    let good = false, detail = '';
    try {
      // A privilege-escalation attempt on the suite operator's own profile.
      await updateDoc(ref, { role, updatedAt: serverTimestamp() });
      detail = 'WRITE SUCCEEDED — rules did not block role change';
    } catch (e) {
      good = errCode(e) === REJ.PERMISSION_DENIED;
      detail = `rejected: ${errCode(e)} — ${errMsg(e)}`;
    }
    if (good) denied++;
    r.steps.push(step(`attempt set role → '${role}'`, good ? 'ok' : 'fail', detail));
  }
  r.evidence = { uid, attempts: 2, denied };
  r.passed = denied === 2;
  r.severity = r.passed ? SEVERITY.PASS : SEVERITY.HIGH;
  r.summary = r.passed
    ? 'Firestore denied every self-service role change (PERMISSION_DENIED).'
    : 'A customer-style role change was NOT denied — privilege escalation is possible.';
  r.finishedAt = new Date().toISOString();
  return r;
}

// ─── A3. Ticket Authorization / IDOR Validator ──────────────────────────────
// rescheduleReservation must reject a ticket the caller doesn't own, regardless
// of role. We look for a real ticket not owned by the operator; if none exists
// we fall back to a fabricated id (expects not-found). Either way the call is
// rejected before any write (ownership check precedes tx.update).
export async function testTicketAuthorizationValidator() {
  assertAllowedTarget();
  const r = result({ id: 'idor', title: 'Ticket Authorization (IDOR)', endpoint: 'rescheduleReservation' });
  const uid = auth.currentUser && auth.currentUser.uid;

  // Try to locate a ticket owned by someone else (managers may read the board).
  let foreignId = null, foreignOwner = null;
  try {
    const snap = await getDocs(query(collection(db, 'tickets'), limit(20)));
    for (const d of snap.docs) {
      if (d.get('ownerUid') && d.get('ownerUid') !== uid) { foreignId = d.id; foreignOwner = d.get('ownerUid'); break; }
    }
  } catch (e) {
    r.steps.push(step('scan board for a foreign ticket', 'info', `could not read tickets: ${errCode(e)}`));
  }

  const target = foreignId || `secsuite-nonexistent-${newRunId()}`;
  const expectWhenForeign = REJ.PERMISSION_DENIED;
  const res = await call('rescheduleReservation', { ticketId: target, date: futureDate(5), slot: '12:00' });

  let good, detail;
  if (foreignId) {
    good = !res.ok && res.code === expectWhenForeign;
    detail = res.ok
      ? 'RESCHEDULE SUCCEEDED on another user\'s ticket — cross-account write possible'
      : `rejected: ${res.code} — ${res.message}`;
    r.steps.push(step(`reschedule foreign ticket ${target} (owner ${String(foreignOwner).slice(0, 8)}…)`, good ? 'ok' : 'fail', detail));
  } else {
    // No foreign ticket available: a non-existent id must still be refused.
    good = !res.ok && (res.code === REJ.NOT_FOUND || res.code === REJ.PERMISSION_DENIED);
    detail = res.ok ? 'UNEXPECTEDLY SUCCEEDED on a non-existent ticket' : `rejected: ${res.code} — ${res.message}`;
    r.steps.push(step(`reschedule fabricated id ${target}`, good ? 'ok' : 'fail', detail));
    r.steps.push(step('note', 'info', 'No foreign ticket was on the board, so ownership enforcement was exercised with a fabricated id only.'));
  }

  r.evidence = { operatorUid: uid, targetTicket: target, foreign: !!foreignId, outcome: res.code || 'accepted' };
  r.passed = good;
  r.severity = good ? SEVERITY.PASS : SEVERITY.HIGH;
  r.summary = good
    ? 'The server refused to reschedule a ticket the caller does not own.'
    : 'A ticket the caller does not own was reschedulable — broken object-level authorization.';
  r.finishedAt = new Date().toISOString();
  return r;
}

// ─── A4. Operating Hours / Schedule Tampering Validator ─────────────────────
// A booking outside a branch's open..lastSeating window must be refused with
// failed-precondition. Needs a real active branch; the slot passes format
// validation and is rejected only at the branch-hours check (no doc written).
export async function testOperatingHoursValidator() {
  assertAllowedTarget();
  const r = result({ id: 'operating-hours', title: 'Operating Hours Tampering', endpoint: 'createReservation' });

  let branchId = null, branch = null;
  try {
    const snap = await getDocs(query(collection(db, 'branches'), where('active', '==', true), limit(1)));
    if (!snap.empty) { branchId = snap.docs[0].id; branch = snap.docs[0].data(); }
  } catch (e) {
    r.steps.push(step('find active branch', 'warn', `could not read branches: ${errCode(e)}`));
  }
  if (!branchId) {
    r.passed = null; r.severity = SEVERITY.SKIPPED;
    r.summary = 'No active branch available to test booking hours against.';
    r.finishedAt = new Date().toISOString();
    return r;
  }

  // '03:30' is before any reasonable opening; '23:59' is after last seating.
  const probes = [
    { slot: '03:30', note: 'before opening' },
    { slot: '23:59', note: 'after last seating' },
  ];
  let rejected = 0;
  for (const p of probes) {
    const res = await call('createReservation', {
      branch: branchId, date: futureDate(3), slot: p.slot, name: 'SecSuite Probe', party: 2,
    });
    const good = !res.ok && res.code === REJ.FAILED_PRECONDITION;
    if (good) rejected++;
    r.steps.push(step(
      `book ${branchId} at ${p.slot} (${p.note})`,
      good ? 'ok' : (res.ok ? 'fail' : 'warn'),
      res.ok ? 'ACCEPTED — booking taken outside branch hours' : `rejected: ${res.code} — ${res.message}`,
    ));
  }
  r.evidence = { branchId, open: branch.open, lastSeating: branch.lastSeating, probes: probes.length, rejected };
  r.passed = rejected === probes.length;
  r.severity = r.passed ? SEVERITY.PASS : SEVERITY.MEDIUM;
  r.summary = r.passed
    ? `Out-of-hours bookings at ${branchId} were refused (failed-precondition).`
    : `An out-of-hours booking at ${branchId} was accepted.`;
  r.finishedAt = new Date().toISOString();
  return r;
}

// ─── A5. Reservation Quota Enforcement Validator ────────────────────────────
// The 5-active-reservation ceiling must block a 6th booking with
// resource-exhausted. This one must CREATE reservations, so it is emulator-only
// and reverts every ticket it creates (customers may cancel their own reserve).
export async function testReservationQuotaValidator() {
  const r = result({ id: 'quota', title: 'Reservation Quota (max 5 active)', endpoint: 'createReservation' });
  const runId = newRunId();

  if (!isEmulatorSession()) {
    r.passed = null; r.severity = SEVERITY.SKIPPED;
    r.summary = 'Skipped: creates real bookings, so it runs on the local emulator only (open the page with ?emulator).';
    r.steps.push(step('precondition', 'info', 'isEmulatorSession() is false'));
    r.finishedAt = new Date().toISOString();
    return r;
  }
  assertAllowedTarget();

  // Need an active branch to book into.
  let branchId = null, branch = null;
  try {
    const snap = await getDocs(query(collection(db, 'branches'), where('active', '==', true), limit(1)));
    if (!snap.empty) { branchId = snap.docs[0].id; branch = snap.docs[0].data(); }
  } catch (e) { /* handled below */ }
  if (!branchId) {
    r.passed = null; r.severity = SEVERITY.SKIPPED;
    r.summary = 'No active branch available to exercise the quota against.';
    r.finishedAt = new Date().toISOString();
    return r;
  }

  const created = []; // ticket ids to revert
  try {
    // Fill the quota: 5 bookings on distinct future dates at opening time.
    let filled = 0;
    for (let i = 0; i < 5; i++) {
      const res = await call('createReservation', {
        branch: branchId, date: futureDate(2 + i), slot: branch.open, name: `SecSuite ${runId}`, party: 1, notes: `${runId} quota probe`,
      });
      if (res.ok && res.data && res.data.id) { created.push(res.data.id); filled++; }
      else {
        // email-not-verified in an emulator session is the usual blocker — report cleanly.
        r.steps.push(step(`fill #${i + 1}`, 'warn', `could not create: ${res.code} — ${res.message}`));
        if (res.code === REJ.FAILED_PRECONDITION && /verify/i.test(res.message)) {
          r.passed = null; r.severity = SEVERITY.SKIPPED;
          r.summary = 'Skipped: this account\'s email is not verified in the emulator, so bookings can\'t be created to fill the quota.';
          await revert(created, r);
          r.finishedAt = new Date().toISOString();
          return r;
        }
        break;
      }
    }
    r.steps.push(step('fill quota', filled === 5 ? 'ok' : 'warn', `${filled}/5 active reservations created`));

    if (filled === 5) {
      const sixth = await call('createReservation', {
        branch: branchId, date: futureDate(8), slot: branch.open, name: `SecSuite ${runId}`, party: 1, notes: `${runId} overflow probe`,
      });
      const good = !sixth.ok && sixth.code === REJ.RESOURCE_EXHAUSTED;
      if (sixth.ok && sixth.data && sixth.data.id) created.push(sixth.data.id); // track so we can revert it too
      r.steps.push(step('attempt 6th reservation', good ? 'ok' : 'fail',
        sixth.ok ? 'ACCEPTED — quota not enforced' : `rejected: ${sixth.code} — ${sixth.message}`));
      r.passed = good;
      r.severity = good ? SEVERITY.PASS : SEVERITY.MEDIUM;
      r.summary = good
        ? 'The 6th active reservation was refused with resource-exhausted.'
        : 'A 6th active reservation was accepted — the quota is not enforced.';
    } else {
      r.passed = null; r.severity = SEVERITY.SKIPPED;
      r.summary = 'Could not fill 5 reservations, so the quota ceiling was not reached.';
    }
  } catch (e) {
    r.passed = null; r.severity = SEVERITY.SKIPPED;
    r.summary = `Quota test could not complete: ${errMsg(e)}`;
    r.steps.push(step('error', 'warn', errMsg(e)));
  } finally {
    await revert(created, r);
  }
  r.evidence = { branchId, runId, created: created.length };
  r.finishedAt = new Date().toISOString();
  return r;
}

// Reverts quota-test bookings by cancelling them (delete is forbidden by rules).
async function revert(ids, r) {
  if (!ids.length) return;
  let reverted = 0;
  for (const id of ids) {
    try {
      await updateDoc(doc(db, 'tickets', id), { status: 'cancelled', updatedAt: serverTimestamp() });
      reverted++;
    } catch { /* best-effort cleanup */ }
  }
  r.steps.push(step('cleanup', reverted === ids.length ? 'ok' : 'warn', `${reverted}/${ids.length} test reservations cancelled (reverted)`));
}

// Ordered registry the dashboard iterates to run "all".
export const TAMPERING_TESTS = [
  { id: 'party-size', title: 'Party Size Boundary', run: testPartySizeBoundaryValidator },
  { id: 'role-escalation', title: 'Role Escalation', run: testRoleEscalationValidator },
  { id: 'idor', title: 'Ticket Authorization (IDOR)', run: testTicketAuthorizationValidator },
  { id: 'operating-hours', title: 'Operating Hours Tampering', run: testOperatingHoursValidator },
  { id: 'quota', title: 'Reservation Quota', run: testReservationQuotaValidator },
];
