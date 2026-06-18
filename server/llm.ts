// Anthropic API wrapper: hard local rate limit, usage accounting, typed failure reasons.
// All LLM access happens here, server-side only. The key never reaches the browser.

import Anthropic from '@anthropic-ai/sdk';
import type { Appointment, IntakeFields, LlmStats } from './types.js';

// Claude Haiku 4.5 pricing, $ per million tokens.
const PRICE_IN_PER_MTOK = 1.0;
const PRICE_OUT_PER_MTOK = 5.0;

export const MODEL = process.env.MODEL?.trim() || 'claude-haiku-4-5-20251001';

export type LlmFailureReason = 'no_key' | 'rate_limit_local' | 'auth' | 'api_error';

export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    public readonly reason: LlmFailureReason,
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

let client: Anthropic | null = null;
const callTimes: number[] = [];
const totals = { calls: 0, inputTokens: 0, outputTokens: 0 };

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function maxCallsPerMin(): number {
  return Math.max(1, Number(process.env.MAX_API_CALLS_PER_MIN) || 10);
}

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new LlmUnavailableError('ANTHROPIC_API_KEY is not set', 'no_key');
  }
  if (!client) {
    client = new Anthropic({ apiKey, maxRetries: 1, timeout: 30_000 });
  }
  return client;
}

function pruneWindow(): void {
  const cutoff = Date.now() - 60_000;
  while (callTimes.length && callTimes[0] < cutoff) callTimes.shift();
}

export function callsInLastMinute(): number {
  pruneWindow();
  return callTimes.length;
}

export async function complete(opts: { system: string; user: string; maxTokens: number }): Promise<string> {
  pruneWindow();
  if (callTimes.length >= maxCallsPerMin()) {
    throw new LlmUnavailableError(`local rate cap reached (${maxCallsPerMin()} calls/min)`, 'rate_limit_local');
  }
  const anthropic = getClient();
  callTimes.push(Date.now());
  totals.calls += 1;
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
    });
    totals.inputTokens += response.usage.input_tokens;
    totals.outputTokens += response.usage.output_tokens;
    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
    }
    return text;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new LlmUnavailableError('Anthropic rejected the API key (401 authentication_error)', 'auth');
    }
    if (err instanceof Anthropic.APIError) {
      throw new LlmUnavailableError(`Anthropic API error${err.status ? ` (${err.status})` : ''}: ${err.message}`, 'api_error');
    }
    throw new LlmUnavailableError(`network error calling Anthropic: ${(err as Error).message}`, 'api_error');
  }
}

// ---- Armada intake vision extraction ----
//
// A photo of a claim intake form is read by a vision-capable model that is
// FORCED to call one tool, so the result is always a structured object (no
// brittle JSON-from-prose parsing). Defaults to Haiku 4.5 to keep every agent on
// the same cheap model. Opus 4.8 reads phone photos / handwriting more reliably —
// if intake extraction starts missing fields, set INTAKE_MODEL=claude-opus-4-8.
export const INTAKE_MODEL = process.env.INTAKE_MODEL?.trim() || 'claude-haiku-4-5-20251001';

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const INTAKE_TOOL: Anthropic.Tool = {
  name: 'record_intake',
  description: 'Record the fields read off an insurance claim intake form for a public adjusting firm.',
  input_schema: {
    type: 'object',
    properties: {
      insured_name: { type: 'string', description: 'Full name of the insured / policyholder.' },
      loss_address: { type: 'string', description: 'Street address of the insured property (the loss location).' },
      policy_number: { type: 'string', description: 'Insurance policy number.' },
      claim_number: { type: 'string', description: 'Claim number, if one has been assigned.' },
      date_of_loss: { type: 'string', description: 'Date of loss exactly as written, e.g. 03/14/2026.' },
      cause_of_loss: { type: 'string', description: 'Cause / type of loss, e.g. water, wind, fire, hurricane, roof leak.' },
      carrier: { type: 'string', description: 'Insurance carrier / company name.' },
      phone: { type: 'string', description: "Insured's phone number." },
      email: { type: 'string', description: "Insured's email address." },
    },
    required: ['insured_name', 'loss_address', 'policy_number', 'claim_number', 'date_of_loss', 'cause_of_loss', 'carrier', 'phone', 'email'],
  },
};

const INTAKE_FIELDS: Array<keyof IntakeFields> = [
  'insured_name', 'loss_address', 'policy_number', 'claim_number', 'date_of_loss', 'cause_of_loss', 'carrier', 'phone', 'email',
];

function normalizeIntake(raw: Partial<Record<keyof IntakeFields, unknown>>): IntakeFields {
  const out = {} as IntakeFields;
  for (const key of INTAKE_FIELDS) {
    const v = raw[key];
    out[key] = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
  }
  return out;
}

