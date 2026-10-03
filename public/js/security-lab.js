/* Security lab — Attack 1: brute force, run from inside the website.
 *
 * Hits the same Firebase Identity Toolkit endpoint that login.html uses
 * (accounts:signInWithPassword), from the browser. Limited by design:
 * hard cap 25 attempts, at least 500 ms apart, stops on success or on
 * Firebase lockout. Authorized testing on accounts you own only. */
'use strict';

// Reveal the nav immediately: this page never loads the Firebase SDK, so the
// auth-ready flag in session.js never fires on its own.
document.documentElement.classList.add('unli-auth-ready');

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (n, lo, hi, fallback) => (Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : fallback);
const LAB_PASS = 'unlilab123'; // throwaway lab-account password (also in the wordlist)

const els = {
  email: $('targetEmail'), words: $('wordlist'), max: $('maxAttempts'), delay: $('delayMs'),
  start: $('startBtn'), stop: $('stopBtn'), create: $('createLab'), del: $('deleteLab'),
  log: $('logBody'), hint: $('logHint'), verdict: $('verdict'), status: $('labStatus'),
};

let apiKey = null;     // public web API key, read once from js/firebase.js
let running = false;
let stopFlag = false;
let labToken = null;   // idToken of the lab account created in this page session

async function getKey() {
  if (apiKey) return apiKey;
  const res = await fetch('js/firebase.js');
  if (!res.ok) throw new Error('Could not read js/firebase.js');
  const m = /apiKey:\s*'([^']+)'/.exec(await res.text());
  if (!m) throw new Error('Could not read the Firebase web API key');
  apiKey = m[1];
  return apiKey;
}

async function call(name, body) {
  const key = await getKey();
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${name}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON response */ }
  return { status: res.status, data };
}

function addRow(n, candidate, code, ms, kind) {
  const tr = document.createElement('tr');
  for (const [i, text] of [String(n).padStart(2, '0'), candidate, code, ms ? `${ms} ms` : '—'].entries()) {
    const td = document.createElement('td');
    td.textContent = text;
    if (i === 2 && kind) td.className = kind;
    tr.append(td);
  }
  els.log.append(tr);
}

function say(text) { els.status.textContent = text; }

function verdict(kind, text) {
  els.verdict.className = `verdict ${kind}`;
  els.verdict.textContent = text;
}

function setRunning(on) {
  running = on;
  els.start.disabled = on;
  els.create.disabled = on;
  els.stop.disabled = !on;
}

async function run() {
  const email = els.email.value.trim();
  if (!email.includes('@')) { verdict('bad', 'Enter the target email — an account you own.'); return; }

  const words = els.words.value.split(/\r?\n/).map(w => w.trim()).filter(w => w && !w.startsWith('#'));
  if (!words.length) { verdict('bad', 'The wordlist is empty — one candidate password per line.'); return; }

  // Enforce the safety limits even if the inputs were edited by hand.
  const max = clamp(parseInt(els.max.value, 10), 1, 25, 10);
  const delay = clamp(parseInt(els.delay.value, 10), 500, 10000, 1500);
  els.max.value = max;
  els.delay.value = delay;

  setRunning(true);
  stopFlag = false;
  els.log.textContent = '';
  els.verdict.textContent = '';
  say(`Attacking ${email} — ${Math.min(max, words.length)} of ${words.length} candidates, ${delay} ms apart…`);

  let cracked = null;
  let lockout = false;
  let fatal = null;
  let used = 0;

  for (const candidate of words) {
    if (used >= max || stopFlag) break;
    const t0 = performance.now();
    try {
      const { status, data } = await call('signInWithPassword', { email, password: candidate, returnSecureToken: true });
      const ms = Math.round(performance.now() - t0);
      used++;
      if (status === 200 && data.idToken) {
        addRow(used, candidate, 'CRACKED — session issued', ms, 'cracked');
        cracked = candidate;
        break;
      }
      const code = (data.error && data.error.message) || `HTTP ${status}`;
      const locked = status === 429 || /TOO_MANY_ATTEMPTS|RESOURCE_EXHAUSTED/.test(code);
      addRow(used, candidate, locked ? 'LOCKED OUT — throttled by Firebase' : code, ms, locked ? 'locked' : 'fail');
      if (locked) { lockout = true; break; }
    } catch (e) {
      used++;
      fatal = (e && e.message) || String(e);
      addRow(used, candidate, `NETWORK: ${fatal}`, 0, 'locked');
      break;
    }
    if (used < max) await sleep(delay);
  }

  els.hint.hidden = true;
  setRunning(false);

  if (cracked) {
    verdict('vulnerable', `VULNERABLE — password recovered after ${used} attempt(s): “${cracked}”. Any page behind this login is only as strong as that password.`);
    say('Attack finished: password found.');
  } else if (lockout) {
    verdict('mitigated', `MITIGATED — Firebase throttled the attack after ${used} attempt(s). This is the site's “Too many attempts” protection working.`);
    say('Attack finished: lockout triggered.');
  } else if (fatal) {
    verdict('bad', `Stopped: ${fatal}`);
    say('');
  } else if (stopFlag) {
    verdict('plain', `Stopped by you after ${used} attempt(s).`);
    say('');
  } else {
    verdict('plain', `NOT CRACKED — ${used} attempt(s) inside the ${max}-attempt cap. Add candidates to the wordlist (cap: 25).`);
    say('Attack finished: no match in this wordlist.');
  }
}

async function createLab() {
  els.create.disabled = true;
  try {
    const email = `bf-lab-${Date.now()}@example.com`;
    const { status, data } = await call('signUp', { email, password: LAB_PASS, returnSecureToken: true });
    if (!data.idToken) throw new Error((data.error && data.error.message) || `HTTP ${status}`);
    labToken = data.idToken;
    els.email.value = email;
    els.del.disabled = false;
    verdict('plain', `Lab account ready: ${email} — password “${LAB_PASS}” is already in the wordlist. Press Start attack.`);
    say('Lab account created in this browser session only.');
  } catch (e) {
    say(`Could not create the lab account: ${(e && e.message) || e}`);
  } finally {
    els.create.disabled = running;
  }
}

async function deleteLab() {
  if (!labToken) return;
  els.del.disabled = true;
  try {
    const { data } = await call('delete', { idToken: labToken });
    if (data.error) throw new Error(data.error.message);
    labToken = null;
    verdict('plain', 'Lab account deleted — the project is left clean.');
    say('');
  } catch (e) {
    els.del.disabled = false;
    say(`Delete failed: ${(e && e.message) || e} — remove it in Firebase console → Authentication.`);
  }
}

els.start.addEventListener('click', () => { run().catch(e => verdict('bad', `Error: ${(e && e.message) || e}`)); });
els.stop.addEventListener('click', () => { stopFlag = true; });
els.create.addEventListener('click', () => { createLab(); });
els.del.addEventListener('click', () => { deleteLab(); });
