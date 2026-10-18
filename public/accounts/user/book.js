/* Book a table: When → Who → Confirm → done. One Firestore write, a
 * `reserve` ticket owned by the customer. firestore.rules re-checks the party
 * size, the time window, and that it's booked under the customer's own email. */
import { auth, db, doc, getDoc, createReservation, joinWaitlist, rescheduleReservation } from '../../js/firebase.js';
import { Timestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { loadBranches, isoDate, fmtDay, fmtSlot, watchMine, upcoming, downloadIcs } from './mine.js';

const BOOK_DAYS = 30;     // how far ahead customers can book
const LEAD_MIN = 30;      // earliest slot today is at least this far away
const MAX_PARTY = 20;

const $ = id => document.getElementById(id);

// The branch from ?branch=, else the first one taking bookings. A paused
// branch can't be booked (firestore.rules), so say so instead of a form.
const key = (new URLSearchParams(location.search).get('branch') || '').toLowerCase();
const rescheduleId = new URLSearchParams(location.search).get('reschedule');
const branches = await loadBranches();
const asked = key && branches.find(b => b.key === key);
const branch = asked ? (asked.active === true ? asked : null) : branches.find(b => b.active === true);
if (!branch) {
  $('branchLine').textContent = asked
    ? 'Unli Chix ' + asked.name + ' isn’t taking bookings right now. Pick another branch.'
    : 'No branch is taking bookings right now. Check back soon.';
  $('bookForm').hidden = true;
  document.querySelector('.book-steps').hidden = true;
  throw new Error('No bookable branch'); // stop this module; the page stays usable
}
const form = $('bookForm');
const dateIn = $('bkDate'), slotsBox = $('slots'), partyIn = $('bkParty'), nameIn = $('bkName'), phoneIn = $('bkPhone'), notesIn = $('bkNotes');
const error = $('bookError'), nextBtn = $('nextBtn'), backBtn = $('backBtn');
let step = 1;
let slot = null;
let mine = [];
// Moving an existing reservation changes only its date and time
// (rescheduleReservation), so the Who step is skipped.
let moving = false;
const stepAfter = n => (moving && n === 1 ? 3 : n + 1);
const stepBefore = n => (moving && n === 3 ? 1 : n - 1);
const confirmLabel = () => (moving ? 'Move reservation' : 'Confirm booking');

$('branchLine').textContent = ['Unli Chix ' + branch.name, branch.address].filter(Boolean).join(' · ');

// ─── STEP 1: DATE + TIME ───────────────────────────────────────────────────
const today = new Date();
const last = new Date(today);
last.setDate(last.getDate() + BOOK_DAYS);
dateIn.min = isoDate(today);
dateIn.max = isoDate(last);
$('bkDateHint').textContent = 'Up to ' + BOOK_DAYS + ' days ahead — latest ' + fmtDay(dateIn.max) + '.';

const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const toHHMM = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

function slotsFor(date) {
  const out = [];
  for (let m = toMin(branch.open); m <= toMin(branch.lastSeating); m += 30) out.push(toHHMM(m));
  if (date !== isoDate(new Date())) return out;
  const now = new Date();
  const earliest = now.getHours() * 60 + now.getMinutes() + LEAD_MIN;
  return out.filter(s => toMin(s) >= earliest);
}

function renderSlots() {
  const list = dateIn.value ? slotsFor(dateIn.value) : [];
  if (!list.includes(slot)) slot = null;
  slotsBox.replaceChildren(...list.map(s => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(s === slot));
    b.tabIndex = s === slot || (!slot && s === list[0]) ? 0 : -1;
    b.textContent = fmtSlot(s);
    b.dataset.slot = s;
    b.addEventListener('click', () => { slot = s; error.hidden = true; renderSlots(); slotsBox.querySelector('[aria-checked="true"]').focus(); });
    return b;
  }));
  if (dateIn.value && !list.length) {
    const p = document.createElement('p');
    p.className = 'form-hint';
    p.textContent = 'No more tables today. Pick another date.';
    slotsBox.append(p);
  }
}

// Arrow keys move between time slots, like a radio group.
slotsBox.addEventListener('keydown', e => {
  const btns = [...slotsBox.querySelectorAll('.slot')];
  const i = btns.indexOf(document.activeElement);
  if (i < 0) return;
  const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!move) return;
  e.preventDefault();
  btns[(i + move + btns.length) % btns.length].click();
});

