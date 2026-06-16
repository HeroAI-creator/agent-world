// Agent: state, memory, and seed loading. Behavior lives in simulation.ts.
//
// Position is float PIXELS (px, py) = the agent's feet/bottom-center, matching
// how the client draws sprites. The grid cell is derived on demand for
// pathfinding and observations.

import { readFileSync } from 'node:fs';
import type { Mover } from './movement.js';
import type { ActionKind, AgentRuntimeState, AgentSnapshot, Dir, Point, Task } from './types.js';

export interface AgentSeed {
  id: string;
  name: string;
  color: string;
  outfit: Record<string, string>;
  persona: string;
  spawn: string;
  seedMemories: string[];
}

export interface CurrentAction {
  kind: ActionKind;
  /** Location or villager name, for logs and the status display. */
  targetName: string | null;
  targetAgentId?: string;
  /** Ticks left for rest / work / wander (counts down once any walking is done). */
  remaining: number;
  chaseTicks?: number;
  /** For move_to/work across the river: index range in `path` that is the bridge. */
  crossSegment?: { start: number; end: number };
  /** True if this action was started to fulfill the agent's assigned task. */
  fulfillsTask?: boolean;
}

const MEMORY_CAP = 30;

export class Agent implements Mover {
  // feet/bottom-center position in pixels
  px: number;
  py: number;
  dir: Dir = 'down';

  energy = 90;
  state: AgentRuntimeState = 'idle';
  currentAction: CurrentAction | null = null;
  memories: string[] = [];

  /** Latest inner-monologue line (for the dashboard). */
  lastThought = '';
  /** User-assigned task, or null. */
  task: Task | null = null;

  // movement: a polyline of pixel waypoints the agent is walking, consumed by followPath
  path: Point[] = [];
  pathIndex = 0;

  // Decision plumbing — guarded by a token so stale LLM responses are dropped
  // when a conversation or forced rest interrupts the agent mid-request.
  needsDecision = true;
  decideAtTick = 0;
  pendingDecision = false;
  decisionToken = 0;

  /** Agent ids currently within observation radius (for enter/leave detection). */
  nearbyIds = new Set<string>();

  constructor(
    readonly seed: AgentSeed,
    spawnPx: Point,
    private readonly cellPx: number,
  ) {
    this.px = spawnPx.x;
    this.py = spawnPx.y;
    for (const m of seed.seedMemories) this.memories.push(m);
  }

  get id(): string {
    return this.seed.id;
  }
  get name(): string {
    return this.seed.name;
  }
  get persona(): string {
    return this.seed.persona;
  }
  get color(): string {
    return this.seed.color;
  }

  /** Current grid cell (derived from the pixel position). */
  get cell(): Point {
    return {
      x: Math.max(0, Math.round((this.px - this.cellPx / 2) / this.cellPx)),
      y: Math.max(0, Math.round((this.py - this.cellPx / 2) / this.cellPx)),
    };
  }

  /** True once the current movement path is fully consumed. */
  get pathDone(): boolean {
    return this.pathIndex >= this.path.length;
  }

  setPath(waypoints: Point[]): void {
    this.path = waypoints;
    this.pathIndex = 0;
  }

  clearPath(): void {
    this.path = [];
    this.pathIndex = 0;
  }

  addMemory(tick: number, text: string): void {
    this.memories.push(`[t${tick}] ${text}`);
    while (this.memories.length > MEMORY_CAP) this.memories.shift();
  }

  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      name: this.name,
      px: Math.round(this.px),
      py: Math.round(this.py),
      energy: Math.round(this.energy),
      state: this.state,
      action: this.currentAction?.kind ?? null,
      target: this.currentAction?.targetName ?? null,
      dir: this.dir,
      facing: this.dir === 'left' ? -1 : 1,
      lastThought: this.lastThought,
      task: this.task ? { ...this.task } : null,
    };
  }
}

export function loadAgentSeeds(): AgentSeed[] {
  const raw = readFileSync(new URL('./agents.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { agents: AgentSeed[] };
  if (!Array.isArray(parsed.agents) || parsed.agents.length === 0) {
    throw new Error('agents.json must contain a non-empty "agents" array');
  }
  return parsed.agents;
}
