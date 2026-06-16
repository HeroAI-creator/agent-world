// All prompt templates in one place, plus the defensive parsers for their outputs.
// Decisions and conversations both demand bare JSON; parsing stays defensive anyway.

import type { ActionKind, ConversationScript, DecisionResult } from './types.js';

export function decisionSystem(
  name: string,
  persona: string,
  locationNames: string[],
  otherNames: string[],
): string {
  return `You are ${name}, a character in the small pixel village of Eldermoor. ${persona}

The village places are: ${locationNames.join(', ')}.
The other villagers are: ${otherNames.join(', ')}.

You decide your next action. Respond ONLY with a single JSON object — no prose, no markdown fences:
{"thought": "<one short sentence of inner monologue, in character>",
 "action": "<one of: move_to | talk_to | rest | work | wander>",
 "target": "<a place name for move_to/work, a villager name for talk_to, or null>",
 "duration_ticks": <integer 3-15>,
 "task_done": <true only if you have just finished your assignment, else omit or false>}

Rules:
- move_to walks to a place. work means doing something useful (tending, building, selling, gathering) — target the place to work at.
- talk_to walks to that villager and starts a conversation. Do this when you have something to say, ask, or scheme about.
- rest restores energy; do it when energy is low, ideally at the Cottage or Campfire.
- wander is an aimless stroll near where you are.
- If you have an ASSIGNMENT, prioritize it; set task_done:true once you've essentially completed it.
- Vary your behavior, pursue your goals, and react to your memories.`;
}

export interface DecisionContext {
  tick: number;
  timeOfDay: string;
  place: string;
  energy: number;
  nearby: string;
  memories: string[];
  task?: string | null;
}

export function decisionUser(ctx: DecisionContext): string {
  const memoryLines = ctx.memories.length
    ? ctx.memories.map((m) => `- ${m}`).join('\n')
    : '- (nothing notable yet)';
  const exhausted = ctx.energy < 25 ? '\nYou feel exhausted and should rest soon.' : '';
  const assignment = ctx.task ? `\nASSIGNMENT from the Overseer: ${ctx.task}\n` : '';
  return `Time: ${ctx.timeOfDay}
You are at: ${ctx.place}
Energy: ${Math.round(ctx.energy)}/100${exhausted}
Nearby: ${ctx.nearby}${assignment}
Recent memories (newest last):
${memoryLines}
What do you do next?`;
}

export function overseerReplySystem(name: string, persona: string): string {
  return `You are ${name}, a villager in the pixel village of Eldermoor. ${persona}
The Overseer — an unseen guiding presence the villagers can hear — speaks to you directly.
Reply in character, briefly (1-2 short sentences). You may agree, push back, ask a question, or react.
Respond ONLY with a single JSON object — no prose, no markdown fences:
{"reply": "<your spoken response, max 160 characters>"}`;
}

export function overseerReplyUser(message: string, memories: string[]): string {
  const mem = memories.length ? memories.slice(-5).join(' | ') : 'nothing notable';
  return `Recent memories: ${mem}

The Overseer says to you: "${message}"

Reply:`;
}

export function conversationSystem(): string {
  return `You write short, characterful dialogue between villagers in a cozy pixel village.
Respond ONLY with a single JSON object — no prose, no markdown fences:
{"lines": [{"speaker": "<name>", "text": "<one spoken line, max 130 characters>"}, ...],
 "summaries": {"<name A>": "<one-line memory A keeps>", "<name B>": "<one-line memory B keeps>"}}
Write 2 to 4 lines total, alternating naturally. Keep each voice distinct and let their goals collide a little.`;
}

export interface Speaker {
  name: string;
  persona: string;
  energy: number;
  memories: string[];
}

export function conversationUser(a: Speaker, b: Speaker, place: string, timeOfDay: string, pastSummary: string | null): string {
  const mem = (s: Speaker) => (s.memories.length ? s.memories.slice(-5).join(' | ') : 'nothing notable');
  const history = pastSummary ? `\nLast time they spoke: ${pastSummary}` : '';
  return `${a.name} and ${b.name} bump into each other at the ${place} (${timeOfDay}).${history}

${a.name}: ${a.persona} Energy ${Math.round(a.energy)}/100. Recent memories: ${mem(a)}
${b.name}: ${b.persona} Energy ${Math.round(b.energy)}/100. Recent memories: ${mem(b)}

${a.name} started the conversation. Write the exchange.`;
}

// ---- Defensive parsing ----

/** Pull the first JSON object out of model text, tolerating markdown fences and stray prose. */
export function extractJsonObject(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

const ACTIONS: ActionKind[] = ['move_to', 'talk_to', 'rest', 'work', 'wander'];

export function parseDecision(raw: string): DecisionResult | null {
  const obj = extractJsonObject(raw) as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return null;
  const action = ACTIONS.includes(obj.action as ActionKind) ? (obj.action as ActionKind) : null;
  if (!action) return null;
  const durationNum = Math.round(Number(obj.duration_ticks));
  const duration = Number.isFinite(durationNum) ? Math.min(15, Math.max(3, durationNum)) : 6;
  const thought =
    typeof obj.thought === 'string' && obj.thought.trim() ? obj.thought.trim().slice(0, 220) : '(a wordless impulse)';
  const target =
    typeof obj.target === 'string' && obj.target.trim() && obj.target.trim().toLowerCase() !== 'null'
      ? obj.target.trim()
      : null;
  return { thought, action, target, duration_ticks: duration, task_done: obj.task_done === true };
}

/** Parse an overseer reply: {"reply": "..."} → the spoken line, or null. */
export function parseReply(raw: string): string | null {
  const obj = extractJsonObject(raw) as { reply?: unknown } | null;
  if (obj && typeof obj.reply === 'string' && obj.reply.trim()) return obj.reply.trim().slice(0, 200);
  // tolerate a bare string response
  const t = raw.trim().replace(/^["']|["']$/g, '');
  return t && !t.startsWith('{') ? t.slice(0, 200) : null;
}

export function parseConversation(raw: string, nameA: string, nameB: string): ConversationScript | null {
  const obj = extractJsonObject(raw) as { lines?: unknown; summaries?: unknown } | null;
  if (!obj || !Array.isArray(obj.lines) || obj.lines.length === 0) return null;
  const lines = (obj.lines as Array<{ speaker?: unknown; text?: unknown }>)
    .slice(0, 4)
    .map((l, i) => ({
      speaker: typeof l?.speaker === 'string' && l.speaker.trim() ? l.speaker.trim() : i % 2 === 0 ? nameA : nameB,
      text: String(l?.text ?? '')
        .trim()
        .slice(0, 160),
    }))
    .filter((l) => l.text.length > 0);
  if (lines.length === 0) return null;
  const summaries: Record<string, string> = {};
  if (obj.summaries && typeof obj.summaries === 'object') {
    for (const [k, v] of Object.entries(obj.summaries as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) summaries[k] = v.trim().slice(0, 200);
    }
  }
  return { lines, summaries };
}
