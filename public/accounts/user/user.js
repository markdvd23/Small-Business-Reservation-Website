import { auth, db, doc, getDoc, serverTimestamp, resendVerification, exportMyData, deleteMyAccount } from '../../js/firebase.js';
import { updateDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { STATUS, watchMine, upcoming, whenOf, byBooking, newestFirst, fmtCreated, isoDate, fmtSlot, branchOf, loadBranches } from './mine.js';

const profileForm = document.getElementById('profileForm');
const nameField = document.getElementById('displayName');
const emailField = document.getElementById('email');
const saveBtn = document.getElementById('saveBtn');
const saveNote = document.getElementById('saveNote');
const plans = document.getElementById('plans');
const meals = document.getElementById('meals');
const verifyBox = document.getElementById('verifyBox');
const verifyBtn = document.getElementById('verifyBtn');

verifyBtn.addEventListener('click', async () => {
  verifyBtn.disabled = true;
  try {
    await resendVerification();
    verifyBtn.textContent = 'Verification email sent';
  } catch (err) {
    console.warn('Could not send verification email:', err.code || err);
    verifyBtn.textContent = 'Try sending again';
    verifyBtn.disabled = false;
  }
});

document.getElementById('exportData').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const data = await exportMyData();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    link.download = 'unli-chix-my-data.json';
    document.body.append(link);
    link.click();
    setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
  } catch (err) {
    console.warn('Could not export data:', err.code || err);
    Unli.toast('Couldn’t download your data. Try again.');
  } finally { button.disabled = false; }
});