function toLlmError(err: unknown): LlmUnavailableError {
  if (err instanceof LlmUnavailableError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new LlmUnavailableError('Anthropic rejected the API key (401 authentication_error)', 'auth');
  }
  if (err instanceof Anthropic.APIError) {
    return new LlmUnavailableError(`Anthropic API error${err.status ? ` (${err.status})` : ''}: ${err.message}`, 'api_error');
  }
  return new LlmUnavailableError(`network error calling Anthropic: ${(err as Error).message}`, 'api_error');
}

export async function extractIntakeFields(imageB64: string, mediaType: string): Promise<IntakeFields> {
  pruneWindow();
  if (callTimes.length >= maxCallsPerMin()) {
    throw new LlmUnavailableError(`local rate cap reached (${maxCallsPerMin()} calls/min)`, 'rate_limit_local');
  }
  const anthropic = getClient();
  const media = (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType) ? mediaType : 'image/jpeg') as ImageMediaType;
  callTimes.push(Date.now());
  totals.calls += 1;
  try {
    const response = await anthropic.messages.create({
      model: INTAKE_MODEL,
      max_tokens: 1024,
      tools: [INTAKE_TOOL],
      tool_choice: { type: 'tool', name: 'record_intake' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media, data: imageB64 } },
            {
              type: 'text',
              text:
                'This image is a completed insurance claim intake form for Armada Public Adjusting. ' +
                'Read it carefully and call record_intake with every field, using the exact values written on the form. ' +
                'For any field that is not present or not legible, pass an empty string. Do not guess or invent values.',
            },
          ],
        },
      ],
    });
    totals.inputTokens += response.usage.input_tokens;
    totals.outputTokens += response.usage.output_tokens;
    const block = response.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      throw new LlmUnavailableError('model did not return structured intake fields', 'api_error');
    }
    return normalizeIntake(block.input as Partial<Record<keyof IntakeFields, unknown>>);
  } catch (err) {
    throw toLlmError(err);
  }
}

// ---- Mira scheduling: parse pasted appointments ----
//
// The user pastes a free-form list of stops ("Tue 6/24 9am — 123 Main St,
// Brooksville; then 456 Oak Ave at 11…"). A forced tool call turns it into a
// clean array so the router/scheduler has structured addresses + dates.

const APPOINTMENTS_TOOL: Anthropic.Tool = {
  name: 'record_appointments',
  description: 'Record the list of property visits / appointments the user wants routed and scheduled.',
  input_schema: {
    type: 'object',
    properties: {
      appointments: {
        type: 'array',
        description: 'Every distinct stop found in the text. Empty array if the text is not a list of appointments.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Client name or label for the visit. Empty string if none.' },
            address: { type: 'string', description: 'Full street address of the stop, as complete as given.' },
            date: { type: 'string', description: 'Visit date as YYYY-MM-DD when the year is clear; otherwise exactly as written; empty string if no date.' },
            time: { type: 'string', description: 'Fixed start time in 24-hour HH:MM if the user specified one, else empty string.' },
            durationMin: { type: 'number', description: 'Visit length in minutes if stated, else 0.' },
          },
          required: ['title', 'address', 'date', 'time', 'durationMin'],
        },
      },
    },
    required: ['appointments'],
  },
};

export async function extractAppointments(text: string, today: string): Promise<Appointment[]> {
  pruneWindow();
  if (callTimes.length >= maxCallsPerMin()) {
    throw new LlmUnavailableError(`local rate cap reached (${maxCallsPerMin()} calls/min)`, 'rate_limit_local');
  }
  const anthropic = getClient();
  callTimes.push(Date.now());
  totals.calls += 1;
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      tools: [APPOINTMENTS_TOOL],
      tool_choice: { type: 'tool', name: 'record_appointments' },
      messages: [
        {
          role: 'user',
          content:
            `Today is ${today}. Extract every property visit / appointment from the following text for a public ` +
            'adjusting field route. Call record_appointments with one entry per stop, copying addresses exactly. ' +
            'Resolve relative or partial dates (e.g. "next Tuesday", "6/24") to absolute YYYY-MM-DD using today\'s ' +
            'date. If the text is not a list of stops, return an empty array. Do not invent stops.\n\n----\n' + text,
        },
      ],
    });
    totals.inputTokens += response.usage.input_tokens;
    totals.outputTokens += response.usage.output_tokens;
    const block = response.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') return [];
    const raw = (block.input as { appointments?: unknown }).appointments;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((r): Appointment => {
        const o = (r ?? {}) as Record<string, unknown>;
        return {
          title: typeof o.title === 'string' ? o.title.trim() : '',
          address: typeof o.address === 'string' ? o.address.trim() : '',
          date: typeof o.date === 'string' ? o.date.trim() : '',
          time: typeof o.time === 'string' ? o.time.trim() : '',
          durationMin: typeof o.durationMin === 'number' && o.durationMin > 0 ? Math.round(o.durationMin) : 0,
        };
      })
      .filter((a) => a.address.length > 0);
  } catch (err) {
    throw toLlmError(err);
  }
}

