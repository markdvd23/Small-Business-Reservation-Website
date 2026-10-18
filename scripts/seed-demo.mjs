#!/usr/bin/env node
/* Demo data so every collection has something to show: extra branches,
 * tickets across the board, and audit log entries. menuItems and users are
 * seeded elsewhere (seed-menu.mjs, real sign-ups).
 *
 * Every doc has a fixed id, so re-running overwrites the same docs instead of
 * piling up copies. Tickets and audit logs use ids starting with "demo-".
 * Tickets belong to the test accounts below, never real customers.
 *
 *   node seed-demo.mjs              # write (key: see lib/admin.mjs)
 *   node seed-demo.mjs --dry-run    # show only
 *   node seed-demo.mjs --remove     # delete it all again
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node seed-demo.mjs         # local emulator
 */
import { connect, flag, FieldValue, Timestamp } from './lib/admin.mjs';

const DRY = flag('--dry-run');
const REMOVE = flag('--remove');

const { db, where } = connect();

// ─── WHO ───────────────────────────────────────────────────────────────────
// Test accounts, looked up by email so their uids come from users/.
const EMAILS = {
  customer: 'customer@unlichix.example.com',
  tester: 'unlichix-test-1@example.com',
  staff: 'staff@unlichix.example.com',
  manager: 'manager@unlichix.example.com',
};
const people = {};
for (const [key, email] of Object.entries(EMAILS)) {
  const snap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (snap.empty) { console.error(`No users/ doc for ${email}. Sign in with that account once, then re-run.`); process.exit(1); }
  const d = snap.docs[0];
  people[key] = { uid: d.id, email, role: d.data().role, name: d.data().name || email.split('@')[0] };
}

