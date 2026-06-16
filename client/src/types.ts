// Client-side mirror of the server's WebSocket message shapes
// (kept in sync by hand with server/types.ts — small enough for v1).

export interface Point {
  x: number;
  y: number;
}

export type ActionKind = 'move_to' | 'talk_to' | 'rest' | 'work' | 'wander';

export type Dir = 'down' | 'left' | 'right' | 'up';

export type TaskStatus = 'todo' | 'doing' | 'done';

export interface Task {
  text: string;
  status: TaskStatus;
  assignedTick: number;
  note?: string;
}

export interface AgentSnapshot {
  id: string;
  name: string;
  /** Feet/bottom-center position in background pixels. */
  px: number;
  py: number;
  energy: number;
  state: 'idle' | 'acting' | 'talking' | 'crossing_bridge';
  action: ActionKind | null;
  target: string | null;
  dir: Dir;
  facing: 1 | -1;
  lastThought: string;
  task: Task | null;
}

export interface AgentInfo {
  id: string;
  name: string;
  color: string;
  outfit: Record<string, string>;
  persona: string;
  px: number;
  py: number;
}

export interface LogEvent {
  ts: number;
  agentId?: string;
  name?: string;
  color?: string;
  icon: string;
  text: string;
  kind: 'thought' | 'action' | 'speech' | 'observe' | 'system' | 'warn';
}

export interface LlmStats {
  calls: number;
  callsPerMin: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}

export interface GridInfo {
  cols: number;
  rows: number;
  cellPx: number;
  blocked: Array<{ x: number; y: number; w: number; h: number; label: string }>;
}

export interface InitData {
  type: 'init';
  grid: GridInfo;
  locations: Array<{ name: string; x: number; y: number; radius: number }>;
  bridgePath: Point[];
  agents: AgentInfo[];
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
  day: number;
  clock: string;
  timeOfDay: string;
  agents: AgentSnapshot[];
}

export interface BubbleMsg {
  type: 'bubble';
  agentId: string;
  text: string;
  durationMs: number;
}

export type ServerMsg =
  | InitData
  | TickMsg
  | { type: 'log'; event: LogEvent }
  | BubbleMsg
  | { type: 'stats'; stats: LlmStats }
  | { type: 'control'; paused: boolean; speed: number };
