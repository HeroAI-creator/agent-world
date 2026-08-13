// Tessa on Slack — a Socket Mode bot that runs the Armada intake pipeline.
//
// DM Tessa a photo of an intake form (or @mention her with one in a channel
// she's been invited to) and she does exactly what her in-game self does:
// Claude reads the form, the Welcome Letter + Notice to Insurance are filled,
// Resend emails them to the firm, and the intake is filed into Atlas PA.
// She narrates each step in the Slack thread and uploads the drafted .docx
// files back into it. Text-only DMs get a short in-character reply.
//
// Built on @slack/socket-mode + @slack/web-api (not Bolt — Bolt v5 peer-locks
// to Express 5 types and this server is on Express 4). Socket Mode dials OUT
// to Slack over a websocket, so no public URL, domain, or SSL is needed — this
// runs anywhere the server runs (Railway included). Needs SLACK_BOT_TOKEN
// (xoxb-, from Install App) and SLACK_APP_TOKEN (xapp-, app-level token with
// connections:write). When either is missing the bot no-ops so the game
// server runs unchanged.

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient, LogLevel } from '@slack/web-api';
import * as llm from './llm.js';
import { emailIntake, fillTemplates, fileIntakeToCrm, type FilledDoc } from './intake.js';
import type { Simulation } from './simulation.js';
import type { IntakeFields } from './types.js';

// The slices of Slack's message event this module actually uses. Slack's own
// types are a sprawling union across subtypes; we narrow structurally instead.
interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}

interface IncomingMessage {
  type: 'message';
  subtype?: string;
  channel: string;
  channel_type?: string; // im | mpim | channel | group
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
  client_msg_id?: string;
}

interface SocketEventArgs {
  event: unknown;
  ack: () => Promise<void>;
  retry_num?: number;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic's per-image ceiling

const TESSA_SYSTEM = `You are Tessa, Armada Public Adjusting's intake agent, chatting in Slack. Warm, competent, brief — 1 to 3 short sentences, the occasional emoji. Your one job: when someone sends a PHOTO of a claim intake form, you read it, draft the Welcome Letter and the Notice to Insurance, email them to the firm, and file the claim into the Atlas PA CRM. If asked anything else, answer briefly and remind them you're happiest when handed an intake photo.`;

const HELP_REPLY =
  "Hi! I'm Tessa 📋 Send me a photo of a claim intake form and I'll read it, draft the Welcome Letter + Notice to Insurance, email them to the firm, and file the claim into Atlas PA.";

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

function isIntakePhoto(f: SlackFile): boolean {
  return IMAGE_TYPES.has(f.mimetype || '') && Boolean(f.url_private_download);
}

/** The nine fields, Slack-mrkdwn formatted, so a human can eyeball-verify the
 *  extraction right in the thread (mirrors the summary table in the email). */
function fieldSummary(f: IntakeFields): string {
  const rows: Array<[string, string]> = [
    ['Insured', f.insured_name],
    ['Loss Address', f.loss_address],
    ['Carrier', f.carrier],
    ['Policy #', f.policy_number],
    ['Claim #', f.claim_number],
    ['Date of Loss', f.date_of_loss],
    ['Cause of Loss', f.cause_of_loss],
    ['Phone', f.phone],
    ['Email', f.email],
  ];
  const lines = rows.map(([k, v]) => `• *${k}:* ${v || '_— not on form —_'}`);
  return `🔎 Here's what I read off the form:\n${lines.join('\n')}`;
}

export function slackConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN?.trim() && process.env.SLACK_APP_TOKEN?.trim());
}

/** Start the bot. Returns true when Tessa is online; never throws — a Slack
 *  misconfiguration must not take the game server down with it. */
export async function startSlackBot(sim?: Simulation): Promise<boolean> {
  if (!slackConfigured()) {
    console.log('  Slack: not configured — set SLACK_BOT_TOKEN + SLACK_APP_TOKEN to put Tessa on Slack.');
    return false;
  }
  const botToken = process.env.SLACK_BOT_TOKEN!.trim();

  try {
    const web = new WebClient(botToken);
    const auth = await web.auth.test();
    const botUserId = String(auth.user_id || '');

    const socket = new SocketModeClient({
      appToken: process.env.SLACK_APP_TOKEN!.trim(),
      logLevel: LogLevel.WARN,
    });

    socket.on('error', (err: Error) => {
      console.warn(`  Slack: socket error — ${err.message}`);
    });

    socket.on('message', async ({ event, ack }: SocketEventArgs) => {
      await ack().catch(() => {}); // ack within 3s or Slack redelivers
      try {
        await handleMessage(event as IncomingMessage, web, botUserId, botToken, sim);
      } catch (err) {
        console.warn(`  Slack: handler error — ${(err as Error).message}`);
      }
    });

    await socket.start();
    console.log(`  Slack: Tessa is online via Socket Mode${auth.team ? ` in "${auth.team}"` : ''} — DM her an intake photo.`);
    return true;
  } catch (err) {
    console.warn(`  Slack: failed to start — ${(err as Error).message}`);
    return false;
  }
}

