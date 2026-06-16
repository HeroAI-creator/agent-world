// Walkability grid + named locations overlaid on the background image, with
// A* pathfinding. The world is NOT tile-rendered — the grid is invisible and
// the client draws agents on top of a painted background. The grid geometry
// lives in worldConfig.ts; this class precomputes walkability and answers
// path/location queries for the simulation.

import type { Point } from './types.js';
import { WORLD_CONFIG, type BridgeCfg, type LocationCfg, type WorldConfig } from './worldConfig.js';

export type { LocationCfg } from './worldConfig.js';

export type RiverSide = 'clearing' | 'village';

export class World {
  readonly config: WorldConfig = WORLD_CONFIG;
  readonly width = WORLD_CONFIG.cols;
  readonly height = WORLD_CONFIG.rows;
  readonly cellPx = WORLD_CONFIG.cellPx;
  readonly locations: LocationCfg[] = WORLD_CONFIG.locations;
  readonly bridge: BridgeCfg = WORLD_CONFIG.bridge;

  /** walkable[y][x], precomputed from the blocked rectangles. */
  private readonly walkable: boolean[][];

  constructor() {
    this.walkable = Array.from({ length: this.height }, () => Array<boolean>(this.width).fill(true));
    for (const r of this.config.blocked) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (x >= 0 && y >= 0 && x < this.width && y < this.height) this.walkable[y][x] = false;
        }
      }
    }
  }

  isWalkable(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height && this.walkable[y][x];
  }

  // ---- pixel <-> cell ----

  /** Center of a grid cell, in pixels. */
  centerOf(cell: Point): Point {
    return { x: cell.x * this.cellPx + this.cellPx / 2, y: cell.y * this.cellPx + this.cellPx / 2 };
  }

  /** Grid cell containing a pixel point (clamped to the grid). */
  cellOf(px: number, py: number): Point {
    return {
      x: Math.min(this.width - 1, Math.max(0, Math.round((px - this.cellPx / 2) / this.cellPx))),
      y: Math.min(this.height - 1, Math.max(0, Math.round((py - this.cellPx / 2) / this.cellPx))),
    };
  }

  // ---- which side of the river ----

  /** Which bank a pixel point is on, via the signed area against the river line. */
  sideOfPixel(px: number, py: number): RiverSide {
    const { a, b } = this.bridge.river;
    const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    return cross > 0 ? 'clearing' : 'village';
  }

  sideOfCell(cell: Point): RiverSide {
    const c = this.centerOf(cell);
    return this.sideOfPixel(c.x, c.y);
  }

  manhattan(a: Point, b: Point): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  chebyshev(a: Point, b: Point): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  /** A* over the grid, 4-directional. Returns the path excluding `from`, including `to`; null if unreachable. */
  findPath(from: Point, to: Point): Point[] | null {
    if (!this.isWalkable(to.x, to.y)) return null;
    if (from.x === to.x && from.y === to.y) return [];
    const key = (p: Point) => p.y * this.width + p.x;
    const open: Point[] = [{ ...from }];
    const cameFrom = new Map<number, number>();
    const gScore = new Map<number, number>([[key(from), 0]]);
    const fScore = new Map<number, number>([[key(from), this.manhattan(from, to)]]);
    const inOpen = new Set<number>([key(from)]);

    while (open.length > 0) {
      let bestIdx = 0;
      for (let i = 1; i < open.length; i++) {
        if ((fScore.get(key(open[i])) ?? Infinity) < (fScore.get(key(open[bestIdx])) ?? Infinity)) bestIdx = i;
      }
      const current = open.splice(bestIdx, 1)[0];
      const ck = key(current);
      inOpen.delete(ck);
      if (current.x === to.x && current.y === to.y) {
        const path: Point[] = [];
        let k = ck;
        while (cameFrom.has(k)) {
          path.unshift({ x: k % this.width, y: Math.floor(k / this.width) });
          k = cameFrom.get(k)!;
        }
        return path;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        if (!this.isWalkable(nx, ny)) continue;
        const nk = ny * this.width + nx;
        const tentative = (gScore.get(ck) ?? Infinity) + 1;
        if (tentative < (gScore.get(nk) ?? Infinity)) {
          cameFrom.set(nk, ck);
          gScore.set(nk, tentative);
          fScore.set(nk, tentative + this.manhattan({ x: nx, y: ny }, to));
          if (!inOpen.has(nk)) {
            open.push({ x: nx, y: ny });
            inOpen.add(nk);
          }
        }
      }
    }
    return null;
  }

  /** Walkable cells within a location's radius, nearest-to-center first. */
  private cellsOf(loc: LocationCfg): Point[] {
    const cells: Array<{ p: Point; d: number }> = [];
    const r = Math.ceil(loc.radius);
    for (let y = loc.y - r; y <= loc.y + r; y++) {
      for (let x = loc.x - r; x <= loc.x + r; x++) {
        const d = Math.hypot(x - loc.x, y - loc.y);
        if (d <= loc.radius && this.isWalkable(x, y)) cells.push({ p: { x, y }, d });
      }
    }
    return cells.sort((a, b) => a.d - b.d).map((c) => c.p);
  }

  /** Shortest path to the location (nearest reachable walkable cell within its radius). */
  pathToLocation(from: Point, loc: LocationCfg): { goal: Point; path: Point[] } | null {
    for (const goal of this.cellsOf(loc).slice(0, 12)) {
      const path = this.findPath(from, goal);
      if (path !== null) return { goal, path };
    }
    return null;
  }

  /** A walkable spawn cell for a location (nearest to its center). */
  spawnFor(loc: LocationCfg): Point {
    const cells = this.cellsOf(loc);
    if (cells.length === 0) throw new Error(`location "${loc.name}" has no walkable cell within its radius`);
    return cells[0];
  }

  /** Path that ends on a walkable cell adjacent (8-dir) to `target`. Empty path if already adjacent. */
  pathToAdjacent(from: Point, target: Point): Point[] | null {
    if (this.chebyshev(from, target) <= 1) return [];
    let best: Point[] | null = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { x: target.x + dx, y: target.y + dy };
      if (!this.isWalkable(n.x, n.y)) continue;
      const path = this.findPath(from, n);
      if (path !== null && (best === null || path.length < best.length)) best = path;
    }
    return best;
  }

  /** Case-insensitive exact match, then substring match. Null if nothing fits. */
  resolveLocation(name: string | null | undefined): LocationCfg | null {
    if (!name) return null;
    const n = name.trim().toLowerCase();
    return (
      this.locations.find((l) => l.name.toLowerCase() === n) ??
      this.locations.find((l) => l.name.toLowerCase().includes(n) || n.includes(l.name.toLowerCase())) ??
      null
    );
  }

  nearestLocation(p: Point): LocationCfg {
    let best = this.locations[0];
    let bestD = Infinity;
    for (const loc of this.locations) {
      const d = Math.hypot(p.x - loc.x, p.y - loc.y);
      if (d < bestD) {
        bestD = d;
        best = loc;
      }
    }
    return best;
  }

  /** Location name if standing inside one's radius (closest wins), else null. */
  locationNameAt(p: Point): string | null {
    let best: LocationCfg | null = null;
    let bestD = Infinity;
    for (const loc of this.locations) {
      const d = Math.hypot(p.x - loc.x, p.y - loc.y);
      if (d <= loc.radius + 0.5 && d < bestD) {
        bestD = d;
        best = loc;
      }
    }
    return best?.name ?? null;
  }

  // ---- bridge crossing ----

  /** The grid cell where the bridge meets land on a given bank. */
  bridgeMouthCell(side: RiverSide): Point {
    return side === 'clearing' ? { ...this.bridge.mouthA } : { ...this.bridge.mouthB };
  }

  /** Bridge pixel waypoints oriented for an agent starting on `fromSide`. */
  bridgePathFrom(fromSide: RiverSide): Point[] {
    const path = this.bridge.path.map((p) => ({ ...p }));
    return fromSide === 'clearing' ? path : path.reverse();
  }

  /** Random walkable cell within `radius` (Chebyshev) of `p`; falls back to `p`. */
  randomNear(p: Point, radius: number): Point {
    for (let i = 0; i < 40; i++) {
      const x = p.x + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
      const y = p.y + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
      if (this.isWalkable(x, y) && (x !== p.x || y !== p.y)) return { x, y };
    }
    return { ...p };
  }

  /** Fails fast at boot if the config leaves locations or spawns unreachable. */
  validate(spawns: Point[]): void {
    const problems: string[] = [];
    for (const r of this.config.blocked) {
      if (r.x < 0 || r.y < 0 || r.x + r.w > this.width || r.y + r.h > this.height) {
        problems.push(`blocked rect "${r.label}" (${r.x},${r.y},${r.w},${r.h}) exceeds the ${this.width}×${this.height} grid`);
      }
    }
    const targets: Array<{ name: string; p: Point }> = [];
    for (const loc of this.locations) {
      const cells = this.cellsOf(loc);
      if (cells.length === 0) {
        problems.push(`location "${loc.name}" has no walkable cell within radius ${loc.radius} of (${loc.x},${loc.y})`);
      } else {
        targets.push({ name: loc.name, p: cells[0] });
      }
    }
    spawns.forEach((s, i) => {
      if (!this.isWalkable(s.x, s.y)) problems.push(`spawn ${i} at (${s.x},${s.y}) is not walkable`);
      else targets.push({ name: `spawn ${i}`, p: s });
    });
    // The scripted bridge connects its two mouths even though the deck is
    // blocked on the grid — model that as a virtual edge for the reachability BFS.
    const mouthA = this.bridge.mouthA;
    const mouthB = this.bridge.mouthB;
    if (!this.isWalkable(mouthA.x, mouthA.y)) problems.push(`bridge mouthA (${mouthA.x},${mouthA.y}) is not walkable`);
    if (!this.isWalkable(mouthB.x, mouthB.y)) problems.push(`bridge mouthB (${mouthB.x},${mouthB.y}) is not walkable`);
    const keyA = mouthA.y * this.width + mouthA.x;
    const keyB = mouthB.y * this.width + mouthB.x;

    if (targets.length > 0) {
      // BFS from the first target; every other target must be reachable.
      const start = targets[0].p;
      const seen = new Set<number>([start.y * this.width + start.x]);
      const queue: Point[] = [start];
      const enqueue = (nx: number, ny: number) => {
        const k = ny * this.width + nx;
        if (this.isWalkable(nx, ny) && !seen.has(k)) {
          seen.add(k);
          queue.push({ x: nx, y: ny });
        }
      };
      while (queue.length) {
        const c = queue.shift()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          enqueue(c.x + dx, c.y + dy);
        }
        // cross the bridge: reaching one mouth reaches the other
        const ck = c.y * this.width + c.x;
        if (ck === keyA) enqueue(mouthB.x, mouthB.y);
        else if (ck === keyB) enqueue(mouthA.x, mouthA.y);
      }
      for (const t of targets) {
        if (!seen.has(t.p.y * this.width + t.p.x)) {
          problems.push(`"${t.name}" at (${t.p.x},${t.p.y}) is unreachable from ${targets[0].name}`);
        }
      }
    }
    if (problems.length) {
      throw new Error(`World config validation failed:\n  - ${problems.join('\n  - ')}`);
    }
  }
}
