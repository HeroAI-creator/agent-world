// Anthropic API wrapper: hard local rate limit, usage accounting, typed failure reasons.
// All LLM access happens here, server-side only. The key never reaches the browser.

import Anthropic from '@anthropic-ai/sdk';
import type { Appointment, IntakeExtras, IntakeFields, LlmStats, MiraCommand } from './types.js';

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

export async function extractIntakeFields(fileB64: string, mediaType: string): Promise<IntakeFields> {
  pruneWindow();
  if (callTimes.length >= maxCallsPerMin()) {
    throw new LlmUnavailableError(`local rate cap reached (${maxCallsPerMin()} calls/min)`, 'rate_limit_local');
  }
  const anthropic = getClient();
  // PDFs ride as a native document block; anything else is treated as an image.
  const media = (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType) ? mediaType : 'image/jpeg') as ImageMediaType;
  const fileBlock: Anthropic.ContentBlockParam =
    mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileB64 } }
      : { type: 'image', source: { type: 'base64', media_type: media, data: fileB64 } };
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
            fileBlock,
            {
              type: 'text',
              text:
                'This is a completed insurance claim intake form for Armada Public Adjusting. ' +
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

// ---- Dictation intake: extract fields from a call transcript ----
//
// A recorded homeowner <-> front desk call is transcribed (server/transcribe.ts),
// then this pulls the same nine intake fields off the conversation, plus short
// call notes for the generated Intake Sheet. Same forced-tool discipline as the
// photo path: never invent, empty string when the call never says it.

const EXTRAS_KEYS: Array<keyof IntakeExtras> = [
  'policy_address', 'damage_description', 'interior_damage', 'who_discovered', 'gated_community', 'gate_code',
  'insurance_source', 'prior_claims', 'mortgage', 'claim_style', 'stories', 'roof_type_age', 'roof_slope',
  'tarp', 'removal_needed', 'habitable', 'emergency_services', 'repairs_made', 'source_inspector', 'referral',
];

const str = (desc: string) => ({ type: 'string' as const, description: desc });

const TRANSCRIPT_TOOL: Anthropic.Tool = {
  name: 'record_intake_from_call',
  description: "Record everything the firm's Claim Intake Sheet asks, as heard in a phone call transcript.",
  input_schema: {
    type: 'object',
    properties: {
      ...(INTAKE_TOOL.input_schema.properties as Record<string, unknown>),
      policy_address: str('Address on the policy, ONLY if stated as different from the loss address. Else empty.'),
      damage_description: str('Type of / description of the damage in a short phrase (e.g. "wind — shingles off over master bedroom").'),
      interior_damage: str('Interior damage and where, if any was mentioned (e.g. "yes — ceiling stain in master bedroom").'),
      who_discovered: str('Who discovered the loss.'),
      gated_community: str('"Gated" or "Non-gated" if mentioned.'),
      gate_code: str('Gate code if given.'),
      insurance_source: str('Whether they bought the insurance themselves or the mortgage company provided/forced it.'),
      prior_claims: str('Any prior claims in the last 5 years, as stated.'),
      mortgage: str('Mortgage company / whether the home has a mortgage, as stated.'),
      claim_style: str('Exactly one of "Emergency", "Non-Emergency", "Supplemental" if determinable from the call, else empty.'),
      stories: str('How many stories the home has.'),
      roof_type_age: str('Roof type and/or age (e.g. "shingle, ~12 years").'),
      roof_slope: str('Slope/pitch of the roof if mentioned.'),
      tarp: str('Whether a tarp is needed or already installed.'),
      removal_needed: str('Anything that needs to be removed (debris, tree, contents).'),
      habitable: str('Whether the home is habitable/livable.'),
      emergency_services: str('Any emergency service called (fire dept, water mitigation, etc.).'),
      repairs_made: str('Whether any repairs have been made already.'),
      source_inspector: str('Who is the source/inspector/title if named.'),
      referral: str('How they heard about the firm.'),
      call_notes: str('Two to four sentences of notes a front desk would keep: what happened, urgency, anything promised to the homeowner, follow-ups discussed. Plain prose.'),
    },
    required: [...(INTAKE_TOOL.input_schema.required as string[]), ...EXTRAS_KEYS, 'call_notes'],
  },
};

function normalizeExtras(raw: Partial<Record<keyof IntakeExtras, unknown>>): IntakeExtras {
  const out = {} as IntakeExtras;
  for (const key of EXTRAS_KEYS) {
    const v = raw[key];
    out[key] = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
  }
  return out;
}

export async function extractIntakeFromTranscript(
  transcript: string,
): Promise<{ fields: IntakeFields; extras: IntakeExtras; callNotes: string }> {
  pruneWindow();
  if (callTimes.length >= maxCallsPerMin()) {
    throw new LlmUnavailableError(`local rate cap reached (${maxCallsPerMin()} calls/min)`, 'rate_limit_local');
  }
  const anthropic = getClient();
  callTimes.push(Date.now());
  totals.calls += 1;
  try {
    const response = await anthropic.messages.create({
      model: INTAKE_MODEL,
      max_tokens: 2000,
      tools: [TRANSCRIPT_TOOL],
      tool_choice: { type: 'tool', name: 'record_intake_from_call' },
      messages: [
        {
          role: 'user',
          content:
            'This is a transcript of a recording from the front desk of Armada Public Adjusting, a Florida public ' +
            'adjusting firm, about a new property insurance claim. It is either the intake phone call itself ' +
            '(homeowner + front desk talking) or a staff member dictating the completed intake afterward (often ' +
            'reading the form aloud, label then answer). The firm fills a Claim Intake Sheet from it. ' +
            'Call record_intake_from_call with every field the recording actually states — names and ' +
            'addresses as spoken (fix obvious transcription stumbles like spelled-out letters), phone numbers as ' +
            'digits, dates as written dates, yes/no answers as short phrases. For anything the call never mentions, ' +
            'pass an empty string. Do not guess or invent values. Also write the call_notes summary.\n\n----\n' +
            transcript,
        },
      ],
    });
    totals.inputTokens += response.usage.input_tokens;
    totals.outputTokens += response.usage.output_tokens;
    const block = response.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      throw new LlmUnavailableError('model did not return structured intake fields', 'api_error');
    }
    const raw = block.input as Partial<Record<keyof IntakeFields, unknown>> &
      Partial<Record<keyof IntakeExtras, unknown>> & { call_notes?: unknown };
    return {
      fields: normalizeIntake(raw),
      extras: normalizeExtras(raw),
      callNotes: typeof raw.call_notes === 'string' ? raw.call_notes.trim() : '',
    };
  } catch (err) {
    throw toLlmError(err);
  }
}

