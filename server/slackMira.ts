// Mira on Slack — the front desk's calendar agent.
//
// DM Mira (or @mention her) in plain English and she works the Outlook
// calendars via Microsoft Graph:
//   "put an inspection on Andrew's and my calendar Sept 5 at 10am, note: bring ladder"
//   "it's unconfirmed but still put it on"        → booked as Tentative + "(unconfirmed)"
//   "confirm the 10am inspection on the 5th"      → flips it solid
//   "move the inspection on the 5th to the 9th"   → reschedules (or "…to 2pm instead")
//   "cancel the 2pm on the 9th" / "what's on Andrew's calendar Friday?"
//
// Who is who: MIRA_PEOPLE maps first names to mailboxes, e.g.
//   MIRA_PEOPLE=brielle=brielle@armadapa.com,andrew=andrew@armadapa.com
// "my calendar" resolves via the sender's Slack first name; if that isn't in
// the map, MS_CALENDAR_USER is the fallback. Needs MIRA_SLACK_BOT_TOKEN +
// MIRA_SLACK_APP_TOKEN (its own Slack app, separate from Tessa's); no-ops
// gracefully when they're unset.

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient, LogLevel } from '@slack/web-api';
import * as llm from './llm.js';
import {
  calendarTimeZone,
  createEventFor,
  defaultCalendarUser,
  deleteEventFor,
  listEventsOn,
  outlookConfigured,
  patchEventFor,
  type OutlookEventInfo,
} from './outlook.js';
import type { Simulation } from './simulation.js';
import type { MiraCommand } from './types.js';

interface IncomingMessage {
  type: 'message';
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  client_msg_id?: string;
}

interface SocketEventArgs {
  event: unknown;
  ack: () => Promise<void>;
}

const UNCONFIRMED_TAG = ' (unconfirmed)';
const DEFAULT_DURATION_MIN = 60;

const HELP_REPLY =
  "Hi, Mira here 🌿 I keep the Outlook calendars. Try: *\"Put an inspection on Andrew's and my calendar for Sept 5 at 10am, note: wind damage, bring ladder\"* — say *unconfirmed* and I'll pencil it in as tentative. I can also *move*, *confirm*, or *cancel* one (\"move the 10am on the 5th to 2pm\"), or read a day back to you (\"what's on the calendar Friday?\").";

// Slack redelivers events it thinks we missed; remember what we've handled.
const seen = new Map<string, number>();
function alreadyHandled(msg: IncomingMessage): boolean {
  const key = msg.client_msg_id || `${msg.channel}:${msg.ts}`;
  const now = Date.now();
  for (const [k, t] of seen) {
    if (now - t > 10 * 60_000) seen.delete(k);
  }
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

// ---- people map ----

function peopleMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (process.env.MIRA_PEOPLE || '').split(',')) {
    const [name, email] = pair.split('=').map((s) => s?.trim().toLowerCase());
    if (name && email && email.includes('@')) map.set(name, email);
  }
  return map;
}

/** Resolve command people ("andrew", "me") to mailboxes. Unknown names are
 *  returned so Mira can say who she couldn't find. */
function resolveCalendars(
  people: string[],
  senderFirstName: string,
): { targets: Array<{ name: string; email: string }>; unknown: string[] } {
  const map = peopleMap();
  const targets: Array<{ name: string; email: string }> = [];
  const unknown: string[] = [];
  const wants = people.length > 0 ? people : ['me'];
  for (const raw of wants) {
    const name = raw === 'me' || raw === 'my' ? senderFirstName : raw;
    const email = map.get(name);
    if (email) {
      if (!targets.some((t) => t.email === email)) targets.push({ name: cap(name), email });
    } else if (raw === 'me' || raw === 'my') {
      const fallback = defaultCalendarUser();
      if (fallback && !targets.some((t) => t.email === fallback)) targets.push({ name: cap(senderFirstName || 'front desk'), email: fallback });
    } else {
      unknown.push(cap(name));
    }
  }
  return { targets, unknown };
}