dateIn.addEventListener('change', renderSlots);
dateIn.value = slotsFor(isoDate(today)).length ? isoDate(today) : isoDate(new Date(today.getTime() + 86400000));
renderSlots();

// ─── STEP 2: PARTY ─────────────────────────────────────────────────────────
function bump(by) {
  const n = Math.min(MAX_PARTY, Math.max(1, (parseInt(partyIn.value, 10) || 0) + by));
  partyIn.value = n;
}
$('partyDown').addEventListener('click', () => bump(-1));
$('partyUp').addEventListener('click', () => bump(1));

// ─── STEPS ─────────────────────────────────────────────────────────────────
function details() {
  return {
    date: dateIn.value, slot,
    party: Number(partyIn.value),
    name: nameIn.value.trim(),
    phone: phoneIn.value.trim(),
    notes: notesIn.value.trim(),
  };
}

function problem(n) {
  const d = details();
  if (n === 1) {
    if (!d.date || d.date < dateIn.min || d.date > dateIn.max) return 'Pick a date between today and ' + fmtDay(dateIn.max) + '.';
    if (!d.slot || !slotsFor(d.date).includes(d.slot)) return 'Pick a time.';
  }
  if (n === 2) {
    if (!Number.isInteger(d.party) || d.party < 1) return 'Party size must be at least 1.';
    if (d.party > MAX_PARTY) return 'For more than ' + MAX_PARTY + ' guests, call the branch and we’ll arrange catering.';
    if (!d.name) return 'Enter a name for the booking.';
    if (d.phone && !/^\+?[0-9 ()-]{7,20}$/.test(d.phone)) return 'Enter a valid mobile number, or leave it blank.';
  }
  return null;
}

function reviewRows(d) {
  return [
    ['Branch', 'Unli Chix ' + branch.name],
    ['When', fmtDay(d.date) + ', ' + fmtSlot(d.slot)],
    ['Party', d.party + (d.party === 1 ? ' guest' : ' guests')],
    ['Name', d.name],
    d.phone && ['Mobile', d.phone],
    d.notes && ['Notes', d.notes],
  ].filter(Boolean);
}

function fillDl(dl, rows) {
  dl.replaceChildren(...rows.flatMap(([k, v]) => [
    Object.assign(document.createElement('dt'), { textContent: k }),
    Object.assign(document.createElement('dd'), { textContent: v }),
  ]));
}

