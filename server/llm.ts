// Anthropic API wrapper: hard local rate limit, usage accounting, typed failure reasons.
// All LLM access happens here, server-side only. The key never reaches the browser.

import Anthropic from '@anthropic-ai/sdk';
import type { IntakeFields, LlmStats } from './types.js';

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
// brittle JSON-from-prose parsing). Defaults to Opus 4.8 for the most reliable
// OCR on phone photos / handwriting; override with INTAKE_MODEL (e.g. set it to
// claude-haiku-4-5 if your key lacks Opus access).
export const INTAKE_MODEL = process.env.INTAKE_MODEL?.trim() || 'claude-opus-4-8';

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