// ---- little formatters ----

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function label12(hhmm: string): string {
  const [h0, m] = hhmm.split(':').map(Number);
  const ap = h0 < 12 ? 'AM' : 'PM';
  const h = h0 % 12 || 12;
  return `${h}:${pad(m)} ${ap}`;
}
function prettyDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
/** start "YYYY-MM-DDTHH:MM" + minutes → "YYYY-MM-DDTHH:MM:SS" (wall-clock math). */
function addMinutes(date: string, hhmm: string, minutes: number): { start: string; end: string } {
  const t = new Date(`${date}T${hhmm}:00Z`);
  const e = new Date(t.getTime() + minutes * 60_000);
  const fmt = (x: Date) => `${x.toISOString().slice(0, 10)}T${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:00`;
  return { start: fmt(t), end: fmt(e) };
}
function eventTime(ev: OutlookEventInfo): string {
  return ev.start.slice(11, 16); // HH:MM in the calendar's own time zone
}
function eventLine(ev: OutlookEventInfo): string {
  const tent = ev.showAs === 'tentative' || ev.subject.includes(UNCONFIRMED_TAG) ? ' _(unconfirmed)_' : '';
  const loc = ev.location ? ` — ${ev.location}` : '';
  return `${label12(eventTime(ev))} ${ev.subject.replace(UNCONFIRMED_TAG, '')}${loc}${tent}`;
}
function durationOf(ev: OutlookEventInfo): number {
  const [sh, sm] = [Number(ev.start.slice(11, 13)), Number(ev.start.slice(14, 16))];
  const [eh, em] = [Number(ev.end.slice(11, 13)), Number(ev.end.slice(14, 16))];
  const min = eh * 60 + em - (sh * 60 + sm);
  return min > 0 ? min : DEFAULT_DURATION_MIN;
}

// ---- the bot ----

export function miraSlackConfigured(): boolean {
  return Boolean(process.env.MIRA_SLACK_BOT_TOKEN?.trim() && process.env.MIRA_SLACK_APP_TOKEN?.trim());
}

/** Start Mira's Slack desk. Returns true when online; never throws. */
export async function startMiraSlackBot(sim?: Simulation): Promise<boolean> {
  if (!miraSlackConfigured()) {
    console.log('  Slack: Mira not configured — set MIRA_SLACK_BOT_TOKEN + MIRA_SLACK_APP_TOKEN to open her calendar desk.');
    return false;
  }
  const botToken = process.env.MIRA_SLACK_BOT_TOKEN!.trim();

  try {
    const web = new WebClient(botToken);
    const auth = await web.auth.test();
    const botUserId = String(auth.user_id || '');
    const nameCache = new Map<string, string>();

    const socket = new SocketModeClient({
      appToken: process.env.MIRA_SLACK_APP_TOKEN!.trim(),
      logLevel: LogLevel.WARN,
    });

    socket.on('error', (err: Error) => {
      console.warn(`  Slack(Mira): socket error — ${err.message}`);
    });

    socket.on('message', async ({ event, ack }: SocketEventArgs) => {
      await ack().catch(() => {});
      try {
        await handleMessage(event as IncomingMessage, web, botUserId, nameCache, sim);
      } catch (err) {
        console.warn(`  Slack(Mira): handler error — ${(err as Error).message}`);
      }
    });

    await socket.start();
    console.log(`  Slack: Mira is online via Socket Mode${auth.team ? ` in "${auth.team}"` : ''} — DM her a scheduling request.`);
    return true;
  } catch (err) {
    console.warn(`  Slack(Mira): failed to start — ${(err as Error).message}`);
    return false;
  }
}

