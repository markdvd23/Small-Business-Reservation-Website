/* firestore.rules tests (docs/plan.md build order 6). Run against the emulator:
 *   cd scripts && npm install
 *   npx firebase emulators:exec --only firestore --project demo-unli "npm run test:rules"
 * (run from the project root, or pass --config ../firebase.json) */
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, getDocs, serverTimestamp, Timestamp,
} from 'firebase/firestore';

const here = dirname(fileURLToPath(import.meta.url));
let env;

const USERS = {
  ana:   { email: 'ana@example.com',   role: 'customer' },
  ben:   { email: 'ben@example.com',   role: 'customer' },
  sam:   { email: 'sam@example.com',   role: 'staff' },
  mia:   { email: 'mia@example.com',   role: 'manager' },
};
const as = uid => env.authenticatedContext(uid, { email: USERS[uid].email }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

const hold = (uid, over = {}) => ({
  no: 'H1', type: 'hold', status: 'held', where: 'Ana', time: 'Pickup 6:00 PM', items: ['Ramen × 1'],
  itemId: 'ramen', branch: 'Rodriguez', date: '2026-10-01', slot: '18:00',
  customer: { name: 'Ana', email: USERS[uid].email }, ownerUid: uid,
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over,
});

const dish = (over = {}) => ({
  name: 'Dish', tag: 'Tag', blurb: 'Tasty.', image: 'https://example.com/a.jpg', alt: 'A dish',
  sort: 10, limited: false, hidden: false, updatedAt: new Date(), ...over,
});
const newDish = (over = {}) => ({ ...dish(over), updatedAt: serverTimestamp() });

const branch = (over = {}) => ({
  name: 'Rodriguez', address: 'J.P. Rizal Street, Rodriguez, Rizal', phone: '0917 555 0100',
  open: '10:00', lastSeating: '20:30', close: '22:00', capacity: 40, active: true, sort: 10, updatedAt: new Date(), ...over,
});
const newBranch = (over = {}) => ({ ...branch(over), updatedAt: serverTimestamp() });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-unli',
    firestore: { rules: readFileSync(join(here, '..', 'firestore.rules'), 'utf8') },
  });
});
after(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    for (const [uid, u] of Object.entries(USERS)) await setDoc(doc(db, 'users', uid), { ...u, name: uid });
    await setDoc(doc(db, 'menuItems', 'ramen'), dish({ name: 'Ramen', limited: true, sort: 1 }));
    await setDoc(doc(db, 'menuItems', 'wings'), dish({ name: 'Wings', sort: 2 }));
    await setDoc(doc(db, 'menuItems', 'chaofan'), dish({ name: 'Chaofan', limited: true, hidden: true, sort: 3 }));
    await setDoc(doc(db, 'branches', 'Rodriguez'), branch());
    await setDoc(doc(db, 'branches', 'Antipolo'), branch({ name: 'Antipolo', address: 'Sumulong Hwy, Antipolo', active: false, sort: 20 }));
    // Ana's own hold; a reserve staff booked for Ana; Ben's order.
    await setDoc(doc(db, 'tickets', 'anaHold'), { ...hold('ana'), createdAt: new Date() });
    await setDoc(doc(db, 'tickets', 'anaRes'), {
      no: 'R1', type: 'reserve', status: 'reserved', items: ['Group feast · Ana'], party: 4, branch: 'Rodriguez',
      date: '2099-01-01', slot: '18:00', customer: { name: 'Ana', email: 'ana@example.com' }, ownerUid: 'sam', createdAt: new Date(),
    });
    await setDoc(doc(db, 'tickets', 'benOrder'), {
      no: 'O1', type: 'order', status: 'raw', items: ['Wings'], ownerUid: 'ben', createdAt: new Date(),
    });
  });
});

// ─── SIGNED OUT ────────────────────────────────────────────────────────────
test('signed out: can read the menu', () => assertSucceeds(getDocs(collection(anon(), 'menuItems'))));
test('signed out: can read branches', () => assertSucceeds(getDocs(collection(anon(), 'branches'))));
test('signed out: cannot read tickets', () => assertFails(getDoc(doc(anon(), 'tickets', 'anaHold'))));
test('signed out: cannot read users', () => assertFails(getDoc(doc(anon(), 'users', 'ana'))));

