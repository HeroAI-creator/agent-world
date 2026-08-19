// Tessa on Slack — a Socket Mode bot that runs the Armada intake pipeline.
//
// DM Tessa an intake as a photo/PDF of the form — or a RECORDING of the
// intake phone call (dictation: Whisper transcribes, Claude extracts, and a
// fresh Intake Sheet is generated since there's no paper form). Either way
// the Welcome Letter + Notice to Insurance are filled and uploaded straight
// back into the conversation for review (right in the chat for DMs; in a
// thread when in a channel), and the intake is filed into Atlas PA. Nothing
// is emailed — the documents stay in Slack (unlike the in-game upload panel,
// which emails the firm via Resend). Text-only DMs get a short reply.
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
import { fillIntakeSheet, fillTemplates, fileIntakeToCrm, type FilledDoc } from './intake.js';
import { transcribeAudio, transcriptionConfigured } from './transcribe.js';
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
const PDF_TYPE = 'application/pdf';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic's per-image ceiling
const MAX_PDF_BYTES = 10 * 1024 * 1024; // stays well under the API's 32MB request cap
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // Groq Whisper's upload ceiling is 25MB

const TESSA_SYSTEM = `You are Tessa, Armada Public Adjusting's intake agent, chatting in Slack. Warm, competent, brief — 1 to 3 short sentences, the occasional emoji. Your one job: when someone sends a PHOTO or PDF of a claim intake form — or a RECORDING of the intake phone call — you read or listen to it, fill the intake sheet, draft the Welcome Letter and the Notice to Insurance, drop them back into the chat, and file the claim into the Atlas PA CRM. If asked anything else, answer briefly and remind them you're happiest when handed an intake.`;

const HELP_REPLY =
  "Hi! I'm Tessa 📋 Send me an intake as a *photo or PDF* of the form — or a *recording of the intake call* 🎧 — and I'll fill the intake sheet, draft the Welcome Letter + Notice to Insurance right here in the chat, and file the claim into Atlas PA.";

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

function isIntakeFile(f: SlackFile): boolean {
  const mt = f.mimetype || '';
  return (IMAGE_TYPES.has(mt) || mt === PDF_TYPE) && Boolean(f.url_private_download);
}

