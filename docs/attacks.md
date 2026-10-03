# Security Lab — Brute Force & SQL Injection

Two attacks built and executed against this project (authorized, limited runs —
October 2026). Tools live in `scripts/security/` and are **never deployed**
(Firebase Hosting only serves `public/`).

| Tool | What it does |
|---|---|
| `scripts/security/brute-force.mjs` | Wordlist attack against the real sign-in behind `login.html` (Firebase Identity Toolkit `accounts:signInWithPassword`). Capped: default 10 attempts, hard max 25, 1500 ms delay, stops on success or lockout. |
| `scripts/security/sqli.mjs` | SQL injection payloads against the same endpoint (default), or any SQL-backed URL later (`--url --param`). Detects SQL error signatures, auth bypass, and time delays. |
| `scripts/security/wordlist.txt` | 10-candidate demo wordlist, one password per line. |

---

## 1. Which webpages are applicable

| Webpage | Brute force | SQL injection | Why |
|---|---|---|---|
| `public/login.html` | **Yes — primary** | No | The only page that takes a password. It posts email + password to Firebase Auth. |
| The Firebase Auth endpoint behind it | **Yes — the actual network target** | Tested: **not applicable** | JSON API, no SQL engine (see §3). |
| `public/dashboard.html` | Indirect | No | `data-protected`: a cracked login is the key to the staff board. |
| `public/accounts/user/` (index, book, ticket, mine) | Indirect | No | Protected customer data — what a stolen session exposes. |
| `public/accounts/guest/`, `index.html`, `menu.html`, `branches.html` | No | No | Static content, no credentials, no server-side input. URL params (e.g. `ticket.html?id=…`) are read client-side only. |
| Firestore queries (menu, branches, tickets) | No | No | Firestore is **NoSQL**; the SDK sends structured queries, never SQL strings. |

**Summary:** brute force applies to `login.html` (and everything it guards).
SQL injection applies to **no page** — this stack has no SQL database.

---

## 2. Attack 1 — Brute force (step by step)

**Target:** `login.html` → `signInWithEmailAndPassword()` → Identity Toolkit
`accounts:signInWithPassword` (the web API key in `public/js/firebase.js` is a
public project identifier, not a secret).

1. **Find the entry point.** One form, one endpoint: sign-in on `login.html`.
2. **Build a wordlist.** `scripts/security/wordlist.txt`, one candidate per line.
3. **Run, capped.** A limited run: max 10 attempts, 1500 ms apart, stop on
   success or Firebase throttling.

```sh
# Step 0 — create a throwaway lab account through the site's own sign-up endpoint
curl -s -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<WEB_API_KEY>" \
  -H 'Content-Type: application/json' \
  -d '{"email":"bf-lab-you@example.com","password":"unlilab123","returnSecureToken":true}'

# Step 1 — the attack (limited run)
node scripts/security/brute-force.mjs --email bf-lab-you@example.com --max 10 --delay 1500
```

**Live result (limited run, 5 of 10 attempts used):**

```
  # 1  123456           → fail       INVALID_LOGIN_CREDENTIALS  (231 ms)
  # 2  password         → fail       INVALID_LOGIN_CREDENTIALS  (88 ms)
  # 3  qwerty123        → fail       INVALID_LOGIN_CREDENTIALS  (150 ms)
  # 4  iloveyou         → fail       INVALID_LOGIN_CREDENTIALS  (103 ms)
  # 5  unlilab123       → CRACKED    OK  (150 ms)

── Result ─────────────────────────────────────────────────
VULNERABLE — password recovered after 5 attempt(s): "unlilab123"
```

**What this shows**

- A weak password falls in **five tries**; a real attacker's wordlist has
  millions of candidates and no 10-attempt politeness cap.
- Every miss returns the same `INVALID_LOGIN_CREDENTIALS`, so the form can't be
  used to discover which emails have accounts (email-enumeration protection).
- The site already maps `auth/too-many-requests` to "Too many attempts. Wait a
  few minutes." — Firebase throttles sustained attacks, which is why a limited
  run is also the only kind a real attacker gets.

**Mitigations**