document.getElementById('deleteAccount').addEventListener('click', async event => {
  if (!confirm('Permanently delete your account? Upcoming reservations will be cancelled. This cannot be undone.')) return;
  const typed = prompt('Type DELETE to confirm.');
  if (typed !== 'DELETE') return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await deleteMyAccount();
    location.replace('../../index.html');
  } catch (err) {
    console.warn('Could not delete account:', err.code || err);
    button.disabled = false;
    Unli.toast('Couldn’t delete your account. Try signing in again first.');
  }
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function link(href, text) { return Object.assign(el('a', 'text-link', text), { href }); }
const detail = t => 'ticket.html?id=' + encodeURIComponent(t.id);

function showName(name) {
  document.querySelectorAll('[data-name]').forEach(n => { n.textContent = name || 'Your feast pass'; });
  document.querySelectorAll('[data-first-name]').forEach(n => { n.textContent = name ? name.split(' ')[0] + '.' : 'there.'; });
}

// ─── ACCOUNT DETAILS ───────────────────────────────────────────────────────
// Only the display name is editable; the rules refuse changes to role or email.
profileForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!profileForm.reportValidity()) return;
  if (!auth.currentUser) { saveNote.textContent = 'Still signing you in. Try again in a moment.'; return; }
  const name = nameField.value.trim();
  if (!name) { nameField.value = ''; profileForm.reportValidity(); return; }
  saveBtn.disabled = true;
  saveNote.dataset.state = 'saving';
  saveNote.textContent = 'Saving…';
  try {
    await updateDoc(doc(db, 'users', auth.currentUser.uid), { name, updatedAt: serverTimestamp() });
    showName(name);
    saveNote.dataset.state = 'ok';
    saveNote.textContent = 'Changes saved.';
  } catch (err) {
    console.warn('Could not save profile:', err.code || err);
    saveNote.dataset.state = 'error';
    saveNote.textContent = 'Couldn’t save your changes. Try again in a moment.';
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById('holdOpen').addEventListener('click', () => Unli.openBooking('hold'));

// ─── CARDS ─────────────────────────────────────────────────────────────────
function fill(card, body, ...nodes) {
  card.classList.remove('is-loading');
  card.removeAttribute('aria-busy');
  body.replaceChildren(...nodes);
}

function renderPlans(all) {
  const next = all.filter(t => upcoming(t)).sort(byBooking)[0];
  const body = document.getElementById('plansBody');
  if (!next) {
    return fill(plans, body,
      el('h2', 'section-title', 'No plans yet.'),
      el('p', 'lede', 'Book a table and it shows up here.'),
      link('book.html', 'Book a table →'));
  }
  const more = all.filter(t => upcoming(t)).length - 1;
  const links = el('p', 'card-links');
  links.append(link(detail(next), 'View reservation →'), link('book.html', 'Book another →'));
  fill(plans, body,
    el('h2', 'section-title', 'Table for ' + (next.party || '—')),
    el('p', 'lede', ['Unli Chix ' + branchOf(next).name, whenOf(next)].filter(Boolean).join(' · ')),
    el('p', 'status-pill', STATUS[next.status]),
    ...(more > 0 ? [el('p', 'form-hint', '+ ' + more + ' more upcoming ' + (more === 1 ? 'table' : 'tables'))] : []),
    links);
}

function renderMeals(all) {
  const orders = all.filter(t => t.type === 'order').sort(newestFirst).slice(0, 3);
  const body = document.getElementById('mealsBody');
  if (!orders.length) {
    return fill(meals, body,
      el('h2', 'section-title', 'No orders yet.'),
      el('p', 'lede', 'Your dine-in and pickup orders will appear here.'),
      link('../../menu.html', 'See the feast →'));
  }
  const list = el('ul', 'mine-list');
  orders.forEach(t => {
    const li = el('li');
    const a = Object.assign(el('a', 'mine-row'), { href: detail(t) });
    a.append(el('span', 'mine-no', '#' + t.no), el('span', 'mine-items', (t.items || []).join(', ')),
      el('span', 'status-pill', STATUS[t.status]), el('small', 'mine-time', fmtCreated(t)));
    li.append(a);
    list.append(li);
  });
  fill(meals, body, el('h2', 'section-title', orders.length === 1 ? '1 recent order' : orders.length + ' recent orders'),
    list, link('../../menu.html', 'See the feast →'));
}

// Holds placed today and still waiting, plus anything picked up today.
function renderHolds(all) {
  const today = isoDate(new Date());
  const holds = all.filter(t => t.type === 'hold' && (t.status === 'held' || t.date === today)).sort(newestFirst);
  const body = document.getElementById('holdsBody');
  if (!holds.length) return body.replaceChildren();
  const list = el('ul', 'mine-list');
  holds.forEach(t => {
    const li = el('li');
    const a = Object.assign(el('a', 'mine-row'), { href: detail(t) });
    a.append(el('span', 'mine-no', '#' + t.no), el('span', 'mine-items', (t.items || []).join(', ')),
      el('span', 'status-pill', STATUS[t.status]), el('small', 'mine-time', t.slot ? 'Pickup ' + fmtSlot(t.slot) : (t.time || '')));
    li.append(a);
    list.append(li);
  });
  body.replaceChildren(el('p', 'label holds-label', 'Your holds'), list);
}

function failed() {
  const retry = () => location.reload();
  [[plans, 'plansBody', 'Couldn’t load your plans.'], [meals, 'mealsBody', 'Couldn’t load your orders.']].forEach(([card, id, msg]) => {
    const btn = el('button', 'btn-ghost', 'Try again');
    btn.type = 'button';
    btn.addEventListener('click', retry);
    fill(card, document.getElementById(id), el('p', 'form-error', msg), btn);
  });
}

// ─── START ─────────────────────────────────────────────────────────────────
await Promise.all([UnliSession.whenReady(), loadBranches()]);
const user = auth.currentUser;
if (user) {
  verifyBox.hidden = user.emailVerified;
  emailField.value = user.email;
  document.getElementById('passEmail').textContent = user.email;

  const snap = await getDoc(doc(db, 'users', user.uid)).catch(() => null);
  const profile = (snap && snap.exists() && snap.data()) || {};
  nameField.value = profile.name || '';
  showName(profile.name || '');
  const since = profile.createdAt && profile.createdAt.toDate
    ? profile.createdAt.toDate().toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toUpperCase()
    : null;
  document.getElementById('passMeta').textContent =
    [since && 'MEMBER SINCE ' + since, 'CHIX-' + user.uid.slice(0, 6).toUpperCase()].filter(Boolean).join(' · ');

  watchMine(all => { renderPlans(all); renderMeals(all); renderHolds(all); }, failed);
}