async function senderFirstName(web: WebClient, userId: string, cache: Map<string, string>): Promise<string> {
  if (cache.has(userId)) return cache.get(userId)!;
  try {
    const info = await web.users.info({ user: userId });
    const real = (info.user?.profile?.real_name || info.user?.real_name || info.user?.name || '').trim();
    const first = real.split(/\s+/)[0]?.toLowerCase() || '';
    cache.set(userId, first);
    return first;
  } catch {
    return '';
  }
}

async function handleMessage(
  msg: IncomingMessage,
  web: WebClient,
  botUserId: string,
  nameCache: Map<string, string>,
  sim?: Simulation,
): Promise<void> {
  if (msg.bot_id || msg.subtype === 'bot_message') return;
  if (msg.subtype) return; // Mira only reads plain text
  const isDm = msg.channel_type === 'im';
  const mentioned = botUserId !== '' && (msg.text || '').includes(`<@${botUserId}>`);
  if (!isDm && !mentioned) return;
  if (alreadyHandled(msg)) return;

  const thread = isDm ? msg.thread_ts : msg.thread_ts || msg.ts;
  const post = async (text: string): Promise<void> => {
    await web.chat.postMessage({ channel: msg.channel, ...(thread ? { thread_ts: thread } : {}), text });
  };

  const text = (msg.text || '').replace(/<@[^>]+>/g, '').trim();
  if (!text) {
    await post(HELP_REPLY);
    return;
  }
  if (!outlookConfigured()) {
    await post("My calendar book is locked — the server is missing its Outlook (MS_*) settings. 🌿");
    return;
  }

  let cmd: MiraCommand;
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD Eastern
    const weekday = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
    cmd = await llm.parseMiraCommand(text, `${weekday}, ${today}`, [...peopleMap().keys()]);
  } catch (err) {
    const reason = err instanceof llm.LlmUnavailableError ? err.reason : 'api_error';
    await post(
      reason === 'rate_limit_local'
        ? "I'm juggling too many requests this minute — try me again shortly. 🌿"
        : `My notebook won't open (${(err as Error).message}). Try again in a moment?`,
    );
    return;
  }

  const sender = await senderFirstName(web, msg.user || '', nameCache);
  const { targets, unknown } = resolveCalendars(cmd.people, sender);
  const unknownNote = unknown.length
    ? `\n(I don't have a calendar address for *${unknown.join(', ')}* — add them to MIRA_PEOPLE and I will.)`
    : '';

  switch (cmd.action) {
    case 'create':
      await doCreate(cmd, targets, unknownNote, sender, post, sim);
      return;
    case 'edit':
    case 'confirm':
    case 'cancel':
      await doModify(cmd, targets, unknownNote, post, sim);
      return;
    case 'list':
      await doList(cmd, targets, post);
      return;
    default:
      await post(cmd.reply || HELP_REPLY);
  }
}

