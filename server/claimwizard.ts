// ClaimWizard filing — creates a new lead from an approved intake.
//
// The boss's account credentials live in .env (CLAIMWIZARD_USER/_PASS).
// ClaimWizard has no public API docs; their official Zapier app proves an API
// exists, so the plan is: scout the logged-in account for an API key or
// integration settings, and wire this module to it (or fall back to headless
// browser automation of app.claimwizard.com). Until that scout happens this
// module reports "not wired" so the Slack flow can say so honestly.

import type { IntakeExtras, IntakeFields } from './types.js';

export interface CwResult {
  ok: boolean;
  leadId?: string;
  reason?: string;
}

export function claimWizardConfigured(): boolean {
  return Boolean(process.env.CLAIMWIZARD_USER?.trim() && process.env.CLAIMWIZARD_PASS?.trim());
}

export async function createClaimWizardLead(_f: IntakeFields, _x: IntakeExtras, _notes: string): Promise<CwResult> {
  if (!claimWizardConfigured()) {
    return { ok: false, reason: 'ClaimWizard credentials not set (CLAIMWIZARD_USER / CLAIMWIZARD_PASS).' };
  }
  return { ok: false, reason: 'ClaimWizard automation not wired yet — account scout pending (API key or UI automation).' };
}
