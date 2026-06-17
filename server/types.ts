// Shared message + state types for the simulation server.
// The client keeps a small mirrored copy in client/src/types.ts.

export interface Point {
  x: number;
  y: number;
}

export type ActionKind = 'move_to' | 'talk_to' | 'rest' | 'work' | 'wander';

export type AgentRuntimeState = 'idle' | 'acting' | 'talking' | 'crossing_bridge';

/** Facing direction, used to pick the walk frames. */
export type Dir = 'down' | 'left' | 'right' | 'up';

export type TaskStatus = 'todo' | 'doing' | 'done';

/** An assignment given to an agent by the user (the Overseer). */
export interface Task {
  text: string;
  status: TaskStatus;
  assignedTick: number;
  /** Short progress note (agent's latest relevant thought, or completion note). */
  note?: string;
}

export interface AgentSnapshot {
  id: string;
  name: string;
  /** Feet/bottom-center position in BACKGROUND PIXELS (not grid cells). */
  px: number;
  py: number;
  energy: number;
  state: AgentRuntimeState;
  action: ActionKind | null;
  target: string | null;
  dir: Dir;
  facing: 1 | -1;
  /** Latest inner-monologue line, for the dashboard "what they're doing" view. */
  lastThought: string;
  task: Task | null;
}

export type LogKind = 'thought' | 'action' | 'speech' | 'observe' | 'system' | 'warn';

export interface LogEvent {
  ts: number;
  agentId?: string;
  name?: string;
  color?: string;
  icon: string;
  text: string;
  kind: LogKind;
}

export interface LlmStats {
  calls: number;
  callsPerMin: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}

export interface DecisionResult {
  thought: string;
  action: ActionKind;
  target: string | null;
  duration_ticks: number;
  task_done?: boolean;
}

export interface ConversationScript {
  lines: Array<{ speaker: string; text: string }>;
  summaries: Record<string, string>;
}

// ---- WebSocket messages (server -> client) ----

export interface GridInfo {
  cols: number;
  rows: number;
  cellPx: number;
  blocked: Array<{ x: number; y: number; w: number; h: number; label: string }>;
}

export interface InitMsg {
  type: 'init';
  grid: GridInfo;
  locations: Array<{ name: string; x: number; y: number; radius: number }>;
  /** Bridge crossing waypoints in BACKGROUND PIXELS, for the debug overlay. */
  bridgePath: Point[];
  agents: Array<{
    id: string;
    name: string;
    color: string;
    outfit: Record<string, string>;
    persona: string;
    px: number;
    py: number;
  }>;
  tickMs: number;
  speed: number;
  paused: boolean;
  tick: number;
  day: number;
  clock: string;
  timeOfDay: string;
  model: string;
  hasKey: boolean;
  stats: LlmStats;
}

export interface TickMsg {
  type: 'tick';
  tick: number;
  /** Virtual day number (1-based) and HH:MM clock that resets each day. */
  day: number;
  clock: string;
  timeOfDay: string;
  agents: AgentSnapshot[];
}

export interface LogMsg {
  type: 'log';
  event: LogEvent;
}

export interface BubbleMsg {
  type: 'bubble';
  agentId: string;
  text: string;
  durationMs: number;
}

export interface StatsBroadcast {
  type: 'stats';
  stats: LlmStats;
}

export interface ControlMsg {
  type: 'control';
  paused: boolean;
  speed: number;
}

export type ServerMsg = InitMsg | TickMsg | LogMsg | BubbleMsg | StatsBroadcast | ControlMsg;

// ---- WebSocket messages (client -> server) ----

export interface ClientControlMsg {
  type: 'control';
  action: 'toggle_pause' | 'set_speed';
  value?: number;
}

export interface ClientTaskMsg {
  type: 'task';
  action: 'assign' | 'clear';
  agentId: string;
  text?: string;
}

export interface ClientChatMsg {
  type: 'chat';
  /** An agent id, or 'all' to address the whole village. */
  target: string;
  text: string;
}

/** An intake photo handed to Tessa: base64 image data (no data: prefix) + mime. */
export interface ClientIntakeMsg {
  type: 'intake';
  dataB64: string;
  mediaType: string;
  filename: string;
}

export type ClientMsg = ClientControlMsg | ClientTaskMsg | ClientChatMsg | ClientIntakeMsg;

// ---- Armada intake extraction ----

/** Fields read off an Armada Public Adjusting claim intake form. All strings;
 *  "" when the field isn't present on the form (never null, to keep templating simple). */
export interface IntakeFields {
  insured_name: string;
  loss_address: string;
  policy_number: string;
  claim_number: string;
  date_of_loss: string;
  cause_of_loss: string;
  carrier: string;
  phone: string;
  email: string;
}

// ---- Mira scheduling agent ----

/** One stop parsed from the text the user pastes to Mira. */
export interface Appointment {
  /** Client name / label for the visit ('' if none given). */
  title: string;
  /** Street address of the stop (required to route it). */
  address: string;
  /** Date, normalized to YYYY-MM-DD when the year is clear, else as written, else ''. */
  date: string;
  /** Fixed start time as 24h HH:MM if the user specified one, else ''. */
  time: string;
  /** Visit length in minutes if stated, else 0 (a default is applied when scheduling). */
  durationMin: number;
}