async function handleMessage(
  msg: IncomingMessage,
  web: WebClient,
  botUserId: string,
  botToken: string,
  sim?: Simulation,
): Promise<void> {
  if (msg.bot_id || msg.subtype === 'bot_message') return; // never answer bots (or herself)
  if (msg.subtype && msg.subtype !== 'file_share') return; // ignore edits, joins, deletions…
  const isDm = msg.channel_type === 'im';
  const mentioned = botUserId !== '' && (msg.text || '').includes(`<@${botUserId}>`);
  if (!isDm && !mentioned) return; // in channels/group DMs she only acts when @mentioned
  if (alreadyHandled(msg)) return;

  const thread = msg.thread_ts || msg.ts;
  const post = async (text: string): Promise<void> => {
    await web.chat.postMessage({ channel: msg.channel, thread_ts: thread, text });
  };

  const photos = (msg.files || []).filter(isIntakePhoto);
  if (photos.length === 0) {
    if ((msg.files || []).length > 0) {
      await post('I can only read *photos* of intake forms for now — JPG, PNG, WebP, or GIF. Mind re-sending it as one of those? 📋');
      return;
    }
    // Text-only message → a short in-character reply (canned when the LLM is unavailable).
    const question = (msg.text || '').replace(/<@[^>]+>/g, '').trim();
    let reply = HELP_REPLY;
    if (question) {
      try {
        reply = (await llm.complete({ system: TESSA_SYSTEM, user: question, maxTokens: 300 })).trim() || HELP_REPLY;
      } catch {
        reply = HELP_REPLY;
      }
    }
    await post(reply);
    return;
  }

  for (const photo of photos) {
    await runIntake(photo, msg, post, web, botToken, sim);
  }
}

type PostFn = (text: string) => Promise<void>;

/** One intake, narrated in-thread: download → extract → fill → upload docs →
 *  email → file to CRM. Mirrors simulation.handleIntake, with Slack as the stage. */
async function runIntake(
  file: SlackFile,
  msg: IncomingMessage,
  post: PostFn,
  web: WebClient,
  botToken: string,
  sim?: Simulation,
): Promise<void> {
  const filename = file.name || 'intake.jpg';
  const thread = msg.thread_ts || msg.ts;
  try {
    await post(`📋 On it — reading *${filename}*…`);
    sim?.mirrorSlackIntake('received', filename);

    if ((file.size || 0) > MAX_IMAGE_BYTES) {
      await post('That photo is over 5MB — more than I can read in one gulp. Could you send a smaller copy? (A screenshot of it works great.)');
      sim?.mirrorSlackIntake('failed', `${filename} was too large`);
      return;
    }

    const resp = await fetch(file.url_private_download!, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!resp.ok) throw new Error(`could not download the file from Slack (HTTP ${resp.status})`);
    const imageB64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
    const mediaType = file.mimetype || 'image/jpeg';

    const fields = await llm.extractIntakeFields(imageB64, mediaType);
    await post(fieldSummary(fields));

    const docs = fillTemplates(fields);
    await uploadDocs(web, msg.channel, thread, docs);

    const mail = await emailIntake(fields, docs);
    await post(
      mail.sent
        ? `📧 Emailed both documents to *${mail.to}*${mail.id ? ` _(Resend ${mail.id})_` : ''}.`
        : `📧 Documents drafted, but I didn't email them — ${mail.reason}`,
    );

    const crm = await fileIntakeToCrm(fields, docs, { base64: imageB64, mediaType, filename });
    await post(
      crm.ok
        ? `📁 Bram filed it into Atlas PA — ${crm.created ? 'created new claim' : 'added to existing claim'} *${crm.claimId}*. ✅ All done!`
        : `📁 Atlas PA filing skipped — ${crm.reason} ✅ Everything else is done!`,
    );
    sim?.mirrorSlackIntake('done', fields.insured_name || filename);
  } catch (err) {
    const reason = err instanceof llm.LlmUnavailableError ? err.reason : 'api_error';
    const why =
      reason === 'no_key'
        ? 'my reading glasses are missing — the server has no ANTHROPIC_API_KEY.'
        : reason === 'auth'
          ? 'the Anthropic API key was rejected.'
          : reason === 'rate_limit_local'
            ? "I'm a bit overwhelmed right now — try again in a minute."
            : `something went wrong: ${(err as Error).message}`;
    await post(`⚠️ Hmm — ${why}`).catch(() => {});
    sim?.mirrorSlackIntake('failed', (err as Error).message);
  }
}

async function uploadDocs(web: WebClient, channel: string, thread: string, docs: FilledDoc[]): Promise<void> {
  await web.files.uploadV2({
    channel_id: channel,
    thread_ts: thread,
    initial_comment: '📝 Drafted and ready for review:',
    file_uploads: docs.map((d) => ({ file: d.content, filename: d.filename })),
  });
}