async function doCreate(
  cmd: MiraCommand,
  targets: Array<{ name: string; email: string }>,
  unknownNote: string,
  sender: string,
  post: (t: string) => Promise<void>,
  sim?: Simulation,
): Promise<void> {
  if (!cmd.date) {
    await post('Happy to! What *date* should the inspection go on? 🌿' + unknownNote);
    return;
  }
  if (!cmd.time) {
    await post(`Got it — ${prettyDate(cmd.date)}. What *time* should I book it for?` + unknownNote);
    return;
  }
  if (targets.length === 0) {
    await post("I couldn't work out whose calendar to put it on — name them for me (e.g. \"Andrew's and my calendar\")." + unknownNote);
    return;
  }

  const title = (cmd.title || 'Inspection') + (cmd.confirmed ? '' : UNCONFIRMED_TAG);
  const { start, end } = addMinutes(cmd.date, cmd.time, cmd.durationMin || DEFAULT_DURATION_MIN);
  const bodyHtml =
    (cmd.note ? `<p>${escapeHtml(cmd.note)}</p>` : '') +
    `<p style="color:#888;font-size:12px">🌿 Scheduled by Mira via Slack${sender ? ` for ${cap(sender)}` : ''}.${cmd.confirmed ? '' : ' Marked tentative until confirmed.'}</p>`;

  const results: string[] = [];
  let anyOk = false;
  for (const t of targets) {
    const r = await createEventFor(t.email, {
      subject: title,
      start,
      end,
      location: cmd.location,
      bodyHtml,
      showAs: cmd.confirmed ? 'busy' : 'tentative',
    });
    if (r.ok) anyOk = true;
    results.push(r.ok ? `✅ ${t.name}` : `⚠️ ${t.name} — ${r.reason}`);
  }

  const when = `${prettyDate(cmd.date)} at ${label12(cmd.time)}`;
  const status = cmd.confirmed ? 'confirmed' : '*unconfirmed* (shows as tentative — say "confirm it" when it firms up)';
  await post(
    `🌿 ${anyOk ? 'Penciled in!' : 'I tried, but the calendar pushed back:'} *${title.replace(UNCONFIRMED_TAG, '')}* — ${when}, ${status}.\n` +
      `Calendars: ${results.join(' · ')}` +
      (cmd.note ? `\n📝 Note attached: "${cmd.note}"` : '') +
      (cmd.location ? `\n📍 ${cmd.location}` : '') +
      unknownNote,
  );
  sim?.mirrorSlackSchedule(anyOk ? 'done' : 'failed', `${title.replace(UNCONFIRMED_TAG, '')} ${when}`);
}

