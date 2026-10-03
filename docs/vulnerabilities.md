# Vulnerability Findings — Unli Chix

Authorized audit of the live site + `project-ni-mark` Firestore (October 2026).
One vulnerability was **proven against production** with a repeatable PoC
(`scripts/security/audit-forge-poc.mjs`); the rest are code/rules findings.

| # | Finding | Severity | Status |
|---|---|---|---|
| V1 | Audit-log forgery + unlimited writes | **Medium** | ✅ proven live |
| V2 | Unlimited ticket creation (staff-board flooding) | Medium | static (rules) |
| V3 | Ticket display-field spoofing on holds | Low | static (rules) |
| V4 | No SRI on CDN scripts, no CSP header, no App Check | Low | static |

---

## V1 — Audit-log forgery (proven live)

**Where:** `firestore.rules` → `match /auditLogs/{logId}` (deployed), reached
from any page after sign-in (`store.log()` in `public/js/app.js`).

**The rule checks who wrote an entry, but never what they may claim:**

```
allow create: if signedIn()
  && … actor == request.auth.token.email      // identity: bound
  && … role  == me().role                     // role: bound
  && … action in ['Placed hold', …, 'Removed dish', 'Added branch', …]
  && … target is string && target.size() <= 120;
  // ← no check that the caller may PERFORM the action,
  // ← no rate cap at all
```

**Impact**

1. **Forgery:** any signed-in customer can append entries claiming
   manager-level actions (`Removed dish`, `Hid from menu`, `Added branch`, …).
   `public/js/app.js` states audit entries "can't be forged" — false at the
   action/target level. The manager's audit view shows history that never
   happened.
2. **Unlimited writes:** this is the only write path with no other condition —
   a script can commit entries as fast as the quota allows, flooding the log
   and burning Firestore write quota (bill abuse). No App Check limits it.

**Live evidence (production, 2026-10-03)**

```
1. create throwaway account (signUp)        → uid = rwW22Ln1Z7YIN8Wor44RwwNW67X2
2. create normal profile role=customer      → allowed (as expected)
3. read the audit log as a customer         → denied (permission-denied) — as expected
4. FORGE audit entry action="Removed dish"  → ALLOWED — write committed  ← VULNERABILITY
throwaway account deleted.
```

Evidence doc: `auditLogs/WBX4TxSbbJ337aFLWXCZ`
(forge via the real SDK with `serverTimestamp()` — a raw REST call fails only
because the rule requires `createdAt == request.time`, which the SDK sentinel
satisfies exactly.)

**Also verified blocked (live):** self-promotion to `manager` at profile
create → 403; `role` patch on an existing profile → 403.

**Fix — bind the action to the caller's role (firestore.rules):**

```
allow create: if signedIn()
  && request.resource.data.keys().hasOnly(['actor', 'role', 'action', 'target', 'createdAt'])
  && request.resource.data.actor == request.auth.token.email
  && request.resource.data.role == me().role
  && request.resource.data.createdAt == request.time
  && request.resource.data.target is string && request.resource.data.target.size() <= 120
  && (
    (request.resource.data.action in ['Placed hold', 'Created reserve', 'Booked table',
                                      'Cancelled reserve', 'Viewed account'])
    || (isStaff() && request.resource.data.action in ['Hid from menu', 'Returned to menu',
                                      'Added dish', 'Edited dish', 'Removed dish'])
    || (isManager() && request.resource.data.action in ['Added branch', 'Edited branch'])
  );
```

Rules cannot rate-limit; pair it with **App Check** (attest the web app) and
budget alerts so the unlimited-writes path stops being free.

**Cleanup after the PoC (Firebase console → Firestore):**

- delete `auditLogs/WBX4TxSbbJ337aFLWXCZ` (the forged entry)
- delete `users/rwW22Ln1Z7YIN8Wor44RwwNW67X2` (orphan profile of the deleted
  throwaway account)

---

## V2 — Unlimited ticket creation (staff-board flooding)

**Where:** `firestore.rules` → `match /tickets/{ticketId}` create.

Shape checks exist, but nothing counts how many tickets a user already has. A
signed-in customer can create unlimited holds/reserves; `delete: if false`
means staff can never remove them — only change status. Effect: the kitchen
board (and customers' "My plans") can be flooded with junk tickets that are
permanent, plus ongoing write costs.

**Fix:** App Check + a Cloud Function or scheduled job that cancels junk
reserves, or cap per-user tickets with a count check (`getAfter`/subcollection
counters). Minimum: monitor `tickets` create rate.

---

## V3 — Ticket display-field spoofing (holds)

**Where:** `firestore.rules` → tickets create, `type == 'hold'` branch.

- Top-level `hasOnly` restricts which keys exist, not their **values**: `no`,
  `where`, `time`, `party` are untyped for holds — a direct API caller can
  choose a `no` that collides with a real ticket number or put fake markers
  (`"PAID"`) in `where`/`time`, which the staff board displays.
- The `customer` map is only key-checked for reserves (`customerTable()`), not
  holds — extra keys slip through.
- `get('date', …)` / `get('slot', …)` defaults let a hold omit date/slot.

No XSS (every renderer uses `textContent`), but staff can be spoofed.

**Fix:** in the hold branch require
`d.customer.keys().hasOnly(['name','email'])`, `d.no is string`,
`d.where is string && d.where.size() <= 40`, `d.time is string && d.time.size() <= 40`,
`d.date is string && d.slot is string`, `d.party is int`.

---

## V4 — Hardening gaps

- **No SRI:** `dashboard.html` loads GSAP from cdnjs without `integrity=`
  (supply-chain → staff-session XSS). Self-host or add hashes.
- **No CSP:** `firebase.json` sets nosniff / X-Frame-Options / Referrer-Policy
  but no `Content-Security-Policy` — any future XSS is unmitigated.
- **No App Check:** the public web API key authorizes raw REST from anywhere
  (quota theft, the V1/V2 abuse paths). Enable App Check for the web app.
- Open sign-up + no per-IP limits beyond Firebase defaults (informational).

---

## Verified NOT vulnerable (with evidence)

| Check | Result |
|---|---|
| Deployed rules = repo file | ✅ anonymous REST probes: `tickets`/`users`/`auditLogs` → 403; `menuItems`/`branches` public by design |
| Role escalation | ✅ blocked live: create-as-manager 403, update-role 403 |
| IDOR on `ticket.html?id=` | ✅ rules deny non-owners (reads as "not found"); covered by `scripts/rules.test.mjs` |
| DOM XSS | ✅ all renderers use `textContent`; only 2 `innerHTML` uses, both static SVG |
| Open redirect `?next=` | ✅ origin + site-root validated in `session.js` |
| SQL / NoSQL injection | ✅ no SQL anywhere; JSON fields type-checked (see `docs/attacks.md`) |
| Brute force | ✅ Firebase throttling + generic error messages (see `docs/attacks.md`) |
| Image URL scheme | ✅ rules force `^https://` (no `javascript:`) |
