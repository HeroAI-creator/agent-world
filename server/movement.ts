// Reusable pixel-space movement: agents carry a float (px, py) feet position
// and walk along a polyline of pixel waypoints at a fixed speed per tick.
// Both ordinary routes (A* cell centers → pixels) and the scripted bridge
// crossing use the same followPath, so movement is uniform everywhere.

import type { Dir, Point } from './types.js';

/** Pick a walk direction from a movement delta (ties favor the horizontal axis). */
export function getDirectionFromDelta(dx: number, dy: number, fallback: Dir = 'down'): Dir {
  if (dx === 0 && dy === 0) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

/** The mutable bits followPath needs — Agent satisfies this. */
export interface Mover {
  px: number;
  py: number;
  dir: Dir;
  pathIndex: number;
}

/**
 * Advance `m` along `path` by up to `speed` pixels this tick, consuming
 * waypoints as it reaches them. Facing is taken from the vector to the current
 * waypoint, so direction is stable across a whole segment (no per-pixel flap).
 * Returns true once the final waypoint is reached.
 */
export function followPath(m: Mover, path: Point[], speed: number): boolean {
  if (!path.length || m.pathIndex >= path.length) return true;
  let budget = speed;
  while (budget > 1e-6 && m.pathIndex < path.length) {
    const target = path[m.pathIndex];
    const dx = target.x - m.px;
    const dy = target.y - m.py;
    const dist = Math.hypot(dx, dy);
    if (dist <= budget) {
      m.px = target.x;
      m.py = target.y;
      if (dist > 1e-6) m.dir = getDirectionFromDelta(dx, dy, m.dir);
      m.pathIndex++;
      budget -= dist;
    } else {
      m.px += (dx / dist) * budget;
      m.py += (dy / dist) * budget;
      m.dir = getDirectionFromDelta(dx, dy, m.dir);
      budget = 0;
    }
  }
  return m.pathIndex >= path.length;
}

/** Convert a path of grid cells to pixel waypoints at the center of each cell. */
export function cellsToPixels(cells: Point[], cellPx: number): Point[] {
  return cells.map((c) => ({ x: c.x * cellPx + cellPx / 2, y: c.y * cellPx + cellPx / 2 }));
}