// ─── WHEN ──────────────────────────────────────────────────────────────────
const now = new Date();
const minsAgo = m => Timestamp.fromDate(new Date(now.getTime() - m * 60000));
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const inDays = n => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };
const short = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const day = d => d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const clock = hhmm => { const [h, m] = hhmm.split(':').map(Number); return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM'); };
const at = (d, hhmm) => Timestamp.fromDate(new Date(iso(d) + 'T' + hhmm + ':00'));

// ─── BRANCHES ──────────────────────────────────────────────────────────────
const hours = { open: '10:00', lastSeating: '20:30', close: '22:00', capacity: 40 };
const BRANCHES = {
  'San-Mateo': { name: 'San Mateo', address: 'Gen. Luna Avenue, San Mateo, Rizal', phone: '0917 555 0102', ...hours, active: true, sort: 20 },
  'Marikina':  { name: 'Marikina', address: 'J.P. Rizal Street, Marikina City', phone: '0917 555 0103', ...hours, active: true, sort: 30 },
  'Antipolo':  { name: 'Antipolo', address: 'Sumulong Highway, Antipolo, Rizal', phone: '0917 555 0104', open: '11:00', lastSeating: '21:00', close: '22:30', capacity: 40, active: true, sort: 40 },
  'Cainta':    { name: 'Cainta', address: 'Ortigas Avenue Extension, Cainta, Rizal', phone: '0917 555 0105', ...hours, active: false, sort: 50 },
};

// ─── TICKETS ───────────────────────────────────────────────────────────────
const c = people.customer, t = people.tester, s = people.staff;
const cust = p => ({ name: p.name, email: p.email });
const d2 = inDays(2), d5 = inDays(5), d9 = inDays(9), dm1 = inDays(-1);
const TICKETS = {
  'demo-order-1': { no: 'DMO001', type: 'order', status: 'raw', where: 'Table 3', time: 'Ordered ' + clock('18:05'),
    items: ['Wings × 2', 'Milk tea × 3'], branch: 'Rodriguez', ownerUid: s.uid, createdAt: minsAgo(4) },
  'demo-order-2': { no: 'DMO002', type: 'order', status: 'cooking', where: 'Table 7', party: 5, time: 'Ordered ' + clock('17:52'),
    items: ['Ramen × 2', 'Chaofan × 1', 'Fries × 2'], branch: 'Rodriguez', ownerUid: s.uid, createdAt: minsAgo(15) },
  'demo-order-3': { no: 'DMO003', type: 'order', status: 'plated', where: 'Table 1', time: 'Ordered ' + clock('17:40'),
    items: ['Chicken Inasal × 2', 'Lemonade × 2'], branch: 'San-Mateo', ownerUid: s.uid, createdAt: minsAgo(28) },
  'demo-order-4': { no: 'DMO004', type: 'order', status: 'served', where: 'Table 5', time: 'Ordered ' + clock('17:10'),
    items: ['Sisig × 1', 'Silog × 2'], branch: 'Rodriguez', ownerUid: c.uid, customer: cust(c), createdAt: minsAgo(60) },
  'demo-hold-1': { no: 'DMH001', type: 'hold', status: 'held', where: t.name.split(' ')[0], time: 'Pickup ' + clock('19:30'),
    items: ['Ramen × 2'], itemId: 'ramen', branch: 'Rodriguez', date: iso(now), slot: '19:30',
    ownerUid: t.uid, customer: cust(t), createdAt: minsAgo(40) },
  'demo-hold-2': { no: 'DMH002', type: 'hold', status: 'collected', where: c.name.split(' ')[0], time: 'Pickup ' + clock('13:00'),
    items: ['Chaofan × 3'], itemId: 'chaofan', branch: 'Marikina', date: iso(now), slot: '13:00',
    ownerUid: c.uid, customer: cust(c), createdAt: minsAgo(300) },
  'demo-res-1': { no: 'DMR001', type: 'reserve', status: 'reserved', where: day(d2) + ' · ' + clock('18:00'), time: 'Booked ' + short(now),
    party: 6, items: ['Table for 6 · ' + t.name, 'Birthday — cake at 7'], branch: 'Rodriguez', date: iso(d2), slot: '18:00', at: at(d2, '18:00'),
    ownerUid: t.uid, customer: { ...cust(t), phone: '0917 555 0111' }, createdAt: minsAgo(90) },
  'demo-res-2': { no: 'DMR002', type: 'reserve', status: 'reserved', where: day(d5) + ' · ' + clock('19:00'), time: 'Booked ' + short(now),
    party: 4, items: ['Table for 4 · ' + c.name], branch: 'San-Mateo', date: iso(d5), slot: '19:00', at: at(d5, '19:00'),
    ownerUid: c.uid, customer: cust(c), createdAt: minsAgo(120) },
  'demo-res-3': { no: 'DMR003', type: 'reserve', status: 'reserved', where: short(d9) + ' · ' + clock('12:00'), time: 'Booked ' + short(now),
    party: 30, items: ['Group feast · ' + c.name, 'Company lunch, 30 pax'], branch: 'Antipolo', date: iso(d9), slot: '12:00', at: at(d9, '12:00'),
    ownerUid: s.uid, customer: cust(c), createdAt: minsAgo(200) },
  'demo-res-4': { no: 'DMR004', type: 'reserve', status: 'seated', where: day(dm1) + ' · ' + clock('18:30'), time: 'Booked ' + short(inDays(-3)),
    party: 8, items: ['Table for 8 · ' + t.name], branch: 'Rodriguez', date: iso(dm1), slot: '18:30', at: at(dm1, '18:30'),
    ownerUid: t.uid, customer: cust(t), createdAt: minsAgo(3 * 1440) },
};
for (const tk of Object.values(TICKETS)) tk.updatedAt = FieldValue.serverTimestamp();

// ─── AUDIT LOGS ────────────────────────────────────────────────────────────
const log = (p, action, target, m) => ({ actor: p.email, role: p.role, action, target, createdAt: minsAgo(m) });
const m = people.manager;
const LOGS = {
  'demo-log-1': log(m, 'Added branch', 'San Mateo', 400),
  'demo-log-2': log(m, 'Edited branch', 'Cainta · paused bookings', 380),
  'demo-log-3': log(s, 'Created reserve', '#DMR003', 200),
  'demo-log-4': log(t, 'Booked table', '#DMR001', 90),
  'demo-log-5': log(t, 'Placed hold', '#DMH001', 40),
  'demo-log-6': log(m, 'Hid from menu', 'Sisig', 30),
  'demo-log-7': log(m, 'Returned to menu', 'Sisig', 20),
  'demo-log-8': log(m, 'Viewed account', c.email, 10),
};

// ─── WRITE / REMOVE ────────────────────────────────────────────────────────
const plan = [['branches', BRANCHES], ['tickets', TICKETS], ['auditLogs', LOGS]];
const batch = db.batch();
for (const [col, docs] of plan) {
  for (const [id, data] of Object.entries(docs)) {
    const ref = db.collection(col).doc(id);
    if (REMOVE) batch.delete(ref);
    else batch.set(ref, col === 'branches' ? { ...data, updatedAt: FieldValue.serverTimestamp() } : data);
  }
  console.log(`${REMOVE ? '-' : '+'} ${col.padEnd(10)} ${Object.keys(docs).join(', ')}`);
}
if (DRY) console.log('\nDry run: nothing written.');
else {
  await batch.commit();
  console.log(`\nDone on ${where}.`);
}
