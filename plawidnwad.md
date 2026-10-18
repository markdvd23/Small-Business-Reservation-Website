# Website Security & Resilience Assessment System — Master Development Plan
**Application:** *Unli Chix* Restaurant Reservation & Management Platform  
**Target Environment:** Local Firebase Emulator (`127.0.0.1:5000` / `127.0.0.1:8080`) & Authorized Staging  
**Objective:** Add educational, authorized security and resilience assessment capabilities directly tied to the website's real features without disrupting existing functionality.

---

## 1. Executive Overview & Safety Principles

This plan establishes a defensive security evaluation and resilience assessment suite tailored to the **Unli Chix** Firebase application. Every assessment module is directly linked to the application's actual data models, Cloud Functions, and Firestore security rules.

### Strict Safety & Compliance Framework
1. **Target Allowlisting:** All testing tools are hard-locked to authorized local loopback addresses (`localhost`, `127.0.0.1`) and explicit staging domains (`demo-unli.web.app`). External target URLs are rejected before network requests are dispatched.
2. **Controlled Load Ceilings:** Resilience testing is strictly bounded (maximum 50 concurrent simulated users and 500 total requests with pacing intervals) to evaluate rate-limiting and service capacity safely.
3. **Non-Destructive Validation:** Parameter validation tests inspect server-side rejection behaviors (`HttpsError: invalid-argument`, `permission-denied`) using non-destructive inputs and perform automatic cleanup of any test artifacts.
4. **Emergency Stop (Circuit Breaker):** All automated runs bind to an `AbortController` linked to an immediate-stop interface button and automatic timeout thresholds.

---

## 2. Phase 1 — Website Analysis & Surface Mapping

An analysis of the Unli Chix codebase identifies the following core pages, Cloud Functions, and database boundaries:

### Core Touchpoints & Validation Boundaries

