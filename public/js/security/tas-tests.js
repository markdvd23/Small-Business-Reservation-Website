/* ─── UNLI CHIX — SECURITY ASSESSMENT · MODULE C (RESERVED) ─────────────────
 * TAS Assessment (plawidnwad.md §3 Module C, §6 Stage 4).
 *
 * TAS has not been specified yet (Threat Analysis System / Traffic Anomaly
 * Screening / Token-Auth Security / Transaction Auditing Suite are the candidate
 * meanings). Rather than guess, this module ships the pluggable interface the
 * plan reserves — ITasSecurityAssessmentModule — plus a safe placeholder that
 * reports "Pending Specification" so the dashboard has a real object to render
 * and a real contract to implement against once requirements arrive.
 * ───────────────────────────────────────────────────────────────────────── */
import { SEVERITY } from './config.js';

/**
 * ITasSecurityAssessmentModule — the contract a future TAS implementation fills.
 * @typedef {Object} ITasSecurityAssessmentModule
 * @property {string} id
 * @property {string} title
 * @property {boolean} implemented
 * @property {() => Promise<object>} run   Resolves to a standard result object.
 */

/** @type {ITasSecurityAssessmentModule} */
export const TasModule = {
  id: 'tas',
  title: 'TAS Assessment',
  implemented: false,
  status: 'Pending Specification — Safe Interface Reserved',

  async run() {
    return {
      module: 'C',
      id: 'tas',
      title: 'TAS Assessment',
      passed: null,
      severity: SEVERITY.SKIPPED,
      summary: this.status,
      steps: [
        { label: 'interface', status: 'info', detail: 'ITasSecurityAssessmentModule is reserved and ready for integration.' },
        { label: 'status', status: 'info', detail: this.status },
        { label: 'next step', status: 'info', detail: 'Provide the TAS definition (e.g. Threat Analysis / Traffic Anomaly / Token-Auth / Transaction Audit) to activate this module.' },
      ],
      evidence: { implemented: false },
      finishedAt: new Date().toISOString(),
    };
  },
};

// Lets a future build register a concrete implementation without touching the UI.
export function registerTasImplementation(impl) {
  if (!impl || typeof impl.run !== 'function') throw new Error('A TAS implementation must expose run().');
  Object.assign(TasModule, impl, { implemented: true });
  return TasModule;
}
