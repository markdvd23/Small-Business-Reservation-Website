/* One ticket, live (docs/plan.md build order 5). The customer may cancel their own
 * upcoming reservation; firestore.rules only allows reserved → cancelled. */
import { auth, db, doc, serverTimestamp } from '../../js/firebase.js';
import { onSnapshot, updateDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { STATUS, TYPE, upcoming, whenOf, fmtCreated, fmtSlot, branchOf, downloadIcs, loadBranches } from './mine.js';

const box = document.getElementById('detail');
const id = new URLSearchParams(location.search).get('id');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(...nodes) {
  box.classList.remove('is-loading');
  box.removeAttribute('aria-busy');
  box.replaceChildren(...nodes);
}

function missing() {
  document.title = 'Ticket not found — Unli Chix';
  show(el('h1', 'section-title', 'Ticket not found'),
    el('p', 'lede', 'This ticket doesn’t exist, or it isn’t on your account.'),
    Object.assign(el('a', 'btn-primary', 'Back to my account'), { href: 'index.html' }));
}

function render(t) {
  document.title = '#' + t.no + ' — Unli Chix';
  const rows = [
    ['Type', TYPE[t.type] || t.type],
    ['Status', STATUS[t.status] || t.status],
    ['Branch', ['Unli Chix ' + branchOf(t).name, branchOf(t).address].filter(Boolean).join(' · ')],
    t.type === 'reserve' && ['When', whenOf(t)],
    t.type === 'reserve' && t.party && ['Party', t.party + (t.party === 1 ? ' guest' : ' guests')],
    t.type === 'hold' && ['Pickup', t.slot ? 'Today, ' + fmtSlot(t.slot) : (t.time || '').replace(/^Pickup /, '')],
    t.type === 'reserve' && t.customer && ['Name', t.customer.name],
    t.customer && t.customer.phone && ['Mobile', t.customer.phone],
    [t.type === 'reserve' ? 'Details' : 'Items', (t.items || []).join(', ')],
    ['Placed', fmtCreated(t)],
  ].filter(Boolean);

  const dl = el('dl');
  rows.forEach(([k, v]) => dl.append(el('dt', '', k), el('dd', '', v)));

  const actions = el('div', 'detail-actions');
  const note = el('small', 'save-note');
  note.setAttribute('aria-live', 'polite');
  if (upcoming(t)) {
    const move = Object.assign(el('a', 'btn-ghost', 'Reschedule'), { href: 'book.html?branch=' + encodeURIComponent((t.branch || '').toLowerCase()) + '&reschedule=' + encodeURIComponent(t.id) });
    const cancel = el('button', 'btn-ghost', 'Cancel reservation');
    cancel.type = 'button';
    cancel.addEventListener('click', () => cancelReserve(t, cancel, note));
    actions.append(move, cancel);
    if (t.at || (t.date && t.slot)) {
      const ics = el('button', 'btn-ghost', 'Add to calendar');
      ics.type = 'button';
      ics.addEventListener('click', () => downloadIcs(t));
      actions.prepend(ics);
    }
  }
  actions.append(Object.assign(el('a', 'text-link', t.type === 'order' ? 'See the feast →' : 'View branch →'),
    { href: t.type === 'order' ? '../../menu.html' : '../../branches.html' }), note);

  const qr = el('div', 'reservation-qr');
  if (t.type === 'reserve') {
    const code = el('div');
    code.setAttribute('role', 'img');
    code.setAttribute('aria-label', 'Reservation QR code for #' + t.no);
    qr.append(code);
    if (window.QRCode) new QRCode(code, { text: 'unlichix:reservation:' + t.id + ':' + t.no, width: 160, height: 160, correctLevel: QRCode.CorrectLevel.M });
    qr.append(el('small', 'form-hint', 'Show this code or reservation number when you arrive.'));
  }
  show(el('p', 'label', TYPE[t.type] || 'Ticket'), el('h1', 'section-title', '#' + t.no), qr, dl, actions);
}

async function cancelReserve(t, btn, note) {
  if (!confirm('Cancel your reservation for ' + whenOf(t) + '?')) return;
  btn.disabled = true;
  note.dataset.state = 'saving';
  note.textContent = 'Cancelling…';
  try {
    await updateDoc(doc(db, 'tickets', t.id), { status: 'cancelled', updatedAt: serverTimestamp() });
    Unli.store.log('Cancelled reserve', '#' + t.no).catch(err => console.warn('Could not write audit log:', err.code || err));
    Unli.toast('Reservation #' + t.no + ' cancelled.');
  } catch (err) {
    console.warn('Could not cancel:', err.code || err);
    btn.disabled = false;
    note.dataset.state = 'error';
    note.textContent = 'Couldn’t cancel. Try again, or call the branch.';
  }
}

await Promise.all([UnliSession.whenReady(), loadBranches()]);
if (auth.currentUser) {
  if (!id) missing();
  // A ticket that isn't yours is refused by the rules, so it reads as "not found".
  else onSnapshot(doc(db, 'tickets', id), snap => (snap.exists() ? render({ id: snap.id, ...snap.data() }) : missing()), missing);
}
