#!/usr/bin/env node
/* Seed the first branches into Firestore (branches/{id}) from scripts/data/branches.json.
 *
 * Create-only: a branch that already exists is left alone, so a manager's
 * edits on the dashboard (hours, paused, address) are never overwritten.
 * After the first run, managers add and edit branches from the dashboard.
 *
 *   cd scripts && npm install
 *   node seed-branches.mjs              # live project (key: see lib/admin.mjs)
 *   node seed-branches.mjs --dry-run    # show what would change
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node seed-branches.mjs # local emulator
 *
 * The `id` is what tickets store in `branch` — keep "Rodriguez" for the
 * existing branch so old tickets still match it.
 */
import { readFileSync } from 'node:fs';
import { connect, flag, FieldValue } from './lib/admin.mjs';

const DRY = flag('--dry-run');
const FIELDS = ['name', 'address', 'phone', 'open', 'lastSeating', 'close', 'capacity', 'active', 'sort'];
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const branches = JSON.parse(readFileSync(new URL('./data/branches.json', import.meta.url), 'utf8'));

// ─── CHECK THE DATA FIRST (same limits as firestore.rules) ─────────────────
const problems = [];
branches.forEach((b, i) => {
  const at = `branches.json[${i}]${b.id ? ' (' + b.id + ')' : ''}`;
  if (!/^[A-Za-z0-9-]{1,40}$/.test(b.id || '')) problems.push(`${at}: id must be letters, digits, or dashes`);
  if (typeof b.name !== 'string' || !b.name.trim()) problems.push(`${at}: name is required`);
  if (typeof b.address !== 'string' || !b.address.trim()) problems.push(`${at}: address is required`);
  if (![b.open, b.lastSeating, b.close].every(t => HHMM.test(t || ''))) problems.push(`${at}: open, lastSeating, close must be HH:MM`);
  else if (!(b.open < b.lastSeating && b.lastSeating <= b.close)) problems.push(`${at}: need open < lastSeating <= close`);
  if (typeof b.active !== 'boolean') problems.push(`${at}: active must be true or false`);
  if (!Number.isInteger(b.capacity) || b.capacity < 1 || b.capacity > 500) problems.push(`${at}: capacity must be a whole number from 1 to 500`);
  if (!Number.isInteger(b.sort)) problems.push(`${at}: sort must be a whole number`);
});
if (problems.length) {
  console.error('branches.json has problems:\n  ' + problems.join('\n  '));
  process.exit(1);
}

// ─── CONNECT ───────────────────────────────────────────────────────────────
const { db, where } = connect();

// ─── WRITE ─────────────────────────────────────────────────────────────────
const col = db.collection('branches');
const existing = new Set((await col.get()).docs.map(d => d.id));
const batch = db.batch();
let created = 0;

for (const b of branches) {
  if (existing.has(b.id)) { console.log(`  ${b.id.padEnd(14)} already there, left alone`); continue; }
  batch.set(col.doc(b.id), { ...Object.fromEntries(FIELDS.map(f => [f, b[f] ?? ''])), updatedAt: FieldValue.serverTimestamp() });
  console.log(`+ ${b.id.padEnd(14)} ${b.name}`);
  created += 1;
}

if (DRY) console.log(`\nDry run: would create ${created}.`);
else {
  await batch.commit();
  console.log(`\nDone on ${where}: created ${created}.`);
}