/** Call recordings and voice notes: m4a, mp3, wav, ogg/opus, webm, aac, amr… */
function isIntakeAudio(f: SlackFile): boolean {
  return (f.mimetype || '').startsWith('audio/') && Boolean(f.url_private_download);
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

  // In a DM she talks straight into the chat; in channels she keeps each
  // intake in a tidy thread under the @mention instead of flooding the room.
  const thread = isDm ? msg.thread_ts : msg.thread_ts || msg.ts;
  const post = async (text: string): Promise<void> => {
    await web.chat.postMessage({ channel: msg.channel, ...(thread ? { thread_ts: thread } : {}), text });
  };

  const audioFiles = (msg.files || []).filter(isIntakeAudio);
  const intakeFiles = (msg.files || []).filter(isIntakeFile);
  if (intakeFiles.length === 0 && audioFiles.length === 0) {
    if ((msg.files || []).length > 0) {
      await post('I can take intakes as *photos or PDFs* of the form (JPG, PNG, WebP, GIF, PDF) — or a *call recording* (m4a, mp3, wav, voice note). Mind re-sending one of those? 📋');
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

  for (const intakeFile of intakeFiles) {
    await runIntake(intakeFile, msg, post, web, botToken, thread, sim);
  }
  for (const audio of audioFiles) {
    await runAudioIntake(audio, msg, post, web, botToken, thread, sim);
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
  thread: string | undefined,
  sim?: Simulation,
): Promise<void> {
  const filename = file.name || 'intake.jpg';
  try {
    await post(`📋 On it — reading *${filename}*…`);
    sim?.mirrorSlackIntake('received', filename);

    const isPdf = file.mimetype === PDF_TYPE;
    if ((file.size || 0) > (isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) {
      await post(`That file is over ${isPdf ? '10MB' : '5MB'} — more than I can read in one gulp. Could you send a smaller copy? (A screenshot of it works great.)`);
      sim?.mirrorSlackIntake('failed', `${filename} was too large`);
      return;
    }

    const resp = await fetch(file.url_private_download!, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!resp.ok) throw new Error(`could not download the file from Slack (HTTP ${resp.status})`);
    const fileB64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
    const mediaType = file.mimetype || 'image/jpeg';

    const fields = await llm.extractIntakeFields(fileB64, mediaType);
    await post(fieldSummary(fields));

    const docs = fillTemplates(fields);
    await uploadDocs(web, msg.channel, thread, docs);

    const crm = await fileIntakeToCrm(fields, docs, { base64: fileB64, mediaType, filename });
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

/** Dictation intake: a recording of the homeowner <-> front desk call comes in,
 *  Whisper writes the transcript, Claude pulls the fields, and Tessa fills the
 *  Intake Sheet + Welcome Letter + carrier Notice and files it all — same
 *  finish line as a photo intake, no paper form required. */
async function runAudioIntake(
  file: SlackFile,
  msg: IncomingMessage,
  post: PostFn,
  web: WebClient,
  botToken: string,
  thread: string | undefined,
  sim?: Simulation,
): Promise<void> {
  const filename = file.name || 'call-recording.m4a';
  try {
    if (!transcriptionConfigured()) {
      await post("I got the recording, but my ears aren't set up yet — the server needs a GROQ_API_KEY (free at console.groq.com/keys) before I can transcribe calls. 🎧");
      return;
    }
    await post(`🎧 Got the recording — listening to *${filename}*… (a longer call takes a minute)`);
    sim?.mirrorSlackIntake('received', filename);

    if ((file.size || 0) > MAX_AUDIO_BYTES) {
      await post('That recording is over 24MB — more than I can transcribe in one go. Could you trim or re-export it a bit smaller?');
      sim?.mirrorSlackIntake('failed', `${filename} was too large`);
      return;
    }

    const resp = await fetch(file.url_private_download!, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!resp.ok) throw new Error(`could not download the file from Slack (HTTP ${resp.status})`);
    const audio = Buffer.from(await resp.arrayBuffer());

    const transcript = await transcribeAudio(audio, filename, file.mimetype || 'audio/mpeg');

    const { fields, extras, callNotes } = await llm.extractIntakeFromTranscript(transcript);
    await post(fieldSummary(fields) + (callNotes ? `\n🗒️ *Call notes:* ${callNotes}` : ''));

    const docs = [fillIntakeSheet(fields, extras, callNotes, filename), ...fillTemplates(fields)];
    const transcriptDoc: FilledDoc = {
      filename: `Call Transcript - ${fields.insured_name || 'intake'}.txt`,
      content: Buffer.from(transcript, 'utf8'),
    };
    await uploadDocs(web, msg.channel, thread, [...docs, transcriptDoc]);

    const crm = await fileIntakeToCrm(fields, docs, {
      base64: audio.toString('base64'),
      mediaType: file.mimetype || 'audio/mpeg',
      filename,
    });
    await post(
      crm.ok
        ? `📁 Bram filed it into Atlas PA — ${crm.created ? 'created new claim' : 'added to existing claim'} *${crm.claimId}* (recording attached). ✅ All done!`
        : `📁 Atlas PA filing skipped — ${crm.reason} ✅ Everything else is done!`,
    );
    sim?.mirrorSlackIntake('done', fields.insured_name || filename);
  } catch (err) {
    const reason = err instanceof llm.LlmUnavailableError ? err.reason : '';
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

async function uploadDocs(web: WebClient, channel: string, thread: string | undefined, docs: FilledDoc[]): Promise<void> {
  await web.files.uploadV2({
    channel_id: channel,
    ...(thread ? { thread_ts: thread } : {}),
    initial_comment: '📝 Drafted and ready for review:',
    file_uploads: docs.map((d) => ({ file: d.content, filename: d.filename })),
  });
}
