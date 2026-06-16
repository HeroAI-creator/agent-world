// The tick loop: movement, energy, observations, LLM decision scheduling,
// and conversations. One tick advances each agent SPEED pixels along its
// current path (the client tweens between snapshots for smoothness).
//
// Movement is uniform: every route is a polyline of pixel waypoints walked by
// followPath() — ordinary trips come from A* (cell centers → pixels), and a
// trip to the far bank of the river splices in the scripted BRIDGE path so the
// agent crosses cleanly on the planks instead of wandering onto the water.

import { Agent, type CurrentAction } from './agent.js';
import * as llm from './llm.js';
import { cellsToPixels, followPath, getDirectionFromDelta } from './movement.js';
import {
  conversationSystem,
  conversationUser,
  decisionSystem,
  decisionUser,
  parseConversation,
  parseDecision,
} from './prompts.js';
import { overseerReplySystem, overseerReplyUser, parseReply } from './prompts.js';
import type { DecisionResult, LogEvent, LogKind, Point, ServerMsg } from './types.js';
import type { LocationCfg, RiverSide, World } from './world.js';

const DAY_REAL_MS = 4 * 60 * 60 * 1000; // 4 real hours = 1 virtual day (at 1x speed)
const DAY_START_HOUR = 6; // virtual day begins at 06:00 (clock resets here)
const ENERGY_DECAY = 0.3; // per tick while awake
const REST_RECOVERY = 5; // per tick while resting
const WORK_DRAIN = 0.5; // extra per tick while working
const EXHAUSTION_FLOOR = 5; // forced rest below this
const OBSERVE_RADIUS_CELLS = 5; // cells for noticing someone
const PURSUIT_LIMIT = 40; // ticks chasing a talk_to target before giving up
const PAIR_COOLDOWN_TICKS = 80; // same pair can't restart a chat for this long
const CONVO_LINE_EVERY = 2; // ticks between spoken lines

interface ActiveConversation {
  aId: string;
  bId: string;
  place: string;
  lines: Array<{ speakerId: string; text: string }>;
  summaries: Map<string, string>;
  lineIdx: number;
  nextLineAt: number;
  pending: boolean;
}

export class Simulation {
  tick = 0;
  paused = false;
  speed = 1;

  private readonly stepPx: number; // pixels advanced per tick (= one cell)
  private readonly observeRadiusPx: number;
  readonly dayTicks: number; // ticks per virtual day (4 real hours at 1x)
  private timer: NodeJS.Timeout | null = null;
  private conversations: ActiveConversation[] = [];
  private pairCooldown = new Map<string, number>();
  private pairHistory = new Map<string, string>();
  private lastLlmWarnTick = new Map<string, number>();

  constructor(
    readonly world: World,
    readonly agents: Agent[],
    private readonly send: (msg: ServerMsg) => void,
    readonly tickMs: number,
  ) {
    this.stepPx = world.cellPx;
    this.observeRadiusPx = OBSERVE_RADIUS_CELLS * world.cellPx;
    // Scale the virtual day to "4 real hours" at the configured tick rate (1x).
    this.dayTicks = Math.max(8, Math.round(DAY_REAL_MS / this.tickMs));
  }

