/* Signed-in user's role and email, held in memory for this page only.
 * firebase.js fills it from Firestore once Firebase Auth reports the user, then
 * fires 'unli-auth-ready'. Nothing is cached in the browser, so there's no stale
 * or edited role to trust. Not access control — firestore.rules is (docs/plan.md §4.5). */
(function () {
  'use strict';

  // Site root: this file lives at <root>/js/session.js.
  const root = document.currentScript.src.replace(/js\/session\.js(\?.*)?$/, '');
  let currentRole = null;
  let currentEmail = null;
  let settled = false; // Firebase has answered at least once on this page

  function role() { return currentRole; }
  function email() { return currentEmail; }
  function ready() { return settled; }

  function announce() {
    settled = true;
    document.documentElement.classList.add('unli-auth-ready');
    window.dispatchEvent(new CustomEvent('unli-auth-ready'));
  }
  function signIn(value, address) {
    currentRole = value;
    currentEmail = address ? String(address).trim().toLowerCase() : null;
    announce();
  }
  function signOut() {
    currentRole = null;
    currentEmail = null;
    announce();
  }

  // Resolves once Firebase has said who (if anyone) is signed in.
  function whenReady() {
    return settled ? Promise.resolve() : new Promise(r => window.addEventListener('unli-auth-ready', r, { once: true }));
  }

  function isStaff() { const r = role(); return r === 'staff' || r === 'manager'; }
  function home() { return root + (isStaff() ? 'dashboard.html' : 'accounts/user/index.html'); }

  // Where to go after signing in: the page in ?next=, if it's on this site;
  // otherwise home. Anything off-site (//evil.example, javascript:) is ignored.
  function after() {
    const next = new URLSearchParams(location.search).get('next');
    if (next) {
      try {
        const url = new URL(next, root);
        if (url.origin === location.origin && url.pathname.startsWith(new URL(root).pathname)) return url.pathname + url.search + url.hash;
      } catch { /* not a URL */ }
    }
    return home();
  }

  window.UnliSession = { role, email, ready, whenReady, signIn, signOut, isStaff, home, after, root };

  // Public-page nav: swap "Order now" for the account link once we know who this is.
  let navDone = false;
  function syncNav() {
    if (navDone || (role() !== 'customer' && !isStaff())) return;
    const cta = document.querySelector('.nav .nav-cta:not([data-logout])');
    if (!cta) return;
    navDone = true;

    cta.textContent = isStaff() ? 'Dashboard' : 'My account';
    cta.href = home();

    const logout = document.createElement('a');
    logout.href = root + 'login.html';
    logout.textContent = 'Log out';
    logout.dataset.logout = ''; // firebase.js signs out on click
    if (cta.parentElement.tagName === 'LI') {
      const li = document.createElement('li');
      li.append(logout);
      cta.parentElement.after(li);
    } else {
      cta.after(logout);
    }
  }

  window.addEventListener('unli-auth-ready', () => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncNav, { once: true });
    else syncNav();
  });

  // If Firebase never answers (offline, blocked CDN), still show the nav
  // links styles.css hides while it waits; they just stay the signed-out ones.
  setTimeout(() => document.documentElement.classList.add('unli-auth-ready'), 3000);

  // Small screens: a Menu button opens the nav links as a drop-down
  // (styles.css). Above 900px the links sit in the bar and the button is hidden.
  function navMenu() {
    const nav = document.querySelector('.nav');
    const menu = nav && nav.querySelector('.nav-links, .user-nav, .guest-nav, .account-nav');
    if (!menu || nav.querySelector('.nav-toggle')) return;
    menu.classList.add('nav-menu');
    menu.id = menu.id || 'navMenu';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'nav-toggle';
    toggle.setAttribute('aria-controls', menu.id);
    toggle.setAttribute('aria-expanded', 'false');
    const bars = document.createElement('span');
    bars.className = 'nav-toggle-bars';
    bars.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = 'Menu';
    toggle.append(bars, label);
    menu.before(toggle);

    function set(open) {
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      label.textContent = open ? 'Close' : 'Menu';
    }
    toggle.addEventListener('click', () => set(!nav.classList.contains('is-open')));
    // In-page links (#plans) don't load a new page, so close on any link.
    menu.addEventListener('click', e => { if (e.target.closest('a')) set(false); });
    document.addEventListener('click', e => { if (!nav.contains(e.target)) set(false); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) { set(false); toggle.focus(); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', navMenu, { once: true });
  else navMenu();
})();