| Category | Component / File | Sensitive Parameters & Fields | Business Logic Verification Focus |
| :--- | :--- | :--- | :--- |
| **Callable Cloud Function** | `functions/index.js` (`createReservation`) | `party`, `branch`, `date`, `slot`, `name` | Capacity calculations, negative/zero party sizes, booking window verification |
| **Callable Cloud Function** | `functions/index.js` (`rescheduleReservation`) | `ticketId`, `date`, `slot` | Ownership checks (preventing modification of other users' tickets) |
| **Callable Cloud Function** | `functions/index.js` (`joinWaitlist`) | `party`, `branch`, `date`, `slot` | Waitlist quotas (max 3 active per user) and input sanitization |
| **Firestore Security Rules** | `firestore.rules` (`/users/{uid}`) | `role` (`customer`, `staff`, `manager`), `email` | Prevention of privilege escalation from customer to staff/manager |
| **Firestore Security Rules** | `firestore.rules` (`/tickets/{ticketId}`) | `status`, `ownerUid`, `customer.email` | Unauthorized status alterations and cross-account data isolation |
| **Firestore Security Rules** | `firestore.rules` (`/menuItems/{itemId}`) | `limited`, `hidden`, `sort`, `name` | Role-based catalog management (staff vs manager permissions) |
| **Authentication Flow** | `public/login.html`, `public/js/session.js` | Email verification, ID tokens | Session integrity and login flow resilience |

---

## 3. Phase 2 — Function Planning

### Module A: Parameter Tampering & Business Logic Integrity

This module verifies that client-side constraints cannot be bypassed by submitting modified payloads directly to Cloud Functions or Firestore.

#### 1. Party Size Boundary Validator (`testPartySizeBoundaryValidator`)
- **Purpose:** Confirms that the reservation backend rejects non-integer, zero, negative, and oversized party values (`party < 1` or `party > 20`).
- **Target Endpoint:** `createReservation` Cloud Function.
- **Input Payloads:** `party: 0`, `party: -4`, `party: 25`, `party: 9999`, `party: "four"`, `party: 3.5`.
- **Expected Outcome:** Server rejects each invalid payload with `HttpsError('invalid-argument')`. Test passes when rejection is confirmed.
- **Restrictions:** Ephemeral test session; cleans up test documents upon completion.

#### 2. Role Escalation Validator (`testRoleEscalationValidator`)
- **Purpose:** Verifies that authenticated customers cannot escalate their role to `staff` or `manager` via direct Firestore updates.
- **Target Document:** `/users/{uid}` in Firestore.
- **Input Payloads:** Update operation `{ role: 'manager' }` and `{ role: 'staff' }` on the current user's profile.
- **Expected Outcome:** Firestore rejects the write with `PERMISSION_DENIED` under `firestore.rules`.

#### 3. Ticket ID Authorization & IDOR Validator (`testTicketAuthorizationValidator`)
- **Purpose:** Verifies that User A cannot read, reschedule, or cancel a reservation ticket belonging to User B.
- **Target Touchpoint:** `tickets/{ticketId}` and `rescheduleReservation`.
- **Input Payloads:** User A calls `rescheduleReservation` using User B's `ticketId`.
- **Expected Outcome:** Server rejects with `HttpsError('permission-denied')` or Firestore `PERMISSION_DENIED`.

#### 4. Operating Hours & Schedule Tampering Validator (`testOperatingHoursValidator`)
- **Purpose:** Checks whether a booking can be forced outside branch operational hours (e.g., booking at 03:00 AM or after `lastSeating`).
- **Target Touchpoint:** Branch validation inside `createReservation`.
- **Input Payloads:** Valid future date with `slot: "03:30"` or `slot: "23:59"`.
- **Expected Outcome:** Rejection with `HttpsError('failed-precondition', 'Time is outside branch hours.')`.

#### 5. Reservation Quota Enforcement Validator (`testReservationQuotaValidator`)
- **Purpose:** Confirms enforcement of the business rule limiting active reservations to 5 per user account.
- **Target Touchpoint:** `createReservation` quota check.
- **Input Payloads:** Sequential test bookings attempting a 6th active reservation.
- **Expected Outcome:** Rejection of the 6th booking with `HttpsError('resource-exhausted')`.

---

### Module B: Traffic Resilience & Rate-Limiting Assessment

This module measures application behavior, capacity limits, and defensive back-off mechanisms under controlled concurrency.

#### 1. Controlled Concurrency Simulator (`runControlledLoadSimulation`)
- **Purpose:** Simulates bounded, synthetic booking inquiries and read operations against the local emulator or staging branch.
- **Configurable Parameters:**
  - Concurrency: 5 to 50 simulated users (slider-controlled).
  - Total requests: 50 to 500 requests maximum.
  - Ramp-up duration: 1 to 10 seconds.
  - Target routes: `/branches`, `/menu`, or `createReservation` (dry-run mode).
- **Telemetry Captured:** Latency percentiles (p50, p95, p99), HTTP status distribution (200, 429, 500, 503), requests per second (RPS), error rate percentage.

#### 2. Rate-Limiting & Backoff Validator (`testRateLimitAndThrottleValidator`)
- **Purpose:** Evaluates whether repeated rapid requests trigger defensive rate-limiting or backoff headers.
- **Target Feature:** Callable functions and authentication entry points.
- **Expected Outcome:** Verification of whether threshold limits correctly dampen burst traffic.

#### 3. Real-Time Resource Health Monitor (`monitorResourceHealthMetrics`)
- **Purpose:** Live capture of client-side latency, network failures, and emulator response times during test runs.
- **Visuals:** Live sparkline chart showing latency variations and request throughput.

#### 4. Emergency Stop Mechanism (`executeEmergencyStop`)
- **Purpose:** Immediate circuit breaker that aborts all ongoing fetch requests, clears queues, and restores normal UI state instantly.

---

### Module C: TAS Assessment (Reserved Specification)

*This module is reserved until the exact definition and requirements for TAS are specified (e.g., Threat Analysis System, Traffic Anomaly Screening, Token/Authentication Security, or Transaction Auditing Suite).*

- **Architecture:** Pluggable interface `ITasSecurityAssessmentModule` ready for integration once specifications are provided.
- **Initial Status:** Marked as `"Pending Specification — Safe Interface Reserved"`.

---

## 4. Phase 3 — System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        UNLI CHIX SECURITY DASHBOARD                     │
│                 (/public/dashboard-security.html)                       │
├────────────────────────────────────────────────────────────────────────┤
│  [Allowlist Guard: Local & Staging Only]        [EMERGENCY STOP]       │
├──────────────────────────┬─────────────────────────────────────────────┤
│  Test Configuration      │  Live Telemetry & Results Console           │
│  - Parameter Validation  │  - Real-time RPS & Latency Gauge            │
│  - Resilience Simulator  │  - Pass/Fail Status & Rejection Evidence    │
│  - TAS (Reserved)        │  - Severity: Low / Medium / High            │
└──────────────────────────┴─────────────────────────────────────────────┘
                                   │
                 ┌─────────────────┴─────────────────┐
                 ▼                                   ▼
   [Client Assessment Engine]             [Safety Enforcement Guard]
   - Bounded request generator            - Domain allowlist verification
   - Payload mutation checks              - Role check (Manager only)
   - AbortController lifecycle            - Auto-cleanup of test records
```

### Safety Controls
- **Domain Restriction Guard:** Rejects execution if current domain is not `localhost`, `127.0.0.1`, or `demo-unli.web.app`.
- **Role Verification:** Accessible only to users authenticated with the `manager` role.
- **Test Artifact Cleanup:** Every created document carries a `testRunId` and is deleted or reverted upon test completion.

---

## 5. Phase 4 — UI/UX Design Specifications

The interface matches Unli Chix's visual identity:

### Design Tokens & Palette
- **Background:** `#110d0b` (Deep Charcoal), `#1c1512` (Card Brown), `#251c18` (Surface Accent)
- **Brand Accents:** `#f97316` (Flame Orange), `#ea580c` (Spicy Amber), `#fbbf24` (Crispy Gold)
- **Status Indicators:**
  - **Passed / Protected:** `#22c55e` (Emerald Green)
  - **Low Attention:** `#3b82f6` (Cyan Blue)
  - **Medium Concern:** `#eab308` (Amber)
  - **High Risk / Unprotected:** `#ef4444` (Coral Red)

### Dashboard Components
1. **Control Header:** Target environment indicator (`LOCAL EMULATOR` badge), safety status, and distinct Emergency Stop button.
2. **Assessment Tabs:**
   - Parameter Integrity Tab (interactive cards for Party Size, Role Escalation, IDOR, Hours).
   - Traffic Resilience Tab (slider controls for concurrency, total count, live metrics chart).
   - TAS Assessment Tab (placeholder card with status indicator).
   - Audit History Tab (view past test runs, download reports).
3. **Live Output Console:** Stream of test steps, status codes, and server rejection responses.

---

## 6. Phase 5 — Implementation Roadmap

### Stage 1: Safety Scaffolding & Configuration
- **Deliverables:** Domain allowlist validator, manager role guard, test configuration helpers.
- **Files to Create:** `public/js/security/safety-guard.js`, `public/js/security/config.js`.
- **Verification:** Confirm non-local domains and unauthenticated users are blocked.

### Stage 2: Parameter Validation Engine
- **Deliverables:** Test suite for boundary checks, role escalation, IDOR, and business hour validation.
- **Files to Create:** `public/js/security/tampering-tests.js`.
- **Verification:** Run all validation tests against local emulator and confirm expected error rejections.

### Stage 3: Controlled Resilience Simulator
- **Deliverables:** Bounded concurrency generator (max 50 users, 500 requests), latency recorder, emergency stop button.
- **Files to Create:** `public/js/security/resilience-tests.js`.
- **Verification:** Validate that emergency stop terminates in-flight requests immediately.

### Stage 4: TAS Module Integration
- **Deliverables:** Implement test cases once user clarifies TAS requirements.
- **Files to Create:** `public/js/security/tas-tests.js`.

### Stage 5: Security Dashboard UI
- **Deliverables:** Dedicated dashboard view matching Unli Chix styling.
- **Files to Create:** `public/dashboard-security.html`, `public/css/security.css`, `public/js/security/dashboard-ui.js`.
- **Files to Modify:** Add manager-only entry button in `public/dashboard.html`.

### Stage 6: Report Generation & Audit Export
- **Deliverables:** Export test outcomes as structured JSON and Markdown summary reports with remediation notes.
- **Files to Create:** `public/js/security/report-generator.js`.

---

## 7. Current Status — Implemented

> [!NOTE]
> All six stages are built and wired into the real Unli Chix app. The suite is
> manager-only, host-allowlisted (loopback + `demo-unli.web.app`), non-destructive,
> and abortable. The Firebase-independent logic (allowlist guard, circuit breaker,
> request deadlines/abort, report generation) is covered by a passing Node harness
> (26/26 assertions). A live emulator run needs the Firebase CLI + Java, which were
> not available in the build environment.

### Delivered files
| Stage | File | Role |
| :--- | :--- | :--- |
| 1 | `public/js/security/config.js` | Allowlist, load ceilings, expected-rejection codes, run-id/emulator helpers |
| 1 | `public/js/security/safety-guard.js` | Target allowlist, manager gate, `createRunGuard` circuit breaker, `withDeadline` |
| 2 | `public/js/security/tampering-tests.js` | Module A: party size, role escalation, IDOR, operating hours, quota (auto-revert) |
| 3 | `public/js/security/resilience-tests.js` | Module B: bounded load generator, rate-limit burst, emergency stop |
| 4 | `public/js/security/tas-tests.js` | Module C: reserved `ITasSecurityAssessmentModule` + "Pending Specification" stub |
| 5 | `public/dashboard-security.html` · `public/css/security.css` · `public/js/security/dashboard-ui.js` | Dashboard shell, styling, orchestration |
| 5 | `public/dashboard.html` · `public/js/dashboard.js` (modified) | Manager-only "Security" nav entry |
| 6 | `public/js/security/report-generator.js` | JSON + Markdown reports with remediation notes |

### Deviations from the plan (and why)
1. **Palette:** the real Unli Chix identity in `styles.css` is a bright cream/ink/mango/chili "kitchen-ticket" theme, not the dark charcoal the plan guessed. The dashboard matches the actual site, reusing its CSS tokens, which is what §5 "matches Unli Chix's visual identity" asks for. Status colours (pass/low/medium/high) are layered on top.
2. **Non-destructive by construction:** the party/role/IDOR/hours tests send payloads the server rejects, so nothing is written. The quota test is the only one that must create data, so it is **emulator-only** and cancels (reverts) every reservation it creates.
3. **`createReservation` load target** runs in **dry-run** (a deliberately invalid payload rejected at validation) so load testing never writes reservations.

### How to run
1. `firebase emulators:start` (Auth 9099 · Firestore 8080 · Functions 5001 · Hosting 5000).
2. Open `http://127.0.0.1:5000/dashboard.html?emulator` and sign in as a **manager**.
3. Click **Security** in the nav → runs are bounded, logged, and stoppable via **Emergency Stop**.