  start(): void {
    this.agents.forEach((a, i) => {
      a.decideAtTick = 2 + i * 3; // stagger first decisions so we don't burst API calls
    });
    this.log({ icon: '⭐', kind: 'system', text: 'Simulation started. Villagers are waking up…' });
    this.scheduleNext();
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      if (!this.paused) this.step();
      this.scheduleNext();
    }, this.tickMs / this.speed);
  }

  togglePause(): void {
    this.paused = !this.paused;
    this.log({ icon: '⭐', kind: 'system', text: this.paused ? 'Simulation paused — API spend frozen.' : 'Simulation resumed.' });
    this.send({ type: 'control', paused: this.paused, speed: this.speed });
  }

  setSpeed(value: number): void {
    const allowed = [0.5, 1, 2];
    if (!allowed.includes(value) || value === this.speed) return;
    this.speed = value;
    this.log({ icon: '⭐', kind: 'system', text: `Speed set to ${value}x.` });
    this.send({ type: 'control', paused: this.paused, speed: this.speed });
  }

  /** Virtual clock derived from the tick: day number, HH:MM (resets daily), and band. */
  clockInfo(): { day: number; clock: string; timeOfDay: string } {
    const day = Math.floor(this.tick / this.dayTicks) + 1;
    const frac = (this.tick % this.dayTicks) / this.dayTicks; // 0..1 through the day
    const hour24 = (DAY_START_HOUR + frac * 24) % 24;
    const hh = Math.floor(hour24);
    const mm = Math.floor((hour24 - hh) * 60);
    const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    const timeOfDay = hh < 5 ? 'night' : hh < 11 ? 'morning' : hh < 17 ? 'midday' : hh < 21 ? 'evening' : 'night';
    return { day, clock, timeOfDay };
  }

  timeOfDay(): string {
    return this.clockInfo().timeOfDay;
  }

  private step(): void {
    this.tick++;
    this.advanceConversations();
    for (const agent of this.agents) this.stepAgent(agent);
    for (const agent of this.agents) {
      if (agent.needsDecision && !agent.pendingDecision && agent.state !== 'talking' && this.tick >= agent.decideAtTick) {
        void this.decide(agent);
      }
    }
    const c = this.clockInfo();
    this.send({
      type: 'tick',
      tick: this.tick,
      day: c.day,
      clock: c.clock,
      timeOfDay: c.timeOfDay,
      agents: this.agents.map((a) => a.snapshot()),
    });
    if (this.tick % 10 === 0) this.send({ type: 'stats', stats: llm.getStats() });
  }

  // ---- per-agent tick ----

  private stepAgent(a: Agent): void {
    if (a.state === 'talking') return;

    const act = a.currentAction;
    const restingInPlace = act?.kind === 'rest' && a.pathDone;
    const workingInPlace = act?.kind === 'work' && a.pathDone;
    if (restingInPlace) a.energy = Math.min(100, a.energy + REST_RECOVERY);
    else a.energy = Math.max(0, a.energy - ENERGY_DECAY - (workingInPlace ? WORK_DRAIN : 0));

    if (a.energy <= EXHAUSTION_FLOOR && !restingInPlace) {
      a.decisionToken++;
      a.clearPath();
      a.currentAction = { kind: 'rest', targetName: this.world.locationNameAt(a.cell), remaining: 25 };
      a.needsDecision = false;
      a.state = 'acting';
      this.log({ agent: a, icon: '😴', kind: 'action', text: 'is completely exhausted and collapses into a rest (25 ticks)' });
      a.addMemory(this.tick, 'Pushed too hard and had to collapse into a rest.');
      return;
    }

    if (!act) {
      a.state = 'idle';
      a.needsDecision = true;
      this.observe(a);
      return;
    }

    // Per-kind upkeep: ensure a path exists (wander hops, talk chasing) or run timers.
    switch (act.kind) {
      case 'wander':
        if (this.tickWander(a, act)) return;
        break;
      case 'talk_to':
        if (this.tickTalk(a, act)) return;
        break;
      case 'rest':
      case 'work':
        if (a.pathDone) {
          act.remaining--;
          if (act.remaining <= 0) {
            this.completeAction(a, act);
            this.observe(a);
            return;
          }
        }
        break;
      case 'move_to':
        break;
    }

    // Advance along the current path.
    if (!a.pathDone) {
      followPath(a, a.path, this.stepPx);
      a.state =
        act.crossSegment && a.pathIndex >= act.crossSegment.start && a.pathIndex < act.crossSegment.end
          ? 'crossing_bridge'
          : 'acting';
      if (a.pathDone) this.onArrival(a, act);
    } else if (act.kind === 'move_to') {
      this.onArrival(a, act);
    }

    this.observe(a);
  }

  /** Returns true if the agent's tick is fully handled (completed). */
  private tickWander(a: Agent, act: CurrentAction): boolean {
    act.remaining--;
    if (act.remaining <= 0) {
      this.completeAction(a, act, true);
      this.observe(a);
      return true;
    }
    if (a.pathDone) {
      const target = this.world.randomNear(a.cell, 7);
      const cells = this.world.findPath(a.cell, target);
      if (cells && cells.length) a.setPath(cellsToPixels(cells, this.world.cellPx));
    }
    return false;
  }

  /** Returns true if the agent's tick is fully handled. */
  private tickTalk(a: Agent, act: CurrentAction): boolean {
    const target = this.agents.find((t) => t.id === act.targetAgentId);
    if (!target) {
      this.completeAction(a, act, true);
      this.observe(a);
      return true;
    }
    const distPx = Math.hypot(a.px - target.px, a.py - target.py);
    if (distPx <= 1.5 * this.world.cellPx) {
      a.clearPath();
      this.tryStartConversation(a, target);
      return true;
    }
    act.chaseTicks = (act.chaseTicks ?? 0) + 1;
    if (act.chaseTicks > PURSUIT_LIMIT) {
      a.addMemory(this.tick, `Tried to catch ${target.name} for a chat but couldn't.`);
      this.log({ agent: a, icon: '💨', kind: 'action', text: `gives up trying to catch ${target.name}` });
      this.completeAction(a, act);
      this.observe(a);
      return true;
    }
    // Re-path toward the (possibly moving) target each tick.
    const path = this.world.pathToAdjacent(a.cell, target.cell);
    if (path === null) {
      a.addMemory(this.tick, `Couldn't find a way to reach ${target.name}.`);
      this.completeAction(a, act);
      this.observe(a);
      return true;
    }
    if (path.length) a.setPath(cellsToPixels(path, this.world.cellPx));
    return false;
  }

  private onArrival(a: Agent, act: CurrentAction): void {
    if (act.kind === 'move_to') {
      this.log({ agent: a, icon: '📍', kind: 'action', text: `arrives at ${act.targetName}` });
      a.addMemory(this.tick, `Arrived at ${act.targetName}.`);
      this.completeAction(a, act, true);
    } else if (act.kind === 'work') {
      this.log({ agent: a, icon: '📍', kind: 'action', text: `reaches ${act.targetName} and gets to work` });
    }
  }

  private completeAction(a: Agent, act: CurrentAction, quiet = false): void {
    if (act.kind === 'rest') {
      a.addMemory(this.tick, `Rested${act.targetName ? ` at the ${act.targetName}` : ''} (energy back to ${Math.round(a.energy)}).`);
      this.log({ agent: a, icon: '😌', kind: 'action', text: `finishes resting (energy ${Math.round(a.energy)}/100)` });
    } else if (act.kind === 'work') {
      a.addMemory(this.tick, `Did some work at the ${act.targetName ?? this.world.nearestLocation(a.cell).name}.`);
      this.log({ agent: a, icon: '🔨', kind: 'action', text: `finishes working at ${act.targetName}` });
    }
    void quiet;
    if (act.fulfillsTask) this.markTaskDone(a); // directive-based task finished
    a.currentAction = null;
    a.clearPath();
    a.state = 'idle';
    a.needsDecision = true;
    a.decideAtTick = this.tick + 1;
  }

  private observe(a: Agent): void {
    for (const other of this.agents) {
      if (other.id === a.id) continue;
      const near = Math.hypot(a.px - other.px, a.py - other.py) <= this.observeRadiusPx;
      if (near && !a.nearbyIds.has(other.id)) {
        a.nearbyIds.add(other.id);
        const place = this.world.locationNameAt(other.cell);
        const doing = other.currentAction ? ` (${other.currentAction.kind.replace('_', ' ')})` : '';
        a.addMemory(this.tick, `Saw ${other.name}${place ? ` near the ${place}` : ' nearby'}${doing}.`);
        this.log({ agent: a, icon: '👀', kind: 'observe', text: `notices ${other.name}${place ? ` near the ${place}` : ' nearby'}` });
      } else if (!near && a.nearbyIds.has(other.id)) {
        a.nearbyIds.delete(other.id);
      }
    }
  }

  // ---- routing ----

  /** Build a pixel waypoint route to a location, splicing in the bridge if it's across the river. */
  private planRoute(a: Agent, loc: LocationCfg): { path: Point[]; crossSegment?: { start: number; end: number } } | null {
    const fromCell = a.cell;
    const fromSide: RiverSide = this.world.sideOfPixel(a.px, a.py);
    const toSide: RiverSide = this.world.sideOfCell({ x: loc.x, y: loc.y });

    if (fromSide === toSide) {
      const r = this.world.pathToLocation(fromCell, loc);
      if (!r) return null;
      return { path: cellsToPixels(r.path, this.world.cellPx) };
    }

    // Cross the river: walk to the near mouth, follow the scripted bridge, then continue.
    const nearMouth = this.world.bridgeMouthCell(fromSide);
    const farSide: RiverSide = fromSide === 'clearing' ? 'village' : 'clearing';
    const farMouth = this.world.bridgeMouthCell(farSide);

    const toMouth = this.world.findPath(fromCell, nearMouth);
    const bridge = this.world.bridgePathFrom(fromSide);
    const fromMouth = this.world.pathToLocation(farMouth, loc);
    if (!toMouth || !fromMouth) return null;

    const p1 = cellsToPixels(toMouth, this.world.cellPx);
    const p3 = cellsToPixels(fromMouth.path, this.world.cellPx);
    const path = [...p1, ...bridge, ...p3];
    return { path, crossSegment: { start: p1.length, end: p1.length + bridge.length } };
  }

  // ---- decisions ----

  private async decide(a: Agent): Promise<void> {
    a.pendingDecision = true;
    a.needsDecision = false;
    const token = ++a.decisionToken;

    const cell = a.cell;
    const place = this.world.locationNameAt(cell) ?? 'the open between places';
    const nearbyAgents = this.agents
      .filter((o) => o.id !== a.id && Math.hypot(a.px - o.px, a.py - o.py) <= this.observeRadiusPx)
      .map((o) => o.name);
    const nearbyLoc = this.world.nearestLocation(cell).name;
    const nearby = [...nearbyAgents, `the ${nearbyLoc}`].join(', ') || 'no one';

    try {
      const raw = await llm.complete({
        system: decisionSystem(
          a.name,
          a.persona,
          this.world.locations.map((l) => l.name),
          this.agents.filter((o) => o.id !== a.id).map((o) => o.name),
        ),
        user: decisionUser({
          tick: this.tick,
          timeOfDay: this.timeOfDay(),
          place,
          energy: a.energy,
          nearby,
          memories: a.memories.slice(-10),
          task: a.task && a.task.status !== 'done' ? a.task.text : null,
        }),
        maxTokens: 300,
      });
      if (token !== a.decisionToken || a.state === 'talking') return;
      const decision = parseDecision(raw);
      if (!decision) {
        this.log({ agent: a, icon: '⚠️', kind: 'warn', text: `returned unparseable JSON — wandering instead. Raw: ${raw.slice(0, 80)}…` });
        this.applyWander(a, 6);
        return;
      }
      a.lastThought = decision.thought;
      this.log({ agent: a, icon: '💭', kind: 'thought', text: decision.thought });
      if (a.task && a.task.status !== 'done') {
        a.task.status = 'doing';
        a.task.note = decision.thought;
        if (decision.task_done) this.markTaskDone(a);
      }
      this.applyDecision(a, decision);
    } catch (err) {
      if (token !== a.decisionToken || a.state === 'talking') return;
      this.warnLlmFailure(err as llm.LlmUnavailableError);
      this.applyFallback(a);
    } finally {
      a.pendingDecision = false;
    }
  }

  private applyDecision(a: Agent, d: DecisionResult): void {
    switch (d.action) {
      case 'move_to': {
        let note = '';
        let loc = this.world.resolveLocation(d.target);
        if (!loc) {
          loc = this.world.nearestLocation(a.cell);
          note = ` (didn't recognize "${d.target}", picked nearest)`;
        }
        this.startTravel(a, 'move_to', loc, 0, note);
        break;
      }
      case 'talk_to': {
        const wanted = (d.target ?? '').trim().toLowerCase();
        const target = this.agents.find((t) => t.id !== a.id && t.name.toLowerCase() === wanted);
        if (!target) {
          this.log({ agent: a, icon: '⚠️', kind: 'warn', text: `wanted to talk to unknown "${d.target}" — wandering instead` });
          this.applyWander(a, 5);
          return;
        }
        a.currentAction = { kind: 'talk_to', targetName: target.name, targetAgentId: target.id, remaining: 0, chaseTicks: 0 };
        a.clearPath();
        a.state = 'acting';
        this.log({ agent: a, icon: '➡️', kind: 'action', text: `talk_to → ${target.name}` });
        break;
      }
      case 'rest': {
        a.currentAction = { kind: 'rest', targetName: this.world.locationNameAt(a.cell), remaining: d.duration_ticks };
        a.clearPath();
        a.state = 'acting';
        this.log({ agent: a, icon: '😴', kind: 'action', text: `rests${a.currentAction.targetName ? ` at the ${a.currentAction.targetName}` : ''} (${d.duration_ticks} ticks)` });
        break;
      }
      case 'work': {
        const loc = this.world.resolveLocation(d.target) ?? this.world.nearestLocation(a.cell);
        this.startTravel(a, 'work', loc, d.duration_ticks);
        break;
      }
      case 'wander':
        this.applyWander(a, d.duration_ticks, true);
        break;
    }
  }

  /** Begin a move_to / work trip to a location, routing across the bridge if needed. */
  private startTravel(a: Agent, kind: 'move_to' | 'work', loc: LocationCfg, remaining: number, note = ''): void {
    const route = this.planRoute(a, loc);
    if (!route) {
      this.applyWander(a, 5);
      return;
    }
    a.currentAction = { kind, targetName: loc.name, remaining, crossSegment: route.crossSegment };
    a.setPath(route.path);
    a.state = 'acting';
    const crossing = route.crossSegment ? ' — crossing the Bridge' : '';
    const ticks = route.path.length;
    if (kind === 'move_to') {
      this.log({ agent: a, icon: '➡️', kind: 'action', text: `move_to → ${loc.name} (${ticks} steps)${crossing}${note}` });
    } else {
      this.log({ agent: a, icon: '🔨', kind: 'action', text: `work → ${loc.name} (${remaining} ticks${ticks ? `, ${ticks} to walk` : ''})${crossing}` });
    }
    if (route.path.length === 0) {
      // already there
      if (kind === 'move_to') this.completeAction(a, a.currentAction, true);
    }
  }

  private applyWander(a: Agent, ticks: number, chosen = false): void {
    a.currentAction = { kind: 'wander', targetName: null, remaining: ticks };
    a.clearPath();
    a.state = 'acting';
    this.log({ agent: a, icon: '🚶', kind: 'action', text: `wanders for a while (${ticks} ticks)${chosen ? '' : ' — fallback'}` });
  }

  /** No-LLM behavior: mostly wander, but sometimes set off for a named place so
   *  the map (and the bridge) gets used even without an API key. */
  private applyFallback(a: Agent): void {
    if (Math.random() < 0.45) {
      const loc = this.world.locations[Math.floor(Math.random() * this.world.locations.length)];
      this.startTravel(a, 'move_to', loc, 0, ' — fallback');
    } else {
      this.applyWander(a, 8 + Math.floor(Math.random() * 5));
    }
  }

  private warnLlmFailure(err: llm.LlmUnavailableError): void {
    const reason = err.reason ?? 'api_error';
    const last = this.lastLlmWarnTick.get(reason) ?? -999;
    if (this.tick - last < 10) return;
    this.lastLlmWarnTick.set(reason, this.tick);
    const text =
      reason === 'no_key'
        ? 'No ANTHROPIC_API_KEY set — agents cannot think. Add a key to .env and restart; roaming the village until then.'
        : reason === 'auth'
          ? 'Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY in .env. Agents roam until fixed.'
          : reason === 'rate_limit_local'
            ? `Local API rate cap hit (${llm.maxCallsPerMin()}/min) — deferring decisions, agents roam.`
            : `LLM call failed: ${err.message}. Agent falls back to roaming.`;
    this.log({ icon: '⚠️', kind: 'warn', text });
  }

  // ---- tasks (from the dashboard) ----

  /** Assign a task to an agent. Tries a concrete directive first; otherwise the
   *  task guides the agent's next AI decision. Either way it shows in the roster. */
  assignTask(agentId: string, text: string): void {
    const a = this.agentById(agentId);
    const clean = text.trim().slice(0, 200);
    if (!a || !clean) return;
    a.task = { text: clean, status: 'doing', assignedTick: this.tick, note: undefined };
    a.addMemory(this.tick, `The Overseer assigned me a task: "${clean}".`);
    this.log({ agent: a, icon: '🎯', kind: 'system', text: `assigned a task: "${clean}"` });

    // "Both" mode: if the text names something concrete, act on it right now.
    const directive = this.parseTaskDirective(clean);
    if (a.state !== 'talking') {
      a.decisionToken++;
      a.clearPath();
      if (directive) {
        a.lastThought = `On it: ${clean}`;
        this.applyDecision(a, directive);
        if (a.currentAction) a.currentAction.fulfillsTask = true;
        else this.markTaskDone(a); // directive was a no-op (already there) → done
      } else {
        // No concrete directive — let the AI pursue it on the next decision.
        a.currentAction = null;
        a.state = 'idle';
        a.needsDecision = true;
        a.decideAtTick = this.tick + 1;
      }
    }
  }

  clearTask(agentId: string): void {
    const a = this.agentById(agentId);
    if (!a || !a.task) return;
    this.log({ agent: a, icon: '🎯', kind: 'system', text: `task cleared by the Overseer` });
    a.task = null;
  }

  private markTaskDone(a: Agent): void {
    if (!a.task) return;
    a.task.status = 'done';
    a.task.note = 'Completed.';
    a.addMemory(this.tick, `Finished the task: "${a.task.text}".`);
    this.log({ agent: a, icon: '✅', kind: 'system', text: `reports task complete: "${a.task.text}"` });
  }

  /** Map a task string to a concrete action if it clearly names a place/verb. */
  private parseTaskDirective(text: string): DecisionResult | null {
    const t = text.toLowerCase();
    const loc = this.world.locations.find((l) => t.includes(l.name.toLowerCase()));
    const wantsRest = /\b(rest|sleep|nap|recover)\b/.test(t);
    const wantsWork = /\b(work|build|tend|gather|sell|fix|repair|harvest|catalog|cook|clean)\b/.test(t);
    const wantsGo = /\b(go|move|walk|head|visit|patrol|guard|wait|stand)\b/.test(t);
    const thought = `Working on it: ${text}`.slice(0, 200);
    if (wantsRest && !loc) return { thought, action: 'rest', target: null, duration_ticks: 12 };
    if (loc && wantsWork) return { thought, action: 'work', target: loc.name, duration_ticks: 12 };
    if (loc && (wantsGo || !wantsWork)) return { thought, action: 'move_to', target: loc.name, duration_ticks: 6 };
    return null; // hand off to the AI
  }

  // ---- chat from the dashboard (the Overseer speaks) ----

  handleChat(target: string, text: string): void {
    const clean = text.trim().slice(0, 240);
    if (!clean) return;
    this.log({ icon: '🗣️', kind: 'speech', text: `Overseer → ${target === 'all' ? 'everyone' : (this.agentById(target)?.name ?? target)}: "${clean}"` });

    let recipients: Agent[];
    let responder: Agent | undefined;
    if (target === 'all') {
      recipients = this.agents;
      // the nearest-to-the-campfire (most "central") agent voices the reply
      const fire = this.world.resolveLocation('Campfire')!;
      const c = this.world.centerOf({ x: fire.x, y: fire.y });
      responder = [...this.agents].sort((p, q) => Math.hypot(p.px - c.x, p.py - c.y) - Math.hypot(q.px - c.x, q.py - c.y))[0];
    } else {
      const a = this.agentById(target);
      if (!a) return;
      recipients = [a];
      responder = a;
    }

    for (const a of recipients) a.addMemory(this.tick, `The Overseer said: "${clean}".`);
    if (responder) void this.generateReply(responder, clean);
  }

  private async generateReply(a: Agent, message: string): Promise<void> {
    try {
      const raw = await llm.complete({
        system: overseerReplySystem(a.name, a.persona),
        user: overseerReplyUser(message, a.memories),
        maxTokens: 200,
      });
      const reply = parseReply(raw);
      if (!reply) throw new llm.LlmUnavailableError('reply was unparseable', 'api_error');
      a.lastThought = reply;
      this.log({ agent: a, icon: '💬', kind: 'speech', text: `"${reply}"` });
      this.send({ type: 'bubble', agentId: a.id, text: reply, durationMs: Math.min(7000, Math.round((2000 + reply.length * 45) / this.speed)) });
      a.addMemory(this.tick, `I told the Overseer: "${reply}".`);
      // Re-decide soon so any instruction in the message can take effect.
      if (a.state !== 'talking') {
        a.needsDecision = true;
        a.decideAtTick = this.tick + 2;
      }
    } catch (err) {
      this.warnLlmFailure(err as llm.LlmUnavailableError);
      // Keyless fallback: a wordless acknowledgement so the user sees a response.
      const ack = '…(looks up, listening)';
      this.send({ type: 'bubble', agentId: a.id, text: ack, durationMs: 2500 });
      this.log({ agent: a, icon: '💬', kind: 'speech', text: ack });
    }
  }

  // ---- conversations ----

  private pairKey(idA: string, idB: string): string {
    return [idA, idB].sort().join('|');
  }

  private agentById(id: string): Agent | undefined {
    return this.agents.find((a) => a.id === id);
  }

  private tryStartConversation(a: Agent, b: Agent): void {
    const act = a.currentAction;
    if (!act) return;
    if (a.state === 'talking' || b.state === 'talking') {
      a.addMemory(this.tick, `${b.name} was busy talking with someone else.`);
      this.completeAction(a, act);
      return;
    }
    const key = this.pairKey(a.id, b.id);
    if ((this.pairCooldown.get(key) ?? -Infinity) > this.tick) {
      a.addMemory(this.tick, `Already talked with ${b.name} a little while ago.`);
      this.completeAction(a, act);
      return;
    }
    this.pairCooldown.set(key, this.tick + PAIR_COOLDOWN_TICKS);

    for (const agent of [a, b]) {
      agent.decisionToken++;
      agent.currentAction = null;
      agent.clearPath();
      agent.state = 'talking';
      agent.needsDecision = false;
    }
    a.dir = getDirectionFromDelta(b.px - a.px, b.py - a.py, a.dir);
    b.dir = getDirectionFromDelta(a.px - b.px, a.py - b.py, b.dir);

    const place = this.world.locationNameAt(a.cell) ?? 'lane';
    const convo: ActiveConversation = {
      aId: a.id,
      bId: b.id,
      place,
      lines: [],
      summaries: new Map(),
      lineIdx: 0,
      nextLineAt: this.tick + 1,
      pending: true,
    };
    this.conversations.push(convo);
    this.log({ agent: a, icon: '💬', kind: 'action', text: `strikes up a conversation with ${b.name} at the ${place}` });
    void this.generateConversation(convo, a, b, key);
  }

  private async generateConversation(convo: ActiveConversation, a: Agent, b: Agent, key: string): Promise<void> {
    try {
      const raw = await llm.complete({
        system: conversationSystem(),
        user: conversationUser(
          { name: a.name, persona: a.persona, energy: a.energy, memories: a.memories },
          { name: b.name, persona: b.persona, energy: b.energy, memories: b.memories },
          convo.place,
          this.timeOfDay(),
          this.pairHistory.get(key) ?? null,
        ),
        maxTokens: 500,
      });
      const script = parseConversation(raw, a.name, b.name);
      if (!script) throw new llm.LlmUnavailableError('conversation JSON was unparseable', 'api_error');
      convo.lines = script.lines.map((l) => ({
        speakerId: l.speaker.toLowerCase() === b.name.toLowerCase() ? b.id : a.id,
        text: l.text,
      }));
      for (const [name, summary] of Object.entries(script.summaries)) {
        const who = name.toLowerCase() === b.name.toLowerCase() ? b : name.toLowerCase() === a.name.toLowerCase() ? a : null;
        if (who) convo.summaries.set(who.id, summary);
      }
      convo.pending = false;
    } catch (err) {
      this.warnLlmFailure(err as llm.LlmUnavailableError);
      this.log({ agent: a, icon: '😶', kind: 'action', text: `and ${b.name} stand together a moment, but the words don't come` });
      convo.pending = false;
      convo.lines = [];
      this.endConversation(convo, true);
    }
  }

  private advanceConversations(): void {
    for (const convo of [...this.conversations]) {
      if (convo.pending) continue;
      if (convo.lineIdx >= convo.lines.length) {
        this.endConversation(convo, convo.lines.length === 0);
        continue;
      }
      if (this.tick >= convo.nextLineAt) {
        const line = convo.lines[convo.lineIdx++];
        const speaker = this.agentById(line.speakerId);
        if (speaker) {
          this.log({ agent: speaker, icon: '💬', kind: 'speech', text: `"${line.text}"` });
          this.send({
            type: 'bubble',
            agentId: speaker.id,
            text: line.text,
            durationMs: Math.min(7000, Math.round((1800 + line.text.length * 45) / this.speed)),
          });
        }
        convo.nextLineAt = this.tick + CONVO_LINE_EVERY;
      }
    }
  }

  private endConversation(convo: ActiveConversation, failed: boolean): void {
    const idx = this.conversations.indexOf(convo);
    if (idx !== -1) this.conversations.splice(idx, 1);
    const a = this.agentById(convo.aId);
    const b = this.agentById(convo.bId);
    if (!a || !b) return;
    const key = this.pairKey(a.id, b.id);
    if (!failed) {
      const sa = convo.summaries.get(a.id) ?? `Talked with ${b.name} at the ${convo.place}.`;
      const sb = convo.summaries.get(b.id) ?? `Talked with ${a.name} at the ${convo.place}.`;
      a.addMemory(this.tick, sa);
      b.addMemory(this.tick, sb);
      this.pairHistory.set(key, sa);
    } else {
      a.addMemory(this.tick, `Tried to chat with ${b.name} but it fizzled out.`);
      b.addMemory(this.tick, `${a.name} came over to talk but it fizzled out.`);
    }
    for (const agent of [a, b]) {
      if (agent.state === 'talking') {
        agent.state = 'idle';
        agent.currentAction = null;
        agent.clearPath();
        agent.needsDecision = true;
        agent.decideAtTick = this.tick + 2;
      }
    }
  }

  // ---- logging ----

  private log(opts: { agent?: Agent; icon: string; text: string; kind: LogKind }): void {
    const event: LogEvent = {
      ts: Date.now(),
      icon: opts.icon,
      text: opts.text,
      kind: opts.kind,
      ...(opts.agent ? { agentId: opts.agent.id, name: opts.agent.name, color: opts.agent.color } : {}),
    };
    this.send({ type: 'log', event });
    const who = opts.agent ? `[${opts.agent.name}] ` : '';
    console.log(`t${String(this.tick).padStart(4, ' ')} ${who}${opts.icon} ${opts.text}`);
  }
}
