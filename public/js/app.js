/* ─── UNLI CHIX — SHARED BOOKING + DATA SCRIPT ──────────────────────────────
 * Firestore-backed store (tickets, hidden menu items, audit log), the booking
 * modal (holds + reserves), and the toast. Load as a module after session.js:
 *   <script type="module" src="js/app.js"></script>
 *
 * Checks in this file are for a helpful UI only. firestore.rules is what
 * enforces them: who may create which ticket, who may change status or hide
 * dishes, and that audit entries can't be forged or edited (docs/plan.md §4.5–4.7, §5).
 * ───────────────────────────────────────────────────────────────────────── */
import { auth, db, doc, serverTimestamp } from './firebase.js';
import { addDoc, collection, deleteDoc, onSnapshot, updateDoc, setDoc, Timestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

(function () {
  'use strict';

  const RESERVE_WEEKS = 15;

  // ─── MENU ────────────────────────────────────────────────────────────────
  // Lives in Firestore (menuItems/{id}); seed it with scripts/seed-menu.mjs.
  // Fields: name, tag, blurb, image, alt, sort, limited, hidden.

  // ─── BRANCHES ────────────────────────────────────────────────────────────
  // Live in Firestore (branches/{id}); managers configure them on the
  // dashboard. First seed: scripts/seed-branches.mjs. The id is what tickets
  // store in `branch`. Fields: name, address, phone, open, lastSeating, close,
  // active (taking bookings), sort.

  // ─── SESSION (read from session.js) ──────────────────────────────────────
  function session() {
    const role = UnliSession.role();
    if (!role) return null;
    const email = UnliSession.email() || '';
    const local = email.split('@')[0];
    return { role, email, name: local.charAt(0).toUpperCase() + local.slice(1) };
  }
  function isStaff(s) { return !!s && (s.role === 'staff' || s.role === 'manager'); }
  function isManager(s) { return !!s && s.role === 'manager'; }

  // ─── FIRESTORE STORE ─────────────────────────────────────────────────────
  // Live caches, kept current by onSnapshot. Pages listen for 'unli-data-changed'.
  let ticketCache = [];
  let waitlistCache = [];
  let menuCache = [];
  let menuLoaded = false;
  let branchCache = [];
  let branchesLoaded = false;
  const notify = () => window.dispatchEvent(new Event('unli-data-changed'));

  const STATUSES = { order: ['raw', 'cooking', 'plated', 'served'], hold: ['held', 'collected'], reserve: ['reserved', 'seated', 'cancelled'] };
  const valid = t => STATUSES[t.type] && STATUSES[t.type].includes(t.status) && Array.isArray(t.items);
  const millis = t => (t.createdAt && t.createdAt.toMillis ? t.createdAt.toMillis() : Date.now());

  // The menu is public: signed-out visitors need it too.
  onSnapshot(collection(db, 'menuItems'), snap => {
    menuCache = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(m => typeof m.name === 'string' && m.name)
      .sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999) || a.name.localeCompare(b.name));
    menuLoaded = true;
    notify();
  }, err => {
    console.warn('Could not load the menu:', err.code || err);
    menuLoaded = true;
    notify();
  });

  // Branches are public too: the booking forms list them.
  onSnapshot(collection(db, 'branches'), snap => {
    branchCache = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(b => typeof b.name === 'string' && b.name && [b.open, b.lastSeating, b.close].every(t => typeof t === 'string'))
      .sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999) || a.name.localeCompare(b.name));
    branchesLoaded = true;
    notify();
  }, err => {
    console.warn('Could not load branches:', err.code || err);
    branchesLoaded = true;
    notify();
  });

  // Only staff may read every ticket; a customer query for all of them would be refused.
  let ticketsStarted = false;
  window.addEventListener('unli-auth-ready', () => {
    if (ticketsStarted || !UnliSession.isStaff()) return;
    ticketsStarted = true;
    onSnapshot(collection(db, 'tickets'), snap => {
      ticketCache = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(valid).sort((a, b) => millis(b) - millis(a));
      notify();
    }, err => console.warn('Could not load tickets:', err.code || err));
    onSnapshot(collection(db, 'waitlist'), snap => {
      waitlistCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      notify();
    }, err => console.warn('Could not load waitlist:', err.code || err));
  });

  const store = {
    tickets() { return ticketCache; },
    waitlist() { return waitlistCache; },
    // One write, number included: a second "set the number" write would need
    // update rights customers don't have.
    async addTicket(t) {
      const ref = doc(collection(db, 'tickets'));
      t.no = ref.id.slice(0, 6).toUpperCase();
      await setDoc(ref, { ...t, ownerUid: auth.currentUser.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      t.id = ref.id;
      return t;
    },
    setStatus(ticket, status) { return updateDoc(doc(db, 'tickets', ticket.id), { status, updatedAt: serverTimestamp() }); },
    menu() { return menuCache; },
    menuLoaded() { return menuLoaded; },
    hidden() { return menuCache.filter(m => m.hidden === true).map(m => m.id); },
    setHidden(id, hide) {
      // Show the change now; the listener corrects it if the write is refused.
      menuCache = menuCache.map(m => (m.id === id ? { ...m, hidden: hide } : m));
      notify();
      return updateDoc(doc(db, 'menuItems', id), { hidden: hide, updatedAt: serverTimestamp() });
    },
    // Staff and managers edit dish details; only managers hide or remove
    // dishes (firestore.rules).
    addDish(id, dish) { return setDoc(doc(db, 'menuItems', id), { ...dish, updatedAt: serverTimestamp() }); },
    editDish(id, changes) { return updateDoc(doc(db, 'menuItems', id), { ...changes, updatedAt: serverTimestamp() }); },
    removeDish(id) { return deleteDoc(doc(db, 'menuItems', id)); },
    branches() { return branchCache; },
    branchesLoaded() { return branchesLoaded; },
    branch(id) { return branchCache.find(b => b.id === id) || null; },
    // Managers only (firestore.rules). Branches are paused, never deleted:
    // tickets keep pointing at them.
    addBranch(id, branch) { return setDoc(doc(db, 'branches', id), { ...branch, updatedAt: serverTimestamp() }); },
    editBranch(id, changes) {
      branchCache = branchCache.map(b => (b.id === id ? { ...b, ...changes } : b));
      notify();
      return updateDoc(doc(db, 'branches', id), { ...changes, updatedAt: serverTimestamp() });
    },
    log(action, target) {
      const who = session();
      return addDoc(collection(db, 'auditLogs'), {
        actor: who.email, role: who.role, action, target: String(target), createdAt: serverTimestamp(),
      });
    },
  };

  // ─── HELPERS ─────────────────────────────────────────────────────────────
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function hhmm(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function fmtTime(value) {
    const [h, m] = value.split(':').map(Number);
    return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM');
  }

  // ─── TOAST ───────────────────────────────────────────────────────────────
  let toastTimer;
  function toast(message) {
    let t = document.getElementById('toast');
    if (!t) {
      t = el('div', 'toast');
      t.id = 'toast';
      t.setAttribute('role', 'status');
      document.body.append(t);
    }
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  // ─── BOOKING MODAL (holds + reserves — docs/plan.md §7.3C) ────────────────────
  function field(labelText, input, hint) {
    const wrap = el('div', 'form-field');
    const label = el('label', 'field-label', labelText);
    label.htmlFor = input.id;
    wrap.append(label, input);
    if (hint) {
      const h = el('p', 'form-hint', hint);
      h.id = input.id + 'Hint';
      input.setAttribute('aria-describedby', h.id);
      wrap.append(h);
    }
    return wrap;
  }

  function input(id, type, attrs) {
    const i = el(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', 'form-input');
    i.id = id;
    i.name = id;
    if (type !== 'textarea' && type !== 'select') i.type = type;
    Object.entries(attrs || {}).forEach(([k, v]) => i.setAttribute(k, v));
    return i;
  }

  // Shared dialog shell: focus trap, Escape, backdrop click, entrance motion.
  // Callers fill `body` with fields, then call mount().
  function modal({ kicker, title, submitLabel }) {
    const returnFocus = document.activeElement;
    const backdrop = el('div', 'modal-backdrop');
    const dialog = el('div', 'modal');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'modalTitle');

    const head = el('div', 'modal-head');
    const titles = el('div');
    titles.append(
      el('p', 'eyebrow modal-kicker', kicker),
      Object.assign(el('h2', 'modal-title', title), { id: 'modalTitle' })
    );
    const close = el('button', 'modal-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    head.append(titles, close);

    const form = el('form', 'modal-form');
    form.noValidate = true;
    const body = el('div', 'modal-body');
    const error = el('p', 'form-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const actions = el('div', 'modal-actions');
    const cancel = el('button', 'btn-ghost', 'Cancel');
    cancel.type = 'button';
    const submit = el('button', 'btn-primary', submitLabel);
    submit.type = 'submit';
    actions.append(cancel, submit);
    form.append(body, error, actions);
    dialog.append(head, form);
    backdrop.append(dialog);

    let mm = null;
    function shut() {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      if (mm) mm.revert();
      backdrop.remove();
      if (returnFocus && returnFocus.focus) returnFocus.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { shut(); return; }
      if (e.key !== 'Tab') return;
      const f = dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea');
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function mount() {
      document.body.append(backdrop);
      document.body.style.overflow = 'hidden';
      // Entrance: same back.out(1.35) "arrival" as the logo pop-ins (docs/plan.md §7.3C, §7.4).
      if (window.gsap) {
        mm = gsap.matchMedia();
        mm.add('(prefers-reduced-motion: no-preference)', () => {
          gsap.from(backdrop, { opacity: 0, duration: 0.25, ease: 'power2.out' });
          gsap.from(dialog, { opacity: 0, scale: 0.94, duration: 0.5, ease: 'back.out(1.35)' });
        });
        mm.add('(prefers-reduced-motion: reduce)', () => {
          gsap.set([backdrop, dialog], { opacity: 1, scale: 1 });
        });
      }
      document.addEventListener('keydown', onKey);
      close.addEventListener('click', shut);
      cancel.addEventListener('click', shut);
      backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) shut(); });
      const firstField = form.querySelector('input:not(:disabled), select:not(:disabled), textarea');
      if (firstField) firstField.focus();
    }
    const fail = msg => { error.textContent = msg; error.hidden = false; };
    return { form, body, actions, submit, fail, shut, mount };
  }

  function openBooking(kind, opts) {
    opts = opts || {};
    if (!UnliSession.ready()) { toast('Still signing you in. Try again in a moment.'); return; }
    const s = session();
    if (!s) { location.href = UnliSession.root + 'login.html'; return; }
    // UI gate only — the server must reject reserves from non-staff (§4.6).
    if (kind === 'reserve' && !isStaff(s)) return;

    const staff = isStaff(s);
    const m = modal({
      kicker: kind === 'hold' ? 'Limited stock' : 'Catering & groups',
      title: kind === 'hold' ? 'Hold for pickup' : 'New reserve',
      submitLabel: kind === 'hold' ? 'Place hold' : 'Save reserve',
    });
    const { form, body, submit, fail, shut } = m;
    const today = new Date();
    const maxDay = new Date(today);
    maxDay.setDate(maxDay.getDate() + RESERVE_WEEKS * 7);

    const nameIn = input('bkName', 'text', { autocomplete: 'name', maxlength: '60', required: '' });
    nameIn.value = staff ? '' : s.name;
    const emailIn = input('bkEmail', 'email', { autocomplete: 'email', maxlength: '80', placeholder: 'Optional' });

    // Only branches taking bookings; firestore.rules refuses the rest.
    const branches = store.branches().filter(b => b.active === true);
    const branchIn = input('bkBranch', 'select');
    branches.forEach(b => {
      const o = el('option', '', b.name);
      o.value = b.id;
      if (b.id === opts.branch) o.selected = true;
      branchIn.append(o);
    });
    if (!branches.length) branchIn.disabled = true;
    const branchHint = el('p', 'form-hint');
    const pickedBranch = () => branches.find(b => b.id === branchIn.value) || null;
    // Holds: any time the branch is open. Reserves: up to last seating.
    const hours = b => ({ from: b.open, to: kind === 'hold' ? b.close : b.lastSeating });

    let itemIn, qtyIn, timeIn, dateIn, partyIn, notesIn;

    if (kind === 'hold') {
      itemIn = input('bkItem', 'select');
      store.menu().filter(m => m.limited === true && m.hidden !== true).forEach(m => {
        const o = el('option', '', m.name);
        o.value = m.id;
        if (m.id === opts.item) o.selected = true;
        itemIn.append(o);
      });
      qtyIn = input('bkQty', 'number', { min: '1', max: '10', step: '1', inputmode: 'numeric' });
      qtyIn.value = '1';
      timeIn = input('bkTime', 'time', { required: '' });
      timeIn.value = hhmm(new Date(today.getTime() + 30 * 60000));

      const row = el('div', 'form-row');
      row.append(field('Quantity', qtyIn), field('Pickup time', timeIn));
      body.append(field('Item', itemIn), field('Branch', branchIn), row, branchHint, field(staff ? 'Customer name' : 'Name for pickup', nameIn));
      if (staff) body.append(field('Customer email', emailIn));
      if (!itemIn.options.length) {
        itemIn.disabled = true;
        body.append(el('p', 'form-hint', 'Nothing is available to hold right now.'));
      }
    } else {
      // Native date input + min/max (docs/plan.md §7.3C). Range is re-checked on submit
      // because min/max can be bypassed by typing — and the server re-checks again (§4.7).
      dateIn = input('bkDate', 'date', { min: isoDate(today), max: isoDate(maxDay), required: '' });
      timeIn = input('bkTime', 'time', { required: '' });
      timeIn.value = '18:00';
      partyIn = input('bkParty', 'number', { min: '1', max: '60', step: '1', inputmode: 'numeric' });
      partyIn.value = '10';
      notesIn = input('bkNotes', 'textarea', { maxlength: '200', rows: '3', placeholder: 'Optional — occasion, food notes' });

      const row = el('div', 'form-row');
      row.append(field('Time', timeIn), field('Party size', partyIn));
      body.append(
        field('Branch', branchIn),
        field('Customer name', nameIn),
        field('Customer email', emailIn),
        field('Date', dateIn, 'Up to 15 weeks ahead — latest ' + fmtDate(isoDate(maxDay)) + '.'),
        row,
        branchHint,
        field('Notes', notesIn)
      );
    }

    // The time window follows the chosen branch's hours.
    function syncBranch() {
      const b = pickedBranch();
      if (!b) { branchHint.textContent = 'No branch is taking bookings right now.'; return; }
      const { from, to } = hours(b);
      timeIn.min = from;
      timeIn.max = to;
      branchHint.textContent = kind === 'hold'
        ? 'Pick up today at Unli Chix ' + b.name + ', ' + fmtTime(from) + '–' + fmtTime(to) + '.'
        : 'Unli Chix ' + b.name + ' seats from ' + fmtTime(from) + ' to ' + fmtTime(to) + '.';
    }
    branchIn.addEventListener('change', syncBranch);
    syncBranch();

    if ((itemIn && itemIn.disabled) || branchIn.disabled) submit.disabled = true;

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const name = nameIn.value.trim();
      const email = emailIn.value.trim();
      const time = timeIn.value;
      const branch = pickedBranch();
      if (!branch) return fail('Choose a branch.');
      const { from, to } = hours(branch);
      if (!name) return fail('Enter a name for this booking.');
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email, or leave it blank.');
      if (!time || time < from || time > to) return fail('Choose a time between ' + fmtTime(from) + ' and ' + fmtTime(to) + '.');

      let ticket;
      if (kind === 'hold') {
        const item = store.menu().find(m => m.id === itemIn.value && m.limited === true && m.hidden !== true);
        const qty = Number(qtyIn.value);
        if (!item) return fail('Choose an item to hold.');
        if (!Number.isInteger(qty) || qty < 1 || qty > 10) return fail('Hold between 1 and 10.');
        if (time <= hhmm(new Date())) return fail('Choose a pickup time later today.');
        ticket = {
          type: 'hold', status: 'held',
          where: name.split(' ')[0],
          time: 'Pickup ' + fmtTime(time),
          items: [item.name + ' × ' + qty],
          itemId: item.id,
          branch: branch.id, date: isoDate(new Date()), slot: time,
          customer: { name, email: (staff ? email : s.email).toLowerCase() },
        };
      } else {
        const date = dateIn.value;
        const party = Number(partyIn.value);
        if (!date || date < dateIn.min || date > dateIn.max) return fail('Pick a date between today and ' + fmtDate(dateIn.max) + '.');
        if (!Number.isInteger(party) || party < 1 || party > 60) return fail('Party size must be 1 to 60.');
        const notes = notesIn.value.trim();
        ticket = {
          type: 'reserve', status: 'reserved',
          where: fmtDate(date) + ' · ' + fmtTime(time),
          branch: branch.id, date, slot: time, at: Timestamp.fromDate(new Date(date + 'T' + time + ':00')),
          party,
          time: 'Booked ' + fmtDate(isoDate(today)),
          items: ['Group feast · ' + name].concat(notes ? [notes] : []),
          customer: { name, email: email.toLowerCase() },
        };
      }

      submit.disabled = true;
      try {
        await store.addTicket(ticket);
      } catch (err) {
        console.warn('Could not save ticket:', err.code || err);
        submit.disabled = false;
        return fail(err.code === 'permission-denied'
          ? 'This booking isn’t allowed. The item may have just been taken off the menu, or the branch paused bookings.'
          : 'Couldn’t save the booking. Check your connection and try again.');
      }
      store.log(kind === 'hold' ? 'Placed hold' : 'Created reserve', '#' + ticket.no)
        .catch(err => console.warn('Could not write audit log:', err.code || err));
      shut();
      toast(kind === 'hold'
        ? 'Hold #' + ticket.no + ' placed. Pick up at Unli Chix ' + branch.name + '.'
        : 'Reserve #' + ticket.no + ' saved for ' + ticket.where + '.');
      if (opts.onSaved) opts.onSaved(ticket);
    });

    m.mount();
  }

  // ─── EXPORT ──────────────────────────────────────────────────────────────
  window.Unli = {
    session, isStaff, isManager,
    store, openBooking, toast, el,
    modal, field, input,
  };
})();
