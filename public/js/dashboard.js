/* Staff + Manager board (docs/plan.md §7.3B).
 * Phase 1: shell — role badge, rail, empty queue.
 * Phase 2: ticket cards from sample data, ScrollTrigger.batch reveal, status clip bar.
 * Phase 3: New hold / New reserve open the shared booking modal (app.js).
 * Phase 4: manager-only invisible-list drawer on tickets + Hidden items view.
 * Phase 5: manager-only, read-only account lookup (logged, no motion).
 * Data: Firestore via app.js. The redirect below only spares non-staff an empty
 * page; firestore.rules is what refuses them the data (docs/plan.md §4.3, §4.6). */
(async function () {
  'use strict';

  await UnliSession.whenReady();
  const role = UnliSession.role();
  if (role !== 'staff' && role !== 'manager') { location.replace('login.html'); return; }
  const manager = role === 'manager';

  const ICONS = {
    queue:    '<path d="M3 5h18M6 5v5h5V5M13 5v7h5V5"/>',
    orders:   '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>',
    holds:    '<path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    reserves: '<rect x="4" y="5" width="16" height="15" rx="1"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    menu:     '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M16 3c-2 1.5-2.5 4-2.5 7H17V3zM17 10v11"/>',
    hidden:   '<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/><path d="M4 4l16 16"/>',
    accounts: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6"/>',
    branches: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  };

  // Manager views are never built for Staff — not hidden with CSS (docs/plan.md §7.3B).
  const VIEWS = [
    { id: 'queue',    label: 'All tickets', filter: () => true,
      empty: 'No tickets on the rail.',        hint: 'Orders, holds, and reserves land here as they come in.' },
    { id: 'orders',   label: 'Orders',      filter: t => t.type === 'order',
      empty: 'No dine-in orders yet.',          hint: 'Table orders show here from the moment they’re placed until they’re served.' },
    { id: 'holds',    label: 'Holds',       filter: t => t.type === 'hold',
      empty: 'No pickup holds.',                hint: 'Limited items held for pickup stay here until the customer collects them.' },
    { id: 'reserves', label: 'Reserves',    filter: t => t.type === 'reserve',
      empty: 'No reserves booked.',             hint: 'Table bookings from customers and catering you book show here. Seat the party when they arrive.' },
    { id: 'menu',     label: 'Menu',
      empty: 'No dishes on the menu yet.',     hint: 'Add a dish and it shows on the feast page right away.' },
    { id: 'hidden',   label: 'Hidden items', managerOnly: true,
      empty: 'Nothing hidden from customers.', hint: 'Dishes you hide from the menu — sold out or VIP-only — are listed here.' },
    { id: 'branches', label: 'Branches', managerOnly: true,
      empty: 'No branches yet.',               hint: 'Add a branch so customers can book a table or hold a dish there.' },
    { id: 'accounts', label: 'Account lookup', managerOnly: true,
      empty: 'No account open.',             hint: 'Look up a customer to help with their order. Lookups are read-only and logged.' },
  ].filter(v => manager || !v.managerOnly);

  // ─── TICKETS ─────────────────────────────────────────────────────────────
  // Live from Firestore (app.js). Staff may only change status (firestore.rules).
  // The board shows the picked branch only; '' is every branch.
  let pick = new URLSearchParams(location.search).get('branch') || '';
  const tickets = () => Unli.store.tickets().filter(t => !pick || t.branch === pick);

  const TYPES = { order: 'Dine-in', hold: 'Pickup', reserve: 'Reserve' };

  // Reserves booked online store `where` as "2026-10-13 · 18:00"; show it like the rest.
  const fmtDay = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
  const whenText = t => (t.type === 'reserve' && t.date && t.slot ? fmtDay(t.date) + ' · ' + fmtTime(t.slot) : t.where);
  // On the all-branches board each ticket says where it is.
  const branchText = t => (!pick && t.branch ? (Unli.store.branch(t.branch) || { name: t.branch }).name : '');

  document.getElementById('exportCsv').addEventListener('click', () => {
    const rows = [['Number', 'Type', 'Status', 'Branch', 'Date', 'Time', 'Party', 'Customer', 'Email', 'Phone', 'Items']];
    tickets().forEach(t => rows.push([
      t.no, t.type, t.status, t.branch || '', t.date || '', t.slot || '', t.party || '',
      t.customer?.name || '', t.customer?.email || '', t.customer?.phone || '', (t.items || []).join(' | '),
    ]));
    const csv = rows.map(row => row.map(value => '"' + String(value ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    link.download = 'unli-chix-' + (pick || 'all-branches').toLowerCase() + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.append(link);
    link.click();
    setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
  });

  // Food-state vocabulary (docs/plan.md §7.1): raw → cooking → plated → served.
  const STEPS = {
    raw:       { label: 'Raw',       next: 'cooking',   action: 'Start cooking' },
    cooking:   { label: 'Cooking',   next: 'plated',    action: 'Plate it' },
    plated:    { label: 'Plated',    next: 'served',    action: 'Mark served' },
    served:    { label: 'Served',    done: true },
    held:      { label: 'Held',      next: 'collected', action: 'Mark picked up' },
    collected: { label: 'Picked up', done: true },
    reserved:  { label: 'Reserved',  next: 'seated',    action: 'Seat party' },
    seated:    { label: 'Seated',    done: true },
    cancelled: { label: 'Cancelled', done: true },
  };

  const isOpen = t => !STEPS[t.status].done;

  document.getElementById('roleBadge').textContent = manager ? 'Manager' : 'Staff';

  // Managers get the entry to the authorized security & resilience suite
  // (plawidnwad.md §6 Stage 5). Never shown to staff; the suite re-checks the
  // role and the host allowlist itself before anything runs.
  if (manager) { const sec = document.getElementById('securityLink'); if (sec) sec.hidden = false; }

  // ─── BRANCH PICKER ───────────────────────────────────────────────────────
  // Narrows the board to one branch. Kept in ?branch= so a reload or bookmark
  // keeps it; new holds and reserves start on it.
  const branchPick = document.getElementById('boardBranch');
  const boardName = document.getElementById('boardName');
  let branchSig = null;

  function paintBoardName() {
    const b = Unli.store.branch(pick);
    boardName.textContent = (pick ? (b ? b.name : pick) + ' branch' : 'All branches') + ' · ' + (manager ? 'Manager' : 'Staff') + ' board';
  }

  function fillBranchPick() {
    const list = Unli.store.branches();
    // A branch from the URL that doesn't exist (once branches have loaded) falls back to all.
    if (pick && Unli.store.branchesLoaded() && !list.some(b => b.id === pick)) { pick = ''; keepPick(); }
    const sig = pick + '|' + list.map(b => b.id + ':' + b.name + ':' + b.active).join(',');
    if (sig === branchSig) return;
    branchSig = sig;
    const opts = list.map(b => new Option(b.name + (b.active ? '' : ' (paused)'), b.id));
    if (pick && !list.some(b => b.id === pick)) opts.push(new Option(pick, pick));
    branchPick.replaceChildren(new Option('All branches', ''), ...opts);
    branchPick.value = pick;
    paintBoardName();
  }

  function keepPick() {
    const url = new URL(location.href);
    if (pick) url.searchParams.set('branch', pick); else url.searchParams.delete('branch');
    history.replaceState(null, '', url);
  }

  branchPick.addEventListener('change', () => {
    pick = branchPick.value;
    keepPick();
    fillBranchPick();
    updateCounts();
    show();
  });

  // ─── RAIL ────────────────────────────────────────────────────────────────
  const rail = document.getElementById('rail');

  function group(id, label, views) {
    const wrap = document.createElement('div');
    wrap.className = 'rail-group';
    const heading = document.createElement('p');
    heading.className = 'label rail-label';
    heading.id = id;
    heading.textContent = label;
    const ul = document.createElement('ul');
    ul.setAttribute('aria-labelledby', id);
    views.forEach(v => {
      const a = document.createElement('a');
      a.href = '#' + v.id;
      a.title = v.label;
      a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[v.id] + '</svg>';
      const text = document.createElement('span');
      text.className = 'rail-text';
      text.textContent = v.label;
      a.append(text);
      if (v.filter) {
        const count = document.createElement('span');
        count.className = 'rail-count';
        count.dataset.view = v.id;
        a.append(count);
      }
      const li = document.createElement('li');
      li.append(a);
      ul.append(li);
    });
    wrap.append(heading, ul);
    return wrap;
  }

  rail.append(group('railBoard', 'Board', VIEWS.filter(v => !v.managerOnly)));
  if (manager) rail.append(group('railManager', 'Manager only', VIEWS.filter(v => v.managerOnly)));

  function updateCounts() {
    const all = tickets();
    rail.querySelectorAll('.rail-count').forEach(c => {
      const view = VIEWS.find(v => v.id === c.dataset.view);
      const open = all.filter(view.filter).filter(isOpen).length;
      c.hidden = open === 0;
      c.innerHTML = '';
      c.append(open, Object.assign(document.createElement('span'), { className: 'sr', textContent: ' open' }));
    });
    const today = new Date().toLocaleDateString('en-CA');
    const todayReservations = all.filter(t => t.type === 'reserve' && t.date === today && t.status !== 'cancelled');
    document.getElementById('metricOpen').textContent = all.filter(isOpen).length;
    document.getElementById('metricReservations').textContent = todayReservations.length;
    document.getElementById('metricGuests').textContent = todayReservations.reduce((sum, t) => sum + (Number(t.party) || 0), 0);
    document.getElementById('metricWaitlist').textContent = Unli.store.waitlist().filter(w => w.status === 'waiting' && (!pick || w.branch === pick)).length;
  }

  // ─── TICKET CARD (signature element, docs/plan.md §7.2) ───────────────────────
  const grid = document.getElementById('tickets');
  const live = document.getElementById('boardStatus');

  function card(t) {
    const el = document.createElement('article');
    el.className = 'ticket tkt';
    el.tabIndex = -1;
    el.setAttribute('aria-labelledby', 'tkt-' + t.no);

    const clip = document.createElement('span');
    clip.className = 'tkt-clip';
    clip.setAttribute('aria-hidden', 'true');

    const top = document.createElement('div');
    top.className = 'tkt-top';
    const no = document.createElement('h3');
    no.className = 'tkt-no';
    no.id = 'tkt-' + t.no;
    no.textContent = '#' + t.no;
    const status = document.createElement('span');
    status.className = 'tkt-status';
    top.append(no, status);

    const where = document.createElement('p');
    where.className = 'label tkt-where';
    where.textContent = [TYPES[t.type], branchText(t), whenText(t), t.party ? t.party + ' diners' : '', t.customer && t.customer.phone].filter(Boolean).join(' · ');

    const items = document.createElement('ul');
    items.className = 'tkt-items';
    t.items.forEach(i => items.append(Object.assign(document.createElement('li'), { textContent: i })));

    const foot = document.createElement('div');
    foot.className = 'tkt-foot';
    const time = document.createElement('span');
    time.className = 'tkt-time';
    time.textContent = t.time;
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn-primary tkt-next';
    next.addEventListener('click', () => advance(t, el));
    foot.append(time, next);

    el.append(clip, top, where, items, foot);
    const vis = drawer(t);
    if (vis) el.append(vis);
    paint(el, t);
    return el;
  }

  function paint(el, t) {
    const step = STEPS[t.status];
    el.dataset.status = t.status;
    el.classList.toggle('is-done', !!step.done);
    el.querySelector('.tkt-status').textContent = step.label;
    const next = el.querySelector('.tkt-next');
    next.hidden = !step.next;
    if (step.next) next.textContent = step.action;
  }

  function advance(t, el) {
    const step = STEPS[t.status];
    if (!step.next) return;
    // Keep the old colour under the bar so the new one fills over it.
    el.style.setProperty('--prev', getComputedStyle(el).getPropertyValue('--status'));
    t.status = step.next;
    rendered.sig = signature(rendered.list); // the snapshot echo of this change shouldn't rebuild the board
    Unli.store.setStatus(t, t.status).catch(err => {
      console.warn('Could not update ticket:', err.code || err);
      live.textContent = 'Couldn’t save #' + t.no + '. It’s back to its last saved status.';
    });
    paint(el, t);
    el.classList.remove('is-changing');
    void el.offsetWidth; // restart the fill animation
    el.classList.add('is-changing');
    if (STEPS[t.status].done) el.focus();
    live.textContent = '#' + t.no + ' is now ' + STEPS[t.status].label.toLowerCase() + '.';
    updateCounts();
  }

  // ─── INVISIBLE-LIST DRAWER (manager only — docs/plan.md §7.3B, Phase 4) ───────
  // Built only for managers, never hidden with CSS. In the real build the server
  // leaves the invisible-list data out of Staff responses entirely.
  const dishesOn = t => Unli.store.menu().filter(m =>
    t.itemId === m.id || t.items.some(i => i.toLowerCase().includes(m.name.toLowerCase())));
  const isHidden = m => Unli.store.hidden().includes(m.id);

  function drawer(t) {
    const dishes = dishesOn(t);
    if (!manager || !dishes.length) return null;

    const wrap = document.createElement('div');
    wrap.className = 'tkt-vis';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tkt-vis-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'vis-' + t.no);

    const panel = document.createElement('div');
    panel.className = 'tkt-vis-panel';
    panel.id = 'vis-' + t.no;
    panel.hidden = true;
    const ul = document.createElement('ul');
    dishes.forEach(m => {
      const li = document.createElement('li');
      li.dataset.item = m.id;
      const name = document.createElement('span');
      name.className = 'tkt-vis-name';
      name.textContent = m.name;
      const state = document.createElement('span');
      state.className = 'tkt-vis-state';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tkt-vis-btn';
      btn.addEventListener('click', () => setHidden(m, !isHidden(m)));
      li.append(name, state, btn);
      ul.append(li);
    });
    panel.append(ul);

    toggle.addEventListener('click', () => setDrawer(toggle, panel, toggle.getAttribute('aria-expanded') !== 'true'));
    wrap.append(toggle, panel);
    return wrap;
  }

  // Height-auto via GSAP, so reduced motion simply opens/closes in place (§7.3B).
  function setDrawer(toggle, panel, open) {
    toggle.setAttribute('aria-expanded', String(open));
    if (!motion) { panel.hidden = !open; return; }
    gsap.killTweensOf(panel);
    if (open) {
      panel.hidden = false;
      gsap.fromTo(panel, { height: 0 }, { height: 'auto', duration: 0.35, ease: 'power2.out', clearProps: 'height' });
    } else {
      gsap.to(panel, { height: 0, duration: 0.25, ease: 'power2.in',
        onComplete: () => { panel.hidden = true; gsap.set(panel, { clearProps: 'height' }); } });
    }
  }

  // Every drawer showing a dish updates together (Ramen can be on several tickets).
  function paintVisibility() {
    document.querySelectorAll('.tkt-vis').forEach(wrap => {
      let count = 0;
      wrap.querySelectorAll('li').forEach(li => {
        const m = Unli.store.menu().find(x => x.id === li.dataset.item);
        if (!m) return;
        const hidden = isHidden(m);
        if (hidden) count += 1;
        li.classList.toggle('is-hidden', hidden);
        li.querySelector('.tkt-vis-state').textContent = hidden ? 'Hidden from customers' : 'On the menu';
        const btn = li.querySelector('.tkt-vis-btn');
        btn.textContent = hidden ? 'Show again' : 'Hide';
        btn.setAttribute('aria-label', hidden ? 'Show ' + m.name + ' to customers again' : 'Hide ' + m.name + ' from customers');
      });
      wrap.querySelector('.tkt-vis-toggle').textContent = 'Menu visibility' + (count ? ' · ' + count + ' hidden' : '');
    });
  }

  function setHidden(m, hide) {
    Unli.store.setHidden(m.id, hide).catch(err => console.warn('Could not update menu:', err.code || err));
    Unli.store.log(hide ? 'Hid from menu' : 'Returned to menu', m.name).catch(err => console.warn('Could not write audit log:', err.code || err));
    paintVisibility();
    if (currentView().id === 'hidden') renderHidden();
    if (currentView().id === 'menu') renderMenu();
    live.textContent = m.name + (hide ? ' is hidden from customers.' : ' is back on the menu.');
  }

  const hiddenList = document.getElementById('hiddenList');

  function renderHidden() {
    const dishes = Unli.store.menu().filter(isHidden);
    hiddenList.replaceChildren(...dishes.map(m => {
      const li = document.createElement('li');
      const text = document.createElement('div');
      const name = document.createElement('p');
      name.className = 'hidden-name';
      name.textContent = m.name;
      const tag = document.createElement('p');
      tag.className = 'label';
      tag.textContent = (m.tag ? m.tag + ' · ' : '') + 'not on the menu or holds';
      text.append(name, tag);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-ghost';
      btn.textContent = 'Show again';
      btn.setAttribute('aria-label', 'Show ' + m.name + ' to customers again');
      btn.addEventListener('click', () => {
        setHidden(m, false);
        (hiddenList.querySelector('button') || title).focus();
      });
      li.append(text, btn);
      return li;
    }));
    hiddenList.hidden = dishes.length === 0;
    empty.hidden = dishes.length > 0;
  }

  // ─── MENU EDITOR (staff + manager) ───────────────────────────────────────
  // Staff and managers add dishes and edit their details. Hiding and removing
  // stay manager-only, same as the invisible list. firestore.rules enforces both.
  const menuAdmin = document.createElement('div');
  menuAdmin.className = 'menu-admin';
  menuAdmin.hidden = true;
  const menuTools = document.createElement('div');
  menuTools.className = 'menu-admin-tools';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-primary';
  addBtn.textContent = 'Add dish';
  addBtn.addEventListener('click', () => editDish(null));
  const menuNote = document.createElement('p');
  menuNote.className = 'form-hint';
  menuNote.textContent = manager
    ? 'Changes show on the feast page right away. Every change is logged.'
    : 'Changes show on the feast page right away. Every change is logged. Ask a manager to hide or remove a dish.';
  menuTools.append(addBtn, menuNote);

  // ─── SHARED TABLE PIECES (menu + branches) ───────────────────────────────
  function btn(label, className, onClick, aria) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className, textContent: label });
    if (aria) b.setAttribute('aria-label', aria);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // Columns: [label, className]. The label doubles as data-label so each cell
  // can name itself when the table stacks into cards on phones.
  function dataTable(caption, columns) {
    const table = document.createElement('table');
    table.className = 'data-table';
    table.createCaption().append(Object.assign(document.createElement('span'), { className: 'sr', textContent: caption }));
    const head = table.createTHead().insertRow();
    columns.forEach(([label, cls]) => {
      const th = document.createElement('th');
      th.scope = 'col';
      if (cls) th.className = cls;
      if (label) th.textContent = label;
      else th.append(Object.assign(document.createElement('span'), { className: 'sr', textContent: 'Actions' }));
      head.append(th);
    });
    return { table, body: table.createTBody(), columns };
  }

  function row(t, cells, className) {
    const tr = t.body.insertRow();
    if (className) tr.className = className;
    cells.forEach((content, i) => {
      const [label, cls] = t.columns[i];
      const td = tr.insertCell();
      if (cls) td.className = cls;
      if (label) td.dataset.label = label;
      td.append(...[].concat(content));
    });
    return tr;
  }

  function pill(text, tone) {
    return Object.assign(document.createElement('span'), { className: 'pill' + (tone ? ' is-' + tone : ''), textContent: text });
  }

  const dash = () => Object.assign(document.createElement('span'), { className: 'cell-none', textContent: '—', title: 'None' });

  // ─── MENU FILTERS + PAGES ────────────────────────────────────────────────
  const MENU_PAGE = 8;
  const menuState = { q: '', tag: '', vis: 'all', hold: 'all', page: 1 };
  const filtered = () => !!(menuState.q || menuState.tag || menuState.vis !== 'all' || menuState.hold !== 'all');

  const filters = document.createElement('form');
  filters.className = 'filters';
  filters.setAttribute('role', 'search');
  filters.setAttribute('aria-label', 'Filter dishes');
  filters.addEventListener('submit', e => e.preventDefault());
  const qIn = Unli.input('menuQ', 'search', { maxlength: '40', placeholder: 'Name or tag', autocomplete: 'off', spellcheck: 'false' });
  const tagIn = Unli.input('menuTag', 'select');
  const visIn = Unli.input('menuVis', 'select');
  visIn.append(new Option('All dishes', 'all'), new Option('On the menu', 'shown'), new Option('Hidden', 'hidden'));
  const holdIn = Unli.input('menuHold', 'select');
  holdIn.append(new Option('Any', 'all'), new Option('Can be held', 'yes'), new Option('Not holdable', 'no'));
  const clearBtn = btn('Clear filters', 'btn-ghost filters-clear', () => {
    Object.assign(menuState, { q: '', tag: '', vis: 'all', hold: 'all', page: 1 });
    qIn.value = '';
    visIn.value = 'all';
    holdIn.value = 'all';
    renderMenu();
    qIn.focus();
  });
  filters.append(
    Object.assign(Unli.field('Search', qIn), { className: 'form-field filters-search' }),
    Unli.field('Tag', tagIn),
    Unli.field('Status', visIn),
    Unli.field('Pickup hold', holdIn),
    clearBtn,
  );
  const onFilter = (key, input) => () => { menuState[key] = input.value.trim(); menuState.page = 1; renderMenu(); };
  qIn.addEventListener('input', onFilter('q', qIn));
  tagIn.addEventListener('change', onFilter('tag', tagIn));
  visIn.addEventListener('change', onFilter('vis', visIn));
  holdIn.addEventListener('change', onFilter('hold', holdIn));

  const menuCount = document.createElement('p');
  menuCount.className = 'list-count';
  menuCount.setAttribute('role', 'status');

  const menuTable = dataTable('Menu dishes', [['Dish', 'col-main'], ['Tag'], ['Pickup hold'], ['Status'], ['', 'col-actions']]);

  const pager = document.createElement('nav');
  pager.className = 'pager';
  pager.setAttribute('aria-label', 'Menu pages');
  const pageText = document.createElement('span');
  pageText.className = 'pager-text';
  const goPage = by => () => {
    menuState.page += by;
    renderMenu();
    // Don't strand focus on a button that just became disabled.
    if (document.activeElement && document.activeElement.disabled) (by < 0 ? nextBtn : prevBtn).focus();
  };
  const prevBtn = btn('← Previous', 'btn-ghost', goPage(-1), 'Previous page');
  const nextBtn = btn('Next →', 'btn-ghost', goPage(1), 'Next page');
  pager.append(prevBtn, pageText, nextBtn);

  menuAdmin.append(menuTools, filters, menuCount, menuTable.table, pager);
  hiddenList.after(menuAdmin);

  function fillTags(dishes) {
    const tags = [...new Set(dishes.map(m => (m.tag || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (menuState.tag && !tags.includes(menuState.tag)) menuState.tag = '';
    const sig = tags.join('|');
    if (tagIn.dataset.sig !== sig) {
      tagIn.replaceChildren(new Option('All tags', ''), ...tags.map(t => new Option(t, t)));
      tagIn.dataset.sig = sig;
    }
    tagIn.value = menuState.tag;
  }

  function menuMatches(m) {
    const q = menuState.q.toLowerCase();
    if (q && !m.name.toLowerCase().includes(q) && !(m.tag || '').toLowerCase().includes(q)) return false;
    if (menuState.tag && (m.tag || '').trim() !== menuState.tag) return false;
    if (menuState.vis !== 'all' && isHidden(m) !== (menuState.vis === 'hidden')) return false;
    if (menuState.hold !== 'all' && (m.limited === true) !== (menuState.hold === 'yes')) return false;
    return true;
  }

  function dishCell(m) {
    const thumb = m.image ? Object.assign(document.createElement('img'), { src: m.image, alt: '', loading: 'lazy' })
      : Object.assign(document.createElement('span'), { className: 'menu-thumb-ph', textContent: m.name.charAt(0) });
    thumb.classList.add('menu-thumb');
    const text = document.createElement('div');
    text.className = 'cell-text';
    text.append(Object.assign(document.createElement('p'), { className: 'cell-name', textContent: m.name }));
    if (m.blurb) text.append(Object.assign(document.createElement('p'), { className: 'cell-sub', textContent: m.blurb, title: m.blurb }));
    const wrap = document.createElement('div');
    wrap.className = 'cell-with-thumb';
    wrap.append(thumb, text);
    return wrap;
  }

  function renderMenu() {
    const dishes = Unli.store.menu();
    fillTags(dishes);
    const matches = dishes.filter(menuMatches);
    const pages = Math.max(1, Math.ceil(matches.length / MENU_PAGE));
    menuState.page = Math.min(Math.max(1, menuState.page), pages);
    const start = (menuState.page - 1) * MENU_PAGE;
    const shown = matches.slice(start, start + MENU_PAGE);

    menuTable.body.replaceChildren();
    shown.forEach(m => {
      const hidden = isHidden(m);
      const btns = document.createElement('div');
      btns.className = 'row-btns';
      btns.append(btn('Edit', 'btn-ghost', () => editDish(m), 'Edit ' + m.name));
      if (manager) {
        btns.append(btn(hidden ? 'Show' : 'Hide', 'btn-ghost', () => setHidden(m, !hidden),
          hidden ? 'Show ' + m.name + ' to customers' : 'Hide ' + m.name + ' from customers'));
      }
      row(menuTable, [
        dishCell(m),
        m.tag ? m.tag : dash(),
        m.limited ? 'Can be held' : dash(),
        hidden ? pill('Hidden', 'danger') : pill('On the menu', 'ok'),
        btns,
      ], hidden ? 'is-hidden' : '');
    });
    if (!shown.length && dishes.length) {
      const td = menuTable.body.insertRow().insertCell();
      td.colSpan = menuTable.columns.length;
      td.className = 'cell-empty';
      td.textContent = 'No dishes match these filters.';
    }

    menuCount.textContent = matches.length
      ? 'Showing ' + (start + 1) + '–' + (start + shown.length) + ' of ' + matches.length + (matches.length === 1 ? ' dish' : ' dishes')
        + (filtered() ? ' · filtered from ' + dishes.length : '')
      : 'No matches' + (filtered() ? ' · ' + dishes.length + ' dishes in all' : '');
    pageText.textContent = 'Page ' + menuState.page + ' of ' + pages;
    prevBtn.disabled = menuState.page <= 1;
    nextBtn.disabled = menuState.page >= pages;
    pager.hidden = pages <= 1;
    clearBtn.disabled = !filtered();

    const none = dishes.length === 0;
    filters.hidden = none;
    menuCount.hidden = none;
    menuTable.table.hidden = none;
    empty.hidden = !none;
  }

  // ─── BRANCHES (manager only) ─────────────────────────────────────────────
  // Where customers book tables and pick up holds. Tickets store the branch
  // id, so a branch is paused, never deleted (firestore.rules).
  const branchAdmin = document.createElement('div');
  branchAdmin.className = 'menu-admin';
  branchAdmin.hidden = true;
  const branchTable = dataTable('Branches', [['Branch', 'col-main'], ['Hours'], ['Last seating'], ['Bookings'], ['', 'col-actions']]);

  if (manager) {
    const tools = document.createElement('div');
    tools.className = 'menu-admin-tools';
    const note = document.createElement('p');
    note.className = 'form-hint';
    note.textContent = 'Customers see branches taking bookings. Pause one instead of removing it — old tickets still point to it.';
    tools.append(btn('Add branch', 'btn-primary', () => editBranch(null)), note);
    branchAdmin.append(tools, branchTable.table);
    hiddenList.after(branchAdmin);
  }

  const fmtTime = v => { const [h, m] = v.split(':').map(Number); return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM'); };

  function renderBranches() {
    const list = Unli.store.branches();
    branchTable.body.replaceChildren();
    list.forEach(b => {
      const text = document.createElement('div');
      text.className = 'cell-text';
      text.append(
        Object.assign(document.createElement('p'), { className: 'cell-name', textContent: b.name }),
        Object.assign(document.createElement('p'), { className: 'cell-sub', textContent: [b.address, b.phone].filter(Boolean).join(' · ') }),
      );
      const btns = document.createElement('div');
      btns.className = 'row-btns';
      btns.append(
        btn('Edit', 'btn-ghost', () => editBranch(b), 'Edit ' + b.name),
        btn(b.active ? 'Pause' : 'Resume', 'btn-ghost', () => setBranchActive(b, !b.active),
          (b.active ? 'Pause bookings at ' : 'Resume bookings at ') + b.name),
      );
      row(branchTable, [
        text,
        fmtTime(b.open) + '–' + fmtTime(b.close),
        fmtTime(b.lastSeating),
        b.active ? pill('Taking bookings', 'ok') : pill('Paused', 'danger'),
        btns,
      ], b.active ? '' : 'is-hidden');
    });
    branchTable.table.hidden = list.length === 0;
    empty.hidden = list.length > 0;
  }

  const logBranch = (action, target) =>
    Unli.store.log(action, target).catch(err => console.warn('Could not write audit log:', err.code || err));

  function setBranchActive(b, active) {
    Unli.store.editBranch(b.id, { active }).catch(err => {
      console.warn('Could not update branch:', err.code || err);
      Unli.toast('Couldn’t update ' + b.name + '. Try again.');
    });
    logBranch('Edited branch', b.name + (active ? ' · resumed bookings' : ' · paused bookings'));
    live.textContent = active ? b.name + ' is taking bookings again.' : b.name + ' stopped taking bookings.';
  }

  // Letters, digits, dashes — the same id rule firestore.rules checks.
  const branchId = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-').slice(0, 40);
  const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

  function editBranch(b) {
    const isNew = !b;
    const d = b || { name: '', address: '', phone: '', open: '10:00', lastSeating: '20:30', close: '22:00', capacity: 40, active: true,
      sort: Math.max(0, ...Unli.store.branches().map(x => x.sort || 0)) + 10 };
    const dlg = Unli.modal({
      kicker: isNew ? 'New branch' : 'Edit branch',
      title: isNew ? 'Add a branch' : d.name,
      submitLabel: isNew ? 'Add branch' : 'Save changes',
    });
    const val = (input, v) => { input.value = v == null ? '' : v; return input; };
    const nameIn = val(Unli.input('brName', 'text', { maxlength: '40', required: '' }), d.name);
    const addrIn = val(Unli.input('brAddress', 'text', { maxlength: '120', required: '' }), d.address);
    const phoneIn = val(Unli.input('brPhone', 'tel', { maxlength: '20', placeholder: 'Optional', inputmode: 'tel' }), d.phone);
    const openIn = val(Unli.input('brOpen', 'time', { required: '' }), d.open);
    const lastIn = val(Unli.input('brLast', 'time', { required: '' }), d.lastSeating);
    const closeIn = val(Unli.input('brClose', 'time', { required: '' }), d.close);
    const sortIn = val(Unli.input('brSort', 'number', { min: '0', max: '9999', step: '1', inputmode: 'numeric' }), d.sort);
    const capacityIn = val(Unli.input('brCapacity', 'number', { min: '1', max: '500', step: '1', inputmode: 'numeric' }), d.capacity || 40);
    const activeIn = Object.assign(document.createElement('input'), { type: 'checkbox', id: 'brActive', checked: d.active === true });
    const active = document.createElement('label');
    active.className = 'check-field';
    active.append(activeIn, ' Taking bookings — customers can book and hold here');

    const times = document.createElement('div');
    times.className = 'form-row form-row-3';
    times.append(Unli.field('Opens', openIn), Unli.field('Last seating', lastIn), Unli.field('Closes', closeIn));
    const row2 = document.createElement('div');
    row2.className = 'form-row';
    row2.append(Unli.field('Phone', phoneIn), Unli.field('Seat capacity', capacityIn, 'Used to stop overbooking.'), Unli.field('Order', sortIn, 'Lower shows first.'));
    dlg.body.append(Unli.field('Name', nameIn), Unli.field('Address', addrIn), row2, times, active);

    dlg.form.addEventListener('submit', async e => {
      e.preventDefault();
      const branch = {
        name: nameIn.value.trim(),
        address: addrIn.value.trim(),
        phone: phoneIn.value.trim(),
        open: openIn.value,
        lastSeating: lastIn.value,
        close: closeIn.value,
        capacity: Number(capacityIn.value),
        sort: Number(sortIn.value),
        active: activeIn.checked,
      };
      if (!branch.name) return dlg.fail('Give the branch a name.');
      if (!branch.address) return dlg.fail('Add the branch address.');
      if (branch.phone && !/^\+?[0-9 ()-]{7,20}$/.test(branch.phone)) return dlg.fail('Enter a valid phone number, or leave it blank.');
      if (![branch.open, branch.lastSeating, branch.close].every(t => HHMM.test(t))) return dlg.fail('Set opening, last seating, and closing times.');
      if (!(branch.open < branch.lastSeating && branch.lastSeating <= branch.close)) return dlg.fail('Last seating must be after opening and no later than closing.');
      if (!Number.isInteger(branch.capacity) || branch.capacity < 1 || branch.capacity > 500) return dlg.fail('Capacity must be a whole number from 1 to 500.');
      if (!Number.isInteger(branch.sort) || branch.sort < 0 || branch.sort > 9999) return dlg.fail('Order must be a whole number from 0 to 9999.');

      let id = d.id;
      if (isNew) {
        id = branchId(branch.name);
        if (!id) return dlg.fail('Use letters or numbers in the name.');
        if (Unli.store.branch(id)) return dlg.fail('There’s already a branch called that. Pick another name.');
      } else {
        // Only send what changed, so an edit can't undo someone else's.
        Object.keys(branch).forEach(k => { if (branch[k] === (d[k] ?? '')) delete branch[k]; });
        if (!Object.keys(branch).length) { dlg.shut(); return; }
      }

      dlg.submit.disabled = true;
      try {
        if (isNew) await Unli.store.addBranch(id, branch);
        else await Unli.store.editBranch(id, branch);
      } catch (err) {
        console.warn('Could not save branch:', err.code || err);
        dlg.submit.disabled = false;
        return dlg.fail(err.code === 'permission-denied'
          ? 'You don’t have permission to make that change.'
          : 'Couldn’t save the branch. Check your connection and try again.');
      }
      const label = branch.name || d.name;
      logBranch(isNew ? 'Added branch' : 'Edited branch', label);
      dlg.shut();
      live.textContent = label + (isNew ? ' was added.' : ' was updated.');
      Unli.toast(isNew ? label + ' added.' : label + ' saved.');
    });

    dlg.mount();
  }

  const slug = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  function editDish(m) {
    const isNew = !m;
    const d = m || { name: '', tag: '', blurb: '', image: '', alt: '', limited: false,
      sort: Math.max(0, ...Unli.store.menu().map(x => x.sort || 0)) + 10 };
    const dlg = Unli.modal({
      kicker: isNew ? 'New dish' : 'Edit dish',
      title: isNew ? 'Add to the menu' : d.name,
      submitLabel: isNew ? 'Add dish' : 'Save changes',
    });
    const val = (input, v) => { input.value = v == null ? '' : v; return input; };
    const nameIn = val(Unli.input('dishName', 'text', { maxlength: '40', required: '' }), d.name);
    const tagIn = val(Unli.input('dishTag', 'text', { maxlength: '30', placeholder: 'e.g. Signature' }), d.tag);
    const blurbIn = val(Unli.input('dishBlurb', 'textarea', { maxlength: '160', rows: '3' }), d.blurb);
    const imageIn = val(Unli.input('dishImage', 'url', { maxlength: '500', placeholder: 'https://…', inputmode: 'url' }), d.image);
    const altIn = val(Unli.input('dishAlt', 'text', { maxlength: '120' }), d.alt);
    const sortIn = val(Unli.input('dishSort', 'number', { min: '0', max: '9999', step: '1', inputmode: 'numeric' }), d.sort);
    const limitedIn = Object.assign(document.createElement('input'), { type: 'checkbox', id: 'dishLimited', checked: d.limited === true });
    const limited = document.createElement('label');
    limited.className = 'check-field';
    limited.append(limitedIn, ' Limited — customers can hold it for pickup');

    const row = document.createElement('div');
    row.className = 'form-row';
    row.append(Unli.field('Tag', tagIn), Unli.field('Order', sortIn, 'Lower shows first.'));
    dlg.body.append(
      Unli.field('Name', nameIn),
      row,
      Unli.field('Description', blurbIn),
      Unli.field('Photo URL', imageIn, 'Leave blank to show the dish’s first letter.'),
      Unli.field('Photo description', altIn, 'For screen readers. Say what’s in the photo.'),
      limited,
    );

    if (!isNew && manager) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-ghost btn-danger';
      remove.textContent = 'Remove dish';
      remove.addEventListener('click', async () => {
        if (!confirm('Remove ' + d.name + ' from the menu for good? Hiding it keeps it for later.')) return;
        remove.disabled = true;
        try {
          await Unli.store.removeDish(d.id);
        } catch (err) {
          console.warn('Could not remove dish:', err.code || err);
          remove.disabled = false;
          return dlg.fail('Couldn’t remove the dish. Try again.');
        }
        Unli.store.log('Removed dish', d.name).catch(err => console.warn('Could not write audit log:', err.code || err));
        dlg.shut();
        live.textContent = d.name + ' was removed from the menu.';
        Unli.toast(d.name + ' removed from the menu.');
      });
      dlg.actions.prepend(remove);
    }

    dlg.form.addEventListener('submit', async e => {
      e.preventDefault();
      const dish = {
        name: nameIn.value.trim(),
        tag: tagIn.value.trim(),
        blurb: blurbIn.value.trim(),
        image: imageIn.value.trim(),
        alt: altIn.value.trim(),
        sort: Number(sortIn.value),
        limited: limitedIn.checked,
      };
      if (!dish.name) return dlg.fail('Give the dish a name.');
      if (dish.image && !/^https:\/\/\S+$/.test(dish.image)) return dlg.fail('The photo URL must start with https://.');
      if (!Number.isInteger(dish.sort) || dish.sort < 0 || dish.sort > 9999) return dlg.fail('Order must be a whole number from 0 to 9999.');

      let id = d.id;
      if (isNew) {
        id = slug(dish.name);
        if (!id) return dlg.fail('Use letters or numbers in the name.');
        if (Unli.store.menu().some(x => x.id === id)) return dlg.fail('There’s already a dish called that. Pick another name.');
      } else {
        // Only send what changed, so an edit can't undo someone else's.
        Object.keys(dish).forEach(k => { if (dish[k] === (d[k] ?? (k === 'limited' ? false : ''))) delete dish[k]; });
        if (!Object.keys(dish).length) { dlg.shut(); return; }
      }

      dlg.submit.disabled = true;
      try {
        if (isNew) await Unli.store.addDish(id, { ...dish, hidden: false });
        else await Unli.store.editDish(id, dish);
      } catch (err) {
        console.warn('Could not save dish:', err.code || err);
        dlg.submit.disabled = false;
        return dlg.fail(err.code === 'permission-denied'
          ? 'You don’t have permission to make that change.'
          : 'Couldn’t save the dish. Check your connection and try again.');
      }
      const label = dish.name || d.name;
      Unli.store.log(isNew ? 'Added dish' : 'Edited dish', label).catch(err => console.warn('Could not write audit log:', err.code || err));
      dlg.shut();
      live.textContent = label + (isNew ? ' was added to the menu.' : ' was updated.');
      Unli.toast(isNew ? label + ' added to the menu.' : label + ' saved.');
    });

    dlg.mount();
  }

  // ─── ACCOUNT LOOKUP (manager only, read-only — docs/plan.md §1, §7.3D, Phase 5) ─
  // Exact email or ticket number only: no browsable customer list, so a manager
  // sees one account at a time, and every account opened is logged (§5).
  // The real build also re-authenticates the manager server-side first (§5).
  let acct = null;

  function accountPanel() {
    const wrap = document.createElement('div');
    wrap.className = 'acct';
    wrap.hidden = true;

    const form = document.createElement('form');
    form.className = 'acct-form';
    form.setAttribute('role', 'search');
    form.noValidate = true;
    const label = document.createElement('label');
    label.className = 'field-label';
    label.htmlFor = 'acctQuery';
    label.textContent = 'Customer email or ticket number';
    const row = document.createElement('div');
    row.className = 'acct-row';
    const input = document.createElement('input');
    input.className = 'form-input';
    input.id = 'acctQuery';
    input.type = 'search';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 80;
    input.setAttribute('aria-describedby', 'acctHint');
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'btn-ghost';
    btn.textContent = 'Open account';
    row.append(input, btn);
    const hint = document.createElement('p');
    hint.className = 'form-hint';
    hint.id = 'acctHint';
    hint.textContent = 'Use the full email, or the ticket number from the board.';
    form.append(label, row, hint);

    const notice = document.createElement('p');
    notice.className = 'acct-notice';
    notice.textContent = 'Read-only. Every account you open is logged with your email and the time.';

    const result = document.createElement('div');
    result.className = 'acct-result';

    form.addEventListener('submit', e => {
      e.preventDefault();
      lookup(input.value, result);
    });

    wrap.append(form, notice, result);
    return { wrap, input, result };
  }

  function lookup(raw, result) {
    const q = raw.trim().toLowerCase().replace(/^#/, '');
    const all = Unli.store.tickets(); // every branch: a customer isn't tied to one
    result.replaceChildren();
    if (!q) return miss(result, 'Enter an email or a ticket number.');

    let account;
    if (!q.includes('@')) {
      const t = all.find(x => String(x.no).toLowerCase() === q);
      if (!t) return miss(result, 'No ticket #' + q.toUpperCase() + ' on this board.');
      if (!t.customer) return miss(result, 'Ticket #' + t.no + ' is a dine-in order with no customer account.');
      const email = (t.customer.email || '').toLowerCase();
      account = { name: t.customer.name, email, tickets: email ? all.filter(x => x.customer && (x.customer.email || '').toLowerCase() === email) : [t] };
    } else {
      const theirs = all.filter(x => x.customer && (x.customer.email || '').toLowerCase() === q);
      if (!theirs.length) return miss(result, 'No account matches “' + raw.trim() + '”. Check the spelling, or try their ticket number.');
      account = { name: theirs[0].customer.name, email: q, tickets: theirs };
    }

    Unli.store.log('Viewed account', account.email || account.name + ' (ticket #' + account.tickets[0].no + ')')
      .catch(err => console.warn('Could not write audit log:', err.code || err));
    result.append(accountCard(account));
    result.querySelector('h3').focus();
  }

  function miss(result, message) {
    const p = document.createElement('p');
    p.className = 'form-error';
    p.setAttribute('role', 'alert');
    p.textContent = message;
    result.append(p);
  }

  function accountCard(a) {
    const card = document.createElement('section');
    card.className = 'acct-card';
    card.setAttribute('aria-labelledby', 'acctName');
    const kicker = document.createElement('p');
    kicker.className = 'label';
    kicker.textContent = 'Customer';
    const name = document.createElement('h3');
    name.id = 'acctName';
    name.tabIndex = -1;
    name.textContent = a.name;
    const email = document.createElement('p');
    email.className = 'acct-email';
    email.textContent = a.email || 'No email on file';
    const sub = document.createElement('h4');
    sub.className = 'acct-sub';
    sub.textContent = 'Holds and reserves (' + a.tickets.length + ')';

    const table = document.createElement('table');
    table.className = 'acct-table';
    const head = table.createTHead().insertRow();
    ['Ticket', 'Details', 'Status'].forEach(h => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = h;
      head.append(th);
    });
    const body = table.createTBody();
    a.tickets.forEach(t => {
      const tr = body.insertRow();
      tr.insertCell().textContent = '#' + t.no;
      const when = t.type === 'reserve' ? whenText(t) : (t.time || '').replace(/^Pickup /, '');
      tr.insertCell().textContent = [TYPES[t.type], when].concat(t.items || []).filter(Boolean).join(' · ');
      tr.insertCell().textContent = STEPS[t.status] ? STEPS[t.status].label : t.status;
    });

    card.append(kicker, name, email, sub, table);
    return card;
  }

  // ─── REVEAL (docs/plan.md §7.3B — same recipe as .feast-item) ─────────────────
  let motion = false;
  let batches = [];

  function reveal(cards) {
    batches.forEach(tr => tr.kill());
    batches = [];
    if (!motion || !window.ScrollTrigger || !cards.length) return;
    gsap.set(cards, { opacity: 0, y: 28 });
    batches = ScrollTrigger.batch(cards, {
      start: 'top 95%',
      once: true,
      onEnter: batch => gsap.to(batch, { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out', stagger: 0.07, overwrite: true }),
    });
  }

  // ─── VIEW SWITCHING ──────────────────────────────────────────────────────
  const title = document.getElementById('viewTitle');
  const empty = document.getElementById('queueEmpty');
  const emptyTitle = document.getElementById('emptyTitle');
  const emptyHint = document.getElementById('emptyHint');

  const currentView = () => VIEWS.find(v => '#' + v.id === location.hash) || VIEWS[0];

  // What's on screen, so a Firestore update that changes nothing visible
  // (like the echo of our own status change) doesn't rebuild the board.
  // Menu dish ids are included: drawers are built per dish, so a menu that
  // arrives after the tickets must rebuild them.
  const signature = list => pick + '|' + list.map(t => t.id + ':' + t.status).join(',') + '|' + Unli.store.menu().map(m => m.id).join(',');
  const rendered = { view: null, sig: null, list: [] };

  function show() {
    const view = currentView();

    // Open tickets first, finished ones at the end of the rail.
    const list = view.filter ? tickets().filter(view.filter) : [];
    list.sort((a, b) => isOpen(b) - isOpen(a));
    if (view.id === rendered.view && signature(list) === rendered.sig) {
      paintVisibility();
      if (view.id === 'hidden') renderHidden();
      if (view.id === 'menu') renderMenu();
      if (view.id === 'branches') renderBranches();
      return;
    }
    rendered.view = view.id;
    rendered.sig = signature(list);
    rendered.list = list;

    rail.querySelectorAll('a').forEach(a => {
      if (a.hash === '#' + view.id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    title.textContent = view.label;
    emptyTitle.textContent = view.empty;
    emptyHint.textContent = view.hint;

    grid.replaceChildren(...list.map(card));
    grid.hidden = list.length === 0;
    empty.hidden = list.length > 0;
    hiddenList.hidden = true;
    if (view.id === 'hidden') renderHidden();
    menuAdmin.hidden = view.id !== 'menu';
    if (view.id === 'menu') renderMenu();
    branchAdmin.hidden = view.id !== 'branches';
    if (view.id === 'branches') renderBranches();
    if (acct) {
      const open = view.id === 'accounts';
      acct.wrap.hidden = !open;
      if (open) empty.hidden = true;
      // Don't leave a customer's details on screen after moving on.
      else { acct.input.value = ''; acct.result.replaceChildren(); }
    }
    paintVisibility();
    reveal([...grid.children]);
  }

  if (manager) {
    acct = accountPanel();
    hiddenList.after(acct.wrap);
  }

  window.addEventListener('hashchange', show);
  window.addEventListener('unli-data-changed', () => { fillBranchPick(); updateCounts(); show(); });
  fillBranchPick();
  updateCounts();
  show();

  // ─── NEW HOLD / RESERVE (docs/plan.md §7.3C) ──────────────────────────────────
  const onSaved = () => { updateCounts(); show(); };
  document.getElementById('newHold').addEventListener('click', () => Unli.openBooking('hold', { onSaved, branch: pick }));
  document.getElementById('newReserve').addEventListener('click', () => Unli.openBooking('reserve', { onSaved, branch: pick }));

  // ─── MOTION (docs/plan.md §7.4) ───────────────────────────────────────────────
  if (window.gsap) {
    if (window.ScrollTrigger) gsap.registerPlugin(ScrollTrigger);
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      motion = true;
      gsap.from('.dash-head > *', { opacity: 0, y: 24, duration: 0.7, ease: 'power3.out', stagger: 0.1 });
      reveal([...grid.children]);
      return () => { motion = false; };
    });
    mm.add('(prefers-reduced-motion: reduce)', () => {
      gsap.set('.dash-head > *, .tkt', { opacity: 1, y: 0 });
    });
  }
})();