// ─── CUSTOMER ──────────────────────────────────────────────────────────────
test('customer: reads own profile, not another', async () => {
  await assertSucceeds(getDoc(doc(as('ana'), 'users', 'ana')));
  await assertFails(getDoc(doc(as('ana'), 'users', 'ben')));
});
test('customer: updates own name only', async () => {
  await assertSucceeds(updateDoc(doc(as('ana'), 'users', 'ana'), { name: 'Ana Cruz', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('ana'), 'users', 'ana'), { role: 'manager', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('ana'), 'users', 'ana'), { email: 'attacker@example.com', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('ana'), 'users', 'ana'), { name: 'No timestamp' }));
  await assertFails(updateDoc(doc(as('ana'), 'users', 'ana'), { name: '' }));
  await assertFails(updateDoc(doc(as('ben'), 'users', 'ana'), { name: 'Hacked' }));
});
test('customer: account page queries succeed', async () => {
  const db = as('ana');
  const own = await assertSucceeds(getDocs(query(collection(db, 'tickets'), where('ownerUid', '==', 'ana'))));
  const forMe = await assertSucceeds(getDocs(query(collection(db, 'tickets'), where('customer.email', '==', 'ana@example.com'))));
  if (own.size !== 1 || forMe.size !== 2) throw new Error(`expected 1 own + 2 by email, got ${own.size} + ${forMe.size}`);
});
test('customer: cannot read another user’s tickets', async () => {
  const db = as('ana');
  await assertFails(getDoc(doc(db, 'tickets', 'benOrder')));
  await assertFails(getDocs(query(collection(db, 'tickets'), where('ownerUid', '==', 'ben'))));
  await assertFails(getDocs(query(collection(db, 'tickets'), where('customer.email', '==', 'ben@example.com'))));
  await assertFails(getDocs(collection(db, 'tickets')));
});
test('customer: places a hold on a limited, visible dish', () =>
  assertSucceeds(setDoc(doc(as('ana'), 'tickets', 'new1'), hold('ana'))));
test('customer: hold refused for hidden, non-limited, or unknown dish', async () => {
  const db = as('ana');
  await assertFails(setDoc(doc(db, 'tickets', 'n2'), hold('ana', { itemId: 'chaofan' })));
  await assertFails(setDoc(doc(db, 'tickets', 'n3'), hold('ana', { itemId: 'wings' })));
  await assertFails(setDoc(doc(db, 'tickets', 'n4'), hold('ana', { itemId: 'nope' })));
});
test('customer: hold refused for someone else or with bad shape', async () => {
  const db = as('ana');
  await assertFails(setDoc(doc(db, 'tickets', 'n5'), hold('ana', { ownerUid: 'ben' })));
  await assertFails(setDoc(doc(db, 'tickets', 'n6'), hold('ana', { customer: { name: 'x', email: 'ben@example.com' } })));
  await assertFails(setDoc(doc(db, 'tickets', 'n7'), hold('ana', { slot: '25:99' })));
  await assertFails(setDoc(doc(db, 'tickets', 'n8'), hold('ana', { extra: true })));
});
const table = (uid, over = {}) => {
  const at = new Date(Date.now() + 3 * 86400000);
  return {
    no: 'T1', type: 'reserve', status: 'reserved', where: 'Fri · 6:00 PM', time: 'Booked Oct 1',
    party: 4, items: ['Table for 4 · Ana'], branch: 'Rodriguez', date: '2099-01-01', slot: '18:00',
    at: Timestamp.fromDate(at), customer: { name: 'Ana', email: USERS[uid].email, phone: '0917 555 0101' },
    ownerUid: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over,
  };
};
test('customer: cannot bypass the capacity-checked booking function', () =>
  assertFails(setDoc(doc(as('ana'), 'tickets', 't1'), table('ana'))));
test('customer: bad table bookings are refused', async () => {
  const db = as('ana');
  const past = Timestamp.fromDate(new Date(Date.now() - 3600000));
  const far = Timestamp.fromDate(new Date(Date.now() + 40 * 86400000));
  const bad = [
    { party: 0 }, { party: 21 }, { party: 2.5 }, { at: past }, { at: far }, { slot: '21:00' }, { slot: '09:30' },
    { branch: 'Makati' }, { branch: 'Antipolo' }, { branch: 42 }, { customer: { name: 'Ana', email: 'ben@example.com' } },
    { customer: { name: 'Ana', email: 'ana@example.com', vip: true } }, { customer: { name: '', email: 'ana@example.com' } },
    { ownerUid: 'ben' }, { status: 'seated' }, { at: '2099-01-01' },
  ];
  for (const [i, over] of bad.entries()) await assertFails(setDoc(doc(db, 'tickets', 'bad' + i), table('ana', over)));
});
test('customer: cannot cancel a table whose time has passed', async () => {
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'tickets', 'oldRes'), {
    ...table('ana'), at: Timestamp.fromDate(new Date(Date.now() - 3600000)), createdAt: new Date(), updatedAt: new Date(),
  }));
  await assertFails(updateDoc(doc(as('ana'), 'tickets', 'oldRes'), { status: 'cancelled', updatedAt: serverTimestamp() }));
});
test('staff: seats a party', () =>
  assertSucceeds(updateDoc(doc(as('sam'), 'tickets', 'anaRes'), { status: 'seated', updatedAt: serverTimestamp() })));
