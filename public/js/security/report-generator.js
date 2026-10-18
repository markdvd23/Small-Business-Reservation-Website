/* ─── UNLI CHIX — SECURITY ASSESSMENT · REPORT GENERATOR ────────────────────
 * Turns a run's result objects into a structured JSON record and a readable
 * Markdown summary with remediation notes (plawidnwad.md §6 Stage 6).
 * Pure functions + browser download helpers — no network, no state.
 * ───────────────────────────────────────────────────────────────────────── */
import { SEVERITY } from './config.js';

// Short, test-specific remediation guidance keyed by result id. Shown only when
// a control FAILS; passing controls need no action.
const REMEDIATION = {
  'party-size': 'Keep the integer/range guard in createReservation (1–20) and never rely on client-side min/max. Reject non-integers with invalid-argument.',
  'role-escalation': 'firestore.rules must keep users/{uid} update limited to name/updatedAt and assert role/email are unchanged. Set staff/manager roles only via the admin console.',
  'idor': 'rescheduleReservation (and cancel) must verify resource.ownerUid === auth.uid before any write, independent of role. Mirror the ownership check in firestore.rules.',
  'operating-hours': 'Validate slot against the branch open..lastSeating window server-side in the transaction; do not trust the client-submitted slot.',
  'quota': 'Enforce the active-reservation ceiling inside the createReservation transaction (count status==reserved for the owner) so concurrent requests cannot exceed it.',
  'rate-limit': 'Enable App Check and hosting/CDN rate-limiting in production; callable functions alone do not throttle bursts.',
  'load-sim': 'Review latency percentiles and error rate against capacity; add caching for public reads (branches/menu) if p95 climbs under load.',
  'tas': 'Define the TAS scope to activate Module C.',
};

const SEV_RANK = { high: 4, medium: 3, low: 2, info: 1, pass: 0, skipped: 0 };

function overall(results) {
  let worst = SEVERITY.PASS, failed = 0, passed = 0, skipped = 0;
  for (const r of results) {
    if (r.passed === true) passed++;
    else if (r.passed === false) { failed++; if ((SEV_RANK[r.severity] || 0) > (SEV_RANK[worst] || 0)) worst = r.severity; }
    else skipped++;
  }
  return { worst: failed ? worst : SEVERITY.PASS, failed, passed, skipped, total: results.length };
}

export function buildReport({ results, environment }) {
  const generatedAt = new Date().toISOString();
  const summary = overall(results);
  return {
    report: 'Unli Chix — Website Security & Resilience Assessment',
    generatedAt,
    environment: environment || {},
    summary,
    results: results.map(r => ({
      id: r.id, module: r.module, title: r.title, passed: r.passed, severity: r.severity,
      summary: r.summary || '', endpoint: r.endpoint || null,
      steps: r.steps || [], evidence: r.evidence || {},
      metrics: r.latency ? { latency: r.latency, rps: r.rps, errorRate: r.errorRate, statusDist: r.statusDist } : undefined,
      remediation: r.passed === false ? (REMEDIATION[r.id] || 'Review the failing control and enforce it server-side.') : undefined,
      finishedAt: r.finishedAt || null,
    })),
  };
}

const verdict = (r) => r.passed === true ? '✅ PASS' : r.passed === false ? '❌ FAIL' : '➖ SKIPPED';

export function toMarkdown(report) {
  const L = [];
  L.push(`# ${report.report}`);
  L.push('');
  L.push(`**Generated:** ${report.generatedAt}  `);
  if (report.environment.host) L.push(`**Target:** ${report.environment.host} (${report.environment.kind || 'local'})  `);
  if (report.environment.email) L.push(`**Operator:** ${report.environment.email} (${report.environment.role || 'manager'})  `);
  L.push('');
  const s = report.summary;
  L.push(`**Result:** ${s.passed} passed · ${s.failed} failed · ${s.skipped} skipped — overall severity **${String(s.worst).toUpperCase()}**`);
  L.push('');
  L.push('| Test | Module | Verdict | Severity | Summary |');
  L.push('| :--- | :---: | :---: | :---: | :--- |');
  for (const r of report.results) {
    L.push(`| ${r.title} | ${r.module} | ${verdict(r)} | ${String(r.severity).toUpperCase()} | ${(r.summary || '').replace(/\|/g, '\\|')} |`);
  }
  L.push('');
  for (const r of report.results) {
    L.push(`## ${r.title} — ${verdict(r)}`);
    if (r.endpoint) L.push(`*Target:* \`${r.endpoint}\``);
    if (r.summary) L.push('', r.summary);
    if (r.steps && r.steps.length) {
      L.push('', '**Steps**');
      for (const st of r.steps) {
        const mark = st.status === 'ok' ? '✓' : st.status === 'fail' ? '✗' : st.status === 'warn' ? '!' : '·';
        L.push(`- ${mark} ${st.label}${st.detail ? ` — ${st.detail}` : ''}`);
      }
    }
    if (r.metrics && r.metrics.latency) {
      const m = r.metrics;
      L.push('', '**Metrics**', `- Latency p50/p95/p99: ${m.latency.p50} / ${m.latency.p95} / ${m.latency.p99} ms`, `- RPS: ${m.rps} · Error rate: ${m.errorRate}%`);
    }
    if (r.remediation) L.push('', `> **Remediation:** ${r.remediation}`);
    L.push('');
  }
  L.push('---');
  L.push('_Authorized, non-destructive assessment. Local emulator / staging only._');
  return L.join('\n');
}

export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(report) {
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  download(`unli-security-report-${stamp}.json`, JSON.stringify(report, null, 2), 'application/json');
}

export function downloadMarkdown(report) {
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  download(`unli-security-report-${stamp}.md`, toMarkdown(report), 'text/markdown');
}