// ---- Mira's Slack calendar desk: parse one scheduling command ----
//
// Front desk chats naturally ("put an inspection on Andrew's and my calendar
// for the 5th at 10, unconfirmed"; "move the 10am on the 5th to 2pm"). A
// forced tool call turns each message into one structured MiraCommand the
// Slack bot executes against Outlook.

const MIRA_COMMAND_TOOL: Anthropic.Tool = {
  name: 'calendar_command',
  description: "Record the single calendar action the user's message asks for (or 'other' with a reply).",
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'edit', 'confirm', 'cancel', 'list', 'other'],
        description:
          "create = book a new event. edit = move/change an existing one. confirm = mark a tentative event confirmed. cancel = remove one. list = read out a day's calendar. other = anything else (chitchat, questions).",
      },
      people: {
        type: 'array',
        items: { type: 'string' },
        description:
          'First names of everyone whose calendar is involved. Use "me" for the sender themself ("my calendar"). Empty array if nobody is named.',
      },
      date: { type: 'string', description: 'Event date as YYYY-MM-DD (resolve relative dates using today). Empty string if never given.' },
      time: { type: 'string', description: 'Start time, 24-hour HH:MM. Empty string if not given.' },
      duration_min: { type: 'number', description: 'Length in minutes if stated, else 0.' },
      title: { type: 'string', description: 'Short event title like "Inspection — Duran" if derivable (client/claim name), else empty string.' },
      location: { type: 'string', description: 'Property address / place if given, else empty string.' },
      note: { type: 'string', description: 'Any note text the user wants attached to the event, else empty string.' },
      confirmed: { type: 'boolean', description: 'false if the user says unconfirmed / tentative / not confirmed / pencil it in. true otherwise.' },
      new_date: { type: 'string', description: 'For edit: the NEW date YYYY-MM-DD. Empty string if the date is unchanged.' },
      new_time: { type: 'string', description: 'For edit: the NEW start time 24h HH:MM. Empty string if the time is unchanged.' },
      match_hint: { type: 'string', description: 'For edit/confirm/cancel: words identifying WHICH event ("10am", client name, "inspection"). Empty string if none.' },
      reply: { type: 'string', description: "For action=other: Mira's short in-character reply (friendly herbalist, 1-2 sentences). Empty string otherwise." },
    },
    required: ['action', 'people', 'date', 'time', 'duration_min', 'title', 'location', 'note', 'confirmed', 'new_date', 'new_time', 'match_hint', 'reply'],
  },
};

export async function parseMiraCommand(text: string, today: string, knownPeople: string[]): Promise<MiraCommand> {
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
      max_tokens: 700,
      tools: [MIRA_COMMAND_TOOL],
      tool_choice: { type: 'tool', name: 'calendar_command' },
      messages: [
        {
          role: 'user',
          content:
            `Today is ${today} (time zone: US Eastern). You are Mira, the scheduling agent for Armada Public Adjusting, ` +
            `reading one Slack message from the front desk. Known calendar people: ${knownPeople.join(', ') || '(none configured)'}. ` +
            'Call calendar_command once for the single action the message asks for. Resolve relative dates ("next Friday", "the 5th") ' +
            'to YYYY-MM-DD using today. Times are 24-hour HH:MM (e.g. "10am" → "10:00", "2:30pm" → "14:30"). ' +
            '"my calendar" / "me too" means the person "me". Words like unconfirmed, tentative, not locked in, pencil it in → confirmed=false. ' +
            'If the message asks to change/move/reschedule an event, action=edit with new_date/new_time. Do not invent dates, times, or people.\n\n----\n' +
            text,
        },
      ],
    });
    totals.inputTokens += response.usage.input_tokens;
    totals.outputTokens += response.usage.output_tokens;
    const block = response.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      throw new LlmUnavailableError('model did not return a calendar command', 'api_error');
    }
    const o = (block.input ?? {}) as Record<string, unknown>;
    const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
    const actions = ['create', 'edit', 'confirm', 'cancel', 'list', 'other'];
    return {
      action: (actions.includes(str('action')) ? str('action') : 'other') as MiraCommand['action'],
      people: Array.isArray(o.people) ? (o.people as unknown[]).map((p) => String(p).trim().toLowerCase()).filter(Boolean) : [],
      date: str('date'),
      time: str('time'),
      durationMin: typeof o.duration_min === 'number' && o.duration_min > 0 ? Math.round(o.duration_min) : 0,
      title: str('title'),
      location: str('location'),
      note: str('note'),
      confirmed: o.confirmed !== false,
      newDate: str('new_date'),
      newTime: str('new_time'),
      matchHint: str('match_hint'),
      reply: str('reply'),
    };
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