test('customer: cancels own reservation, nothing else', async () => {
  await assertFails(updateDoc(doc(as('ben'), 'tickets', 'anaRes'), { status: 'cancelled', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('ana'), 'tickets', 'anaRes'), { status: 'served', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('ana'), 'tickets', 'anaRes'), { status: 'cancelled', party: 40, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('ana'), 'tickets', 'anaHold'), { status: 'collected', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as('ana'), 'tickets', 'anaRes'), { status: 'cancelled', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('ana'), 'tickets', 'anaRes'), { status: 'reserved', updatedAt: serverTimestamp() }));
});
test('customer: cannot delete tickets or change the menu', async () => {
  await assertFails(deleteDoc(doc(as('ana'), 'tickets', 'anaHold')));
  await assertFails(updateDoc(doc(as('ana'), 'menuItems', 'ramen'), { hidden: true }));
  await assertFails(updateDoc(doc(as('ana'), 'menuItems', 'ramen'), { name: 'Free Ramen', updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(as('ana'), 'menuItems', 'mine'), newDish({ name: 'Mine' })));
  await assertFails(deleteDoc(doc(as('ana'), 'menuItems', 'ramen')));
  await assertFails(setDoc(doc(anon(), 'menuItems', 'anon'), newDish({ name: 'Anon' })));
});

// ─── STAFF ─────────────────────────────────────────────────────────────────
test('staff: reads every ticket', () => assertSucceeds(getDocs(collection(as('sam'), 'tickets'))));
test('staff: moves status, nothing else', async () => {
  await assertSucceeds(updateDoc(doc(as('sam'), 'tickets', 'benOrder'), { status: 'cooking', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(as('sam'), 'tickets', 'benOrder'), { items: ['Free food'] }));
  await assertFails(updateDoc(doc(as('sam'), 'tickets', 'benOrder'), { status: 'bogus' }));
});
test('staff: creates a reserve for a customer', () =>
  assertSucceeds(setDoc(doc(as('sam'), 'tickets', 'r2'), {
    no: 'R2', type: 'reserve', status: 'reserved', where: 'Jan 1 · 6:00 PM', time: 'Booked Oct 1', party: 10,
    items: ['Group feast · Ben'], branch: 'Rodriguez', date: '2099-01-01', slot: '18:00',
    customer: { name: 'Ben', email: 'ben@example.com' }, ownerUid: 'sam', createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  })));
test('holds and reserves only at a branch taking bookings', async () => {
  await assertFails(setDoc(doc(as('ana'), 'tickets', 'hb1'), hold('ana', { branch: 'Antipolo' })));
  await assertFails(setDoc(doc(as('ana'), 'tickets', 'hb2'), hold('ana', { branch: 'Nowhere' })));
  const { branch: _, ...noBranch } = hold('ana');
  await assertFails(setDoc(doc(as('ana'), 'tickets', 'hb3'), noBranch));
  await assertFails(setDoc(doc(as('sam'), 'tickets', 'hb4'), { ...table('ana'), ownerUid: 'sam', branch: 'Antipolo' }));
});
test('customer: table slot follows the branch’s own hours', async () => {
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), 'branches', 'Rodriguez'), { open: '12:00', lastSeating: '21:30' }));
  const db = as('ana');
  await assertFails(setDoc(doc(db, 'tickets', 'h1'), table('ana', { slot: '11:00' })));
  await assertSucceeds(setDoc(doc(db, 'tickets', 'h2'), table('ana', { slot: '21:00' })));
});
test('staff: cannot hide dishes or read audit logs', async () => {
  await assertFails(updateDoc(doc(as('sam'), 'menuItems', 'ramen'), { hidden: true }));
  await assertFails(getDocs(collection(as('sam'), 'auditLogs')));
});