function go(n) {
  step = n;
  error.hidden = true;
  form.querySelectorAll('.book-step').forEach(f => { f.hidden = Number(f.dataset.step) !== n; });
  document.querySelectorAll('.book-steps li').forEach(li => {
    const s = Number(li.dataset.step);
    li.classList.toggle('is-done', s < n);
    if (s === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  backBtn.hidden = n === 1;
  nextBtn.textContent = n === 3 ? confirmLabel() : 'Next';
  if (n === 3) {
    const d = details();
    fillDl($('review'), reviewRows(d));
    const same = mine.find(t => upcoming(t) && t.date === d.date && t.id !== rescheduleId);
    $('dupeNote').hidden = !same;
    if (same) $('dupeNote').textContent = 'Heads up: you already have a table that day (#' + same.no + ', ' + fmtSlot(same.slot || '00:00') + '). Booking again adds a second one.';
  }
  form.querySelector('.book-step:not([hidden]) legend').focus?.();
}

backBtn.addEventListener('click', () => go(stepBefore(step)));

form.addEventListener('submit', async e => {
  e.preventDefault();
  const fail = msg => { error.textContent = msg; error.hidden = false; };
  const p = problem(step);
  if (p) return fail(p);
  if (step < 3) return go(stepAfter(step));

  // Re-check the time in case the page sat open past it.
  const p1 = problem(1);
  if (p1) { go(1); return fail('That time has passed. ' + p1); }

  const d = details();
  const at = new Date(d.date + 'T' + d.slot + ':00');
  const ticket = {
    type: 'reserve', status: 'reserved',
    where: fmtDay(d.date) + ' · ' + fmtSlot(d.slot),
    time: 'Booked ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    party: d.party,
    items: ['Table for ' + d.party + ' · ' + d.name].concat(d.notes ? [d.notes] : []),
    branch: branch.id, date: d.date, slot: d.slot, at: Timestamp.fromDate(at),
    customer: { name: d.name, email: auth.currentUser.email, ...(d.phone ? { phone: d.phone } : {}) },
  };

  nextBtn.disabled = true;
  nextBtn.textContent = moving ? 'Moving…' : 'Booking…';
  try {
    const saved = rescheduleId
      ? await rescheduleReservation({ ticketId: rescheduleId, date: d.date, slot: d.slot })
      : await createReservation({ branch: branch.id, date: d.date, slot: d.slot, party: d.party, name: d.name, phone: d.phone, notes: d.notes });
    ticket.id = saved.id;
    ticket.no = saved.no;
  } catch (err) {
    console.warn('Could not book:', err.code || err);
    nextBtn.disabled = false;
    nextBtn.textContent = confirmLabel();
    if (String(err.code || '').includes('resource-exhausted')) {
      if (confirm('That time is full. Join the waitlist for this time?')) {
        try {
          await joinWaitlist({ branch: branch.id, date: d.date, slot: d.slot, party: d.party, name: d.name, phone: d.phone });
          form.hidden = true;
          document.querySelector('.book-steps').hidden = true;
          const done = $('done');
          $('doneKicker').textContent = 'Waitlist';
          $('doneTitle').textContent = 'You’re on the waitlist';
          $('doneNo').textContent = '';
          $('doneHint').textContent = 'This isn’t a booking yet. If a table frees up at this time, the branch will be in touch.';
          fillDl($('doneReview'), reviewRows(d));
          $('icsBtn').hidden = true;
          $('viewBtn').hidden = true;
          done.hidden = false;
          done.focus();
          return;
        } catch (waitErr) {
          console.warn('Could not join waitlist:', waitErr.code || waitErr);
          const code = String(waitErr.code || '');
          if (code.includes('already-exists')) return fail('You’re already on the waitlist for this time.');
          if (code.includes('resource-exhausted')) return fail('You already have three waitlist requests open. Choose another time instead.');
          return fail('Couldn’t join the waitlist. Try again in a moment.');
        }
      }
      return fail('That time is full. Choose another time or try the waitlist again.');
    }
    if (String(err.code || '').includes('failed-precondition') && String(err.message || '').toLowerCase().includes('verify')) {
      return fail('Verify your email from My account before booking a table.');
    }
    return fail(err.code === 'permission-denied'
      ? 'We couldn’t book that table. Check the date and time, then try again.'
      : 'Couldn’t reach the server. Check your connection and try again.');
  }
  Unli.store.log(rescheduleId ? 'Rescheduled reserve' : 'Booked table', '#' + ticket.no).catch(err => console.warn('Could not write audit log:', err.code || err));

  // ─── DONE ──
  form.hidden = true;
  document.querySelector('.book-steps').hidden = true;
  const done = $('done');
  if (moving) { $('doneKicker').textContent = 'Reservation moved'; $('doneTitle').textContent = 'See you then!'; }
  $('doneNo').textContent = '#' + ticket.no;
  fillDl($('doneReview'), reviewRows(d));
  $('viewBtn').href = 'ticket.html?id=' + encodeURIComponent(ticket.id);
  $('icsBtn').addEventListener('click', () => downloadIcs({ ...ticket, at }));
  done.hidden = false;
  done.focus();
});

// ─── START ─────────────────────────────────────────────────────────────────
await UnliSession.whenReady();
const user = auth.currentUser;
if (user) {
  const snap = await getDoc(doc(db, 'users', user.uid)).catch(() => null);
  const name = snap && snap.exists() && snap.data().name;
  nameIn.value = name || '';
  if (rescheduleId) {
    const old = await getDoc(doc(db, 'tickets', rescheduleId)).catch(() => null);
    if (old && old.exists()) {
      const t = old.data();
      if (t.status === 'reserved' && t.branch === branch.id) {
        dateIn.value = t.date;
        slot = t.slot;
        partyIn.value = t.party || 2;
        nameIn.value = t.customer?.name || nameIn.value;
        phoneIn.value = t.customer?.phone || '';
        renderSlots();
        moving = true;
        document.querySelector('.book-steps li[data-step="2"]').hidden = true;
        document.querySelector('.book-steps li[data-step="3"] span').textContent = '2';
        document.querySelector('.book-head .eyebrow').textContent = 'Move reservation #' + t.no;
      }
    }
  }
  // Warn about double bookings on the review step.
  watchMine(list => { mine = list; }, () => {});
}