/** Shared find-then-act for edit / confirm / cancel. */
async function doModify(
  cmd: MiraCommand,
  targets: Array<{ name: string; email: string }>,
  unknownNote: string,
  post: (t: string) => Promise<void>,
  sim?: Simulation,
): Promise<void> {
  if (!cmd.date) {
    await post('Which *date* is that event on? (e.g. "the inspection on Sept 5")' + unknownNote);
    return;
  }
  // If nobody was named, sweep every calendar in the book.
  const map = peopleMap();
  const sweep = targets.length > 0 ? targets : [...map.entries()].map(([name, email]) => ({ name: cap(name), email }));
  if (sweep.length === 0) {
    await post('I have no calendars configured yet (MIRA_PEOPLE is empty).' + unknownNote);
    return;
  }

  const hint = cmd.matchHint.toLowerCase();
  const hintTime = /(\d{1,2}):?(\d{2})?\s*(am|pm)/.exec(hint);
  const wantedTime = hintTime
    ? `${pad((Number(hintTime[1]) % 12) + (hintTime[3] === 'pm' ? 12 : 0))}:${hintTime[2] || '00'}`
    : cmd.time || '';

  const found: Array<{ who: { name: string; email: string }; ev: OutlookEventInfo }> = [];
  const problems: string[] = [];
  for (const who of sweep) {
    const day = await listEventsOn(who.email, cmd.date);
    if (!day.ok) {
      problems.push(`⚠️ ${who.name} — ${day.reason}`);
      continue;
    }
    let candidates = day.events!;
    if (wantedTime) candidates = candidates.filter((e) => eventTime(e) === wantedTime);
    if (candidates.length > 1 && hint) {
      const words = hint.split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|for|inspection)$/.test(w));
      const scored = candidates.filter((e) => words.some((w) => e.subject.toLowerCase().includes(w)));
      if (scored.length > 0) candidates = scored;
    }
    if (candidates.length > 1) {
      const inspections = candidates.filter((e) => e.subject.toLowerCase().includes('inspect'));
      if (inspections.length === 1) candidates = inspections;
    }
    for (const ev of candidates) found.push({ who, ev });
  }

  if (found.length === 0) {
    await post(
      `I looked through ${sweep.map((s) => s.name).join(', ')} on ${prettyDate(cmd.date)} and found nothing matching${cmd.matchHint ? ` "${cmd.matchHint}"` : ''}. 🌿` +
        (problems.length ? `\n${problems.join('\n')}` : ''),
    );
    return;
  }

  // The same event usually exists on several calendars — group by start+subject.
  const groups = new Map<string, Array<{ who: { name: string; email: string }; ev: OutlookEventInfo }>>();
  for (const f of found) {
    const key = `${f.ev.start}|${f.ev.subject}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }
  if (groups.size > 1) {
    const lines = [...groups.values()].map((g, i) => `${i + 1}. ${eventLine(g[0].ev)} (${g.map((x) => x.who.name).join(', ')})`);
    await post(
      `That day has a few things on it — which one did you mean?\n${lines.join('\n')}\nSay it with the time, like "move the ${label12(eventTime([...groups.values()][0][0].ev))} one to…"`,
    );
    return;
  }

  const copies = [...groups.values()][0];
  const original = copies[0].ev;
  const results: string[] = [];
  let anyOk = false;

  for (const { who, ev } of copies) {
    if (cmd.action === 'cancel') {
      const r = await deleteEventFor(who.email, ev.id);
      if (r.ok) anyOk = true;
      results.push(r.ok ? `✅ ${who.name}` : `⚠️ ${who.name} — ${r.reason}`);
      continue;
    }
    if (cmd.action === 'confirm') {
      const r = await patchEventFor(who.email, ev.id, {
        subject: ev.subject.replace(UNCONFIRMED_TAG, ''),
        showAs: 'busy',
      });
      if (r.ok) anyOk = true;
      results.push(r.ok ? `✅ ${who.name}` : `⚠️ ${who.name} — ${r.reason}`);
      continue;
    }
    // edit: move date and/or time, keeping the original duration
    const newDate = cmd.newDate || cmd.date;
    const newTime = cmd.newTime || eventTime(ev);
    const { start, end } = addMinutes(newDate, newTime, durationOf(ev));
    const r = await patchEventFor(who.email, ev.id, { start, end });
    if (r.ok) anyOk = true;
    results.push(r.ok ? `✅ ${who.name}` : `⚠️ ${who.name} — ${r.reason}`);
  }

  const label = original.subject.replace(UNCONFIRMED_TAG, '');
  const verb =
    cmd.action === 'cancel'
      ? 'Cancelled'
      : cmd.action === 'confirm'
        ? 'Confirmed — it shows solid now'
        : `Moved to ${prettyDate(cmd.newDate || cmd.date)} at ${label12(cmd.newTime || eventTime(original))}`;
  await post(
    `🌿 ${anyOk ? verb : 'The calendar pushed back'}: *${label}* (was ${prettyDate(cmd.date)} ${label12(eventTime(original))}).\nCalendars: ${results.join(' · ')}` +
      (problems.length ? `\n${problems.join('\n')}` : '') +
      unknownNote,
  );
  sim?.mirrorSlackSchedule(anyOk ? 'done' : 'failed', `${verb.toLowerCase()}: ${label}`);
}

async function doList(
  cmd: MiraCommand,
  targets: Array<{ name: string; email: string }>,
  post: (t: string) => Promise<void>,
): Promise<void> {
  const date = cmd.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const map = peopleMap();
  const sweep = targets.length > 0 ? targets : [...map.entries()].map(([name, email]) => ({ name: cap(name), email }));
  const sections: string[] = [];
  for (const who of sweep) {
    const day = await listEventsOn(who.email, date);
    if (!day.ok) {
      sections.push(`*${who.name}*: ⚠️ ${day.reason}`);
    } else if (day.events!.length === 0) {
      sections.push(`*${who.name}*: clear 🌱`);
    } else {
      sections.push(`*${who.name}*:\n${day.events!.map((e) => `  • ${eventLine(e)}`).join('\n')}`);
    }
  }
  await post(`🌿 ${prettyDate(date)}:\n${sections.join('\n')}`);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