// ─── MANAGER ───────────────────────────────────────────────────────────────
test('manager: hides and shows a dish', async () => {
  await assertSucceeds(updateDoc(doc(as('mia'), 'menuItems', 'ramen'), { hidden: true, updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(as('mia'), 'menuItems', 'ramen'), { hidden: false, updatedAt: serverTimestamp() }));
});
test('manager: adds, edits, hides, and removes dishes', async () => {
  const db = as('mia');
  await assertSucceeds(setDoc(doc(db, 'menuItems', 'halo-halo'), newDish({ name: 'Halo-halo', hidden: true })));
  await assertSucceeds(updateDoc(doc(db, 'menuItems', 'ramen'), { name: 'Tonkotsu Ramen', sort: 5, updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(db, 'menuItems', 'halo-halo')));
});
test('staff: adds and edits dishes, cannot hide or remove', async () => {
  const db = as('sam');
  await assertSucceeds(setDoc(doc(db, 'menuItems', 'gyoza'), newDish({ name: 'Gyoza' })));
  await assertSucceeds(updateDoc(doc(db, 'menuItems', 'wings'), { blurb: 'New blurb.', limited: true, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(db, 'menuItems', 'secret'), newDish({ name: 'Secret', hidden: true })));
  await assertFails(updateDoc(doc(db, 'menuItems', 'wings'), { hidden: true, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'menuItems', 'chaofan'), { hidden: false, updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(db, 'menuItems', 'wings')));
});
test('menu: bad dish shapes are refused', async () => {
  const db = as('mia');
  const upd = changes => updateDoc(doc(db, 'menuItems', 'wings'), { ...changes, updatedAt: serverTimestamp() });
  await assertFails(upd({ name: '' }));
  await assertFails(upd({ name: 'x'.repeat(41) }));
  await assertFails(upd({ image: 'javascript:alert(1)' }));
  await assertFails(upd({ image: 'http://insecure.example.com/a.jpg' }));
  await assertFails(upd({ sort: -1 }));
  await assertFails(upd({ sort: 1.5 }));
  await assertFails(upd({ limited: 'yes' }));
  await assertFails(upd({ price: 99 }));
  await assertFails(updateDoc(doc(db, 'menuItems', 'wings'), { name: 'No stamp' }));
  await assertFails(setDoc(doc(db, 'menuItems', 'Bad Id!'), newDish()));
  await assertSucceeds(upd({ image: '' }));
});
test('manager: adds, edits, and pauses branches; never deletes', async () => {
  const db = as('mia');
  await assertSucceeds(setDoc(doc(db, 'branches', 'San-Mateo'), newBranch({ name: 'San Mateo', address: 'Gen. Luna Ave, San Mateo' })));
  await assertSucceeds(updateDoc(doc(db, 'branches', 'Rodriguez'), { close: '23:00', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'branches', 'Rodriguez'), { active: false, updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(db, 'branches', 'Rodriguez')));
});
test('branches: staff, customers, and signed-out cannot change them', async () => {
  await assertFails(updateDoc(doc(as('sam'), 'branches', 'Rodriguez'), { active: false, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(as('sam'), 'branches', 'Taytay'), newBranch({ name: 'Taytay' })));
  await assertFails(updateDoc(doc(as('ana'), 'branches', 'Rodriguez'), { name: 'Mine', updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(anon(), 'branches', 'Taytay'), newBranch({ name: 'Taytay' })));
});
test('branches: bad shapes are refused', async () => {
  const db = as('mia');
  const upd = changes => updateDoc(doc(db, 'branches', 'Rodriguez'), { ...changes, updatedAt: serverTimestamp() });
  await assertFails(upd({ name: '' }));
  await assertFails(upd({ address: '' }));
  await assertFails(upd({ open: '9:00' }));
  await assertFails(upd({ open: '21:00' }));
  await assertFails(upd({ lastSeating: '22:30' }));
  await assertFails(upd({ active: 'yes' }));
  await assertFails(upd({ capacity: 0 }));
  await assertFails(upd({ capacity: 501 }));
  await assertFails(upd({ sort: 1.5 }));
  await assertFails(upd({ owner: 'mia' }));
  await assertFails(updateDoc(doc(db, 'branches', 'Rodriguez'), { name: 'No stamp' }));
  await assertFails(setDoc(doc(db, 'branches', 'Bad Id!'), newBranch()));
});
test('manager: reads audit logs; nobody edits them', async () => {
  const ref = await assertSucceeds(addDoc(collection(as('ana'), 'auditLogs'), {
    actor: 'ana@example.com', role: 'customer', action: 'Cancelled reserve', target: '#R1', createdAt: serverTimestamp(),
  }));
  await assertSucceeds(getDocs(collection(as('mia'), 'auditLogs')));
  await assertFails(updateDoc(doc(as('mia'), 'auditLogs', ref.id), { target: 'x' }));
  await assertFails(deleteDoc(doc(as('mia'), 'auditLogs', ref.id)));
});
test('audit log: cannot forge actor or role', async () => {
  await assertFails(addDoc(collection(as('ana'), 'auditLogs'), {
    actor: 'mia@example.com', role: 'customer', action: 'Placed hold', target: '#1', createdAt: serverTimestamp(),
  }));
  await assertFails(addDoc(collection(as('ana'), 'auditLogs'), {
    actor: 'ana@example.com', role: 'manager', action: 'Placed hold', target: '#1', createdAt: serverTimestamp(),
  }));
});
