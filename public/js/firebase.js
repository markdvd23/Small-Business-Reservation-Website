/* ─── UNLI CHIX — FIREBASE ─────────────────────────────────────────────────
 * App init, Auth, Firestore, Analytics, and the bridge that tells session.js
 * who is signed in and with which role.
 *
 * The web API key below is a public project identifier, not a secret. What
 * enforces roles is firestore.rules: a user's role lives in users/{uid}, and
 * only an admin can set it to staff or manager (docs/plan.md §4.5).
 *
 * Load after session.js:  <script type="module" src="js/firebase.js"></script>
 * ───────────────────────────────────────────────────────────────────────── */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAnalytics, isSupported } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-analytics.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail, sendEmailVerification,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDKpkhvVXK6zueNPAdcGPnsH_Lk7f3M-sM',
  authDomain: 'project-ni-mark.firebaseapp.com',
  projectId: 'project-ni-mark',
  storageBucket: 'project-ni-mark.firebasestorage.app',
  messagingSenderId: '689981790931',
  appId: '1:689981790931:web:05d1b083798b6b23b15226',
  measurementId: 'G-DQNS117Z9D',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, 'us-central1');

// Add <meta name="firebase-app-check-site-key" content="..."> to pages after
// creating a reCAPTCHA Enterprise key. Functions can then enforce App Check.
const appCheckKey = document.querySelector('meta[name="firebase-app-check-site-key"]')?.content;
if (appCheckKey) initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckKey), isTokenAutoRefreshEnabled: true });

// Local testing only: open any page on localhost with ?emulator to use the
// Auth + Firestore emulators (firebase emulators:start) for this tab.
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  try { if (new URLSearchParams(location.search).has('emulator')) sessionStorage.setItem('unli-emulator', '1'); } catch { /* storage blocked */ }
  let on = false;
  try { on = sessionStorage.getItem('unli-emulator') === '1'; } catch { /* storage blocked */ }
  if (on) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
}
export { doc, getDoc, setDoc, serverTimestamp };
export async function createReservation(data) {
  return (await httpsCallable(functions, 'createReservation')(data)).data;
}

export async function joinWaitlist(data) {
  return (await httpsCallable(functions, 'joinWaitlist')(data)).data;
}

export async function rescheduleReservation(data) {
  return (await httpsCallable(functions, 'rescheduleReservation')(data)).data;
}

export async function exportMyData() {
  return (await httpsCallable(functions, 'exportMyData')()).data;
}

export async function deleteMyAccount() {
  return (await httpsCallable(functions, 'deleteMyAccount')({ confirmation: 'DELETE' })).data;
}
isSupported().then(ok => { if (ok) getAnalytics(app); }).catch(() => { /* analytics is optional */ });

const ROLES = ['customer', 'staff', 'manager'];

// ─── ROLE LOOKUP ───────────────────────────────────────────────────────────
// The role always comes from users/{uid}, never from anything the browser sends.
async function roleOf(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const role = snap.data().role;
    return ROLES.includes(role) ? role : 'customer';
  }
  // First sign-in: the rules only let a user create their own profile as a customer.
  await setDoc(ref, { role: 'customer', email: user.email, createdAt: serverTimestamp() });
  return 'customer';
}

// ─── SIGN IN / UP / OUT ────────────────────────────────────────────────────
let busy = false; // an explicit sign-in/out is in progress; the listener stands down

// A sign-in only counts once the role is confirmed. If the profile can't be
// read, sign back out rather than leave a half-signed-in user.
async function finish(user) {
  try {
    UnliSession.signIn(await roleOf(user), user.email);
  } catch (e) {
    console.warn('Could not load profile:', e.code || e);
    UnliSession.signOut();
    await signOut(auth).catch(() => {});
    const err = new Error('Profile unavailable');
    err.code = 'unli/profile-unavailable';
    throw err;
  }
}

export async function signIn(email, password) {
  busy = true;
  try { await finish((await signInWithEmailAndPassword(auth, email, password)).user); }
  finally { busy = false; }
}

export async function signUp(email, password) {
  busy = true;
  try {
    const user = (await createUserWithEmailAndPassword(auth, email, password)).user;
    await sendEmailVerification(user).catch(e => console.warn('Could not send verification email:', e.code || e));
    await finish(user);
  }
  finally { busy = false; }
}

export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

export function resendVerification() {
  if (!auth.currentUser) throw new Error('No signed-in user');
  return sendEmailVerification(auth.currentUser);
}

export async function logOut() {
  busy = true;
  UnliSession.signOut();
  await signOut(auth);
}

// Every "Log out" link on every page (session.js adds some at runtime).
document.addEventListener('click', e => {
  const link = e.target.closest('[data-logout]');
  if (!link) return;
  e.preventDefault();
  logOut().finally(() => location.assign(link.href));
}, true);

// ─── TELL THE PAGE WHO THIS IS ─────────────────────────────────────────────
// session.js starts every page with no role; pages wait for 'unli-auth-ready'.
// Pages marked <body data-protected> send anyone without a confirmed role to sign in.
const protectedPage = document.body.hasAttribute('data-protected');

onAuthStateChanged(auth, async user => {
  if (busy) return;
  if (user) {
    try {
      UnliSession.signIn(await roleOf(user), user.email);
      return;
    } catch (e) {
      // Fail closed: a role we can't confirm is no role (docs/plan.md §4.5).
      console.warn('Could not confirm role:', e.code || e);
    }
  }
  UnliSession.signOut();
  if (protectedPage) location.replace(UnliSession.root + 'login.html?next=' + encodeURIComponent(location.pathname + location.search));
});