- Strong, unique passwords (the lab password `unlilab123` style is the risk).
- Keep Firebase's built-in rate limiting / lockout; the login page already
  handles it gracefully.
- For staff/manager accounts: require a second factor and review Google Cloud
  monitoring for repeated `INVALID_LOGIN_CREDENTIALS` bursts.
- Delete demo/lab accounts when a test is finished (this lab's account was
  removed after the run).

---

## 3. Attack 2 — SQL injection (step by step)

**Finding first: Firebase is not SQL.** The stack is static hosting + Firebase
Auth + Firestore (NoSQL). There is no SQL database, driver, or string-built
query anywhere in the repo — so SQLi has no page to live on. The attack below
is still executed against the only server-side input (the auth endpoint) to
*prove* the payloads get nowhere.

1. **Recon.** `grep` for SQL drivers/queries: none. Data access goes through
   the Firestore SDK (`public/js/app.js`) and Firebase Auth (`login.html`).
2. **Choose the injection point.** `accounts:signInWithPassword` (email +
   password fields) — the only place user input reaches a server.
3. **Fire classic payloads** (tautology, UNION, DROP TABLE, time-based SLEEP)
   plus two NoSQL type-confusion payloads (`{"$ne": null}`).
4. **Inspect responses** for SQL error signatures, a session token without
   valid credentials, or a delayed response.

```sh
node scripts/security/sqli.mjs                      # Firebase target (default)
node scripts/security/sqli.mjs --url https://example.com/login --param email   # future SQL target
```

**Live result (13 payloads, limited run):**

```
  baseline                 → INVALID_LOGIN_CREDENTIALS    151 ms  (benign wrong password)

  Tautology                → INVALID_EMAIL                   56 ms
  Tautology + comment      → INVALID_EMAIL                   69 ms
  OR 1=1 (hash)            → INVALID_EMAIL                   64 ms
  Credential bypass        → INVALID_EMAIL                   55 ms
  UNION NULL probe         → INVALID_EMAIL                   65 ms
  UNION dump               → INVALID_EMAIL                   75 ms
  DROP TABLE (inert)       → INVALID_EMAIL                   67 ms
  False condition          → INVALID_EMAIL                   60 ms
  Quote break              → INVALID_EMAIL                   66 ms
  Error-based extract      → INVALID_EMAIL                   54 ms
  Time-based SLEEP         → INVALID_EMAIL                   65 ms
  NoSQL $ne (email)        → Invalid value (email), Starting an object on a scalar field
  NoSQL $ne (password)     → Invalid value (password), Starting an object on a scalar field

── Verdict ─────────────────────────────────────────────────
NOT VULNERABLE — no SQL error signature, no auth bypass, no time delay.
```

**What this shows**

- SQL strings (`' OR '1'='1`, `UNION SELECT`, `DROP TABLE`) are validated as
  *literal email strings* → `INVALID_EMAIL`. No SQL engine ever sees them.
- The SLEEP payload returned in 65 ms — no query was executed to be delayed.
- The NoSQL payloads are rejected by type validation ("Starting an object on a
  scalar field"), so the analogous NoSQL injection fails too.
- Firestore reads are protected by `firestore.rules` regardless of input shape
  (covered by `scripts/rules.test.mjs`).

**Mitigations (for today and if SQL is ever added)**

- Nothing to fix for SQLi on this stack — record it as *not applicable*, with
  the evidence above.
- If a SQL backend is introduced later: parameterized queries / ORM only,
  least-privilege DB accounts, input validation, and re-run
  `node scripts/security/sqli.mjs --url … --param …`.
- Keep relying on API type validation + `firestore.rules` for the NoSQL side.

---

## 4. Re-running the lab

```sh
node scripts/security/brute-force.mjs --email <account-you-own> --max 10 --delay 1500
node scripts/security/sqli.mjs
```

Use only accounts you own. The brute-force tool refuses to run without an
explicit `--email` and hard-caps attempts at 25.

**Cleanup:** delete the lab account in Firebase console → Authentication, or
sign in as it and call `accounts:delete` with that session's `idToken` (the
account created for the live run above was deleted immediately afterwards).