// ---- JARVIS: the campfire dispatcher agent ----
//
// JARVIS is the brain the user talks to. It reads the message, decides which
// specialist should handle it (Mira = routing/scheduling, Tessa = intake photos)
// or whether to just answer, and speaks back in its own voice. Uses Sonnet by
// default for sharper routing/judgment; the workers stay on Haiku.

export const JARVIS_MODEL = process.env.JARVIS_MODEL?.trim() || 'claude-sonnet-4-6';

export type JarvisRoute = 'schedule' | 'intake' | 'chat';
export interface JarvisDecision {
  route: JarvisRoute;
  reply: string;
}

const JARVIS_SYSTEM =
  'You are JARVIS, the calm, capable AI that floats above the campfire in Agent World — the control desk for Armada Public Adjusting. ' +
  'You coordinate two specialist villagers and answer directly when neither is needed. Decide by what the user wants DONE, not by individual words:\n' +
  '- Mira (route="schedule"): she takes property visits/appointments (addresses, optional dates/times), optimizes the driving route, books them on Outlook in order, and emails the route. Choose this whenever the user wants stops/visits/appointments ROUTED, SCHEDULED, planned, ordered, or put on the calendar.\n' +
  '- Tessa (route="intake"): she reads a claim-intake FORM PHOTO and drafts the Welcome Letter + carrier Notice. Choose this ONLY when the user wants a claim intake form/photo turned into those documents (it needs an attached image).\n' +
  'CRITICAL: the word "claim" does NOT by itself mean intake — public adjusters drive to claim sites, so "route/schedule these claims" or visits-with-addresses-to-schedule is ALWAYS Mira (route="schedule"). Intake is specifically about processing a claim FORM into documents. ' +
  'If a message mentions a claim but asks to route/schedule/plan visits, choose route="schedule". Use route="chat" only when neither applies. ' +
  'Always set reply to a short (1-3 sentence) message in your composed JARVIS voice telling the user what you are doing. When handing to Mira, do not restate the stops — just say you are handing it to her.';

const JARVIS_TOOL: Anthropic.Tool = {
  name: 'dispatch',
  description: 'Decide how to handle the user message and what JARVIS says back.',
  input_schema: {
    type: 'object',
    properties: {
      route: { type: 'string', enum: ['schedule', 'intake', 'chat'], description: 'Which path handles this message.' },
      reply: { type: 'string', description: "JARVIS's spoken reply to the user (1-3 sentences, in character)." },
    },
    required: ['route', 'reply'],
  },
};

export async function jarvisDispatch(text: string): Promise<JarvisDecision> {
  pruneWindow();
  if (callTimes.length >= maxCallsPerMin()) {
    throw new LlmUnavailableError(`local rate cap reached (${maxCallsPerMin()} calls/min)`, 'rate_limit_local');
  }
  const anthropic = getClient();
  callTimes.push(Date.now());
  totals.calls += 1;
  try {
    const response = await anthropic.messages.create({
      model: JARVIS_MODEL,
      max_tokens: 400,
      tools: [JARVIS_TOOL],
      tool_choice: { type: 'tool', name: 'dispatch' },
      system: JARVIS_SYSTEM,
      messages: [{ role: 'user', content: text }],
    });
    totals.inputTokens += response.usage.input_tokens;
    totals.outputTokens += response.usage.output_tokens;
    const block = response.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new LlmUnavailableError('JARVIS did not return a decision', 'api_error');
    const input = block.input as { route?: unknown; reply?: unknown };
    const route: JarvisRoute = input.route === 'schedule' || input.route === 'intake' ? input.route : 'chat';
    const reply = typeof input.reply === 'string' && input.reply.trim() ? input.reply.trim() : 'On it.';
    return { route, reply };
  } catch (err) {
    throw toLlmError(err);
  }
}

export function getStats(): LlmStats {
  return {
    calls: totals.calls,
    callsPerMin: callsInLastMinute(),
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    estCostUsd: (totals.inputTokens * PRICE_IN_PER_MTOK + totals.outputTokens * PRICE_OUT_PER_MTOK) / 1_000_000,
  };
}

/** Printed at boot so cost expectations are visible before any spend happens. */
export function describeHourlyCost(): string {
  const avgIn = 550; // observed-ish prompt size for decision calls
  const avgOut = 200;
  const perCall = (avgIn * PRICE_IN_PER_MTOK + avgOut * PRICE_OUT_PER_MTOK) / 1_000_000;
  const typicalLow = 60 * perCall; // ~1 call/min
  const typicalHigh = 240 * perCall; // ~4 calls/min
  const ceiling = maxCallsPerMin() * 60 * perCall;
  return `~$${typicalLow.toFixed(3)}-$${typicalHigh.toFixed(2)}/hour typical (1-4 calls/min), hard ceiling ~$${ceiling.toFixed(2)}/hour at the ${maxCallsPerMin()}/min cap`;
}
