// Anthropic API wrapper: hard local rate limit, usage accounting, typed failure reasons.
// All LLM access happens here, server-side only. The key never reaches the browser.

import Anthropic from '@anthropic-ai/sdk';
import type { LlmStats } from './types.js';

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
