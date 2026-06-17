// Player avatar: a click-to-move character. Unlike the villagers (driven by the
// server), the player is controlled entirely client-side — click the ground and
// it A*-paths there on the walkable grid, animating its walk along the way.

import Phaser from 'phaser';
import type { Dir, GridInfo, Point } from './types';

const DIRS: Dir[] = ['down', 'left', 'right', 'up'];
const frameKey = (dir: Dir, f: 0 | 1) => `walk-player-${dir}-${f}`;
const SHADOW_Y = 34; // feet sit this far below the container origin
const SPEED = 165; // px / second

interface Cell {
  x: number;
  y: number;
}

/** Build a walkable lookup from the grid's blocked rectangles. */
function buildWalkable(grid: GridInfo): boolean[][] {
  const walk: boolean[][] = [];
  for (let y = 0; y < grid.rows; y++) {
    walk[y] = [];
    for (let x = 0; x < grid.cols; x++) walk[y][x] = true;
  }
  for (const r of grid.blocked) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (y >= 0 && y < grid.rows && x >= 0 && x < grid.cols) walk[y][x] = false;
      }
    }
  }
  return walk;
}

/** 4-directional A* over the walkable grid. Returns a cell path incl. start & goal.
 *  If the goal sits in a region disconnected from the start (e.g. across water), it
 *  returns a best-effort path to the reachable cell nearest the goal, so a click that
 *  can't be satisfied exactly still walks the avatar as close as it can get. */
function aStar(walk: boolean[][], cols: number, rows: number, start: Cell, goal: Cell): Cell[] | null {
  const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && walk[y][x];
  const key = (x: number, y: number) => y * cols + x;
  const h = (x: number, y: number) => Math.abs(x - goal.x) + Math.abs(y - goal.y);
  const open: Array<{ x: number; y: number; f: number; g: number }> = [{ x: start.x, y: start.y, f: h(start.x, start.y), g: 0 }];
  const came = new Map<number, number>();
  const gScore = new Map<number, number>([[key(start.x, start.y), 0]]);
  let bestKey = key(start.x, start.y);
  let bestH = h(start.x, start.y);
  const rebuild = (endKey: number): Cell[] => {
    const path: Cell[] = [];
    let k: number | undefined = endKey;
    while (k !== undefined) {
      path.push({ x: k % cols, y: Math.floor(k / cols) });
      k = came.get(k);
    }
    return path.reverse();
  };
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.x === goal.x && cur.y === goal.y) return rebuild(key(cur.x, cur.y));
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!ok(nx, ny)) continue;
      const ng = cur.g + 1;
      const nk = key(nx, ny);
      if (ng < (gScore.get(nk) ?? Infinity)) {
        came.set(nk, key(cur.x, cur.y));
        gScore.set(nk, ng);
        const hh = h(nx, ny);
        open.push({ x: nx, y: ny, g: ng, f: ng + hh });
        if (hh < bestH) { bestH = hh; bestKey = nk; }
      }
    }
  }
  // Goal unreachable — walk to the reachable cell closest to the click.
  return rebuild(bestKey);
}

export class Player {
  private readonly cellPx: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly walk: boolean[][];
  private readonly container: Phaser.GameObjects.Container;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private px: number;
  private py: number;
  private lastDir: Dir = 'down';

  constructor(
    private readonly scene: Phaser.Scene,
    grid: GridInfo,
    spawn: Cell,
  ) {
    this.cellPx = grid.cellPx;
    this.cols = grid.cols;
    this.rows = grid.rows;
    this.walk = buildWalkable(grid);
    this.px = spawn.x * this.cellPx + this.cellPx / 2;
    this.py = spawn.y * this.cellPx + this.cellPx / 2;

    for (const d of DIRS) {
      const k = `walk-player-${d}`;
      if (!scene.anims.exists(k)) {
        scene.anims.create({ key: k, frames: [{ key: frameKey(d, 0) }, { key: frameKey(d, 1) }], frameRate: 7, repeat: -1 });
      }
    }

    const shadow = scene.add.ellipse(0, SHADOW_Y, 34, 9, 0x000000, 0.3);
    this.sprite = scene.add.sprite(0, 0, frameKey('down', 0)).setScale(0.66);
    const ring = scene.add.ellipse(0, SHADOW_Y, 40, 12, 0xffe066, 0).setStrokeStyle(2, 0xffe066, 0.5);
    const label = scene.add
      .text(0, -54, 'You', { fontFamily: 'Consolas, monospace', fontSize: '13px', color: '#ffe066', fontStyle: 'bold' })
      .setOrigin(0.5)
      .setStroke('#0b0e0b', 3);
    this.container = scene.add.container(this.px, this.py - SHADOW_Y, [ring, shadow, this.sprite, label]);
    this.container.setDepth(100 + Math.round(this.py));
    this.container.setSize(46, 86);
  }

  private get cell(): Cell {
    return {
      x: Math.round((this.px - this.cellPx / 2) / this.cellPx),
      y: Math.round((this.py - this.cellPx / 2) / this.cellPx),
    };
  }

  private dirOf(dx: number, dy: number): Dir {
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
    return dy >= 0 ? 'down' : 'up';
  }

  /** If the clicked cell is blocked, snap to the nearest walkable cell (ring search). */
  private nearestWalkable(c: Cell): Cell {
    const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < this.cols && y < this.rows && this.walk[y][x];
    if (ok(c.x, c.y)) return c;
    for (let r = 1; r < 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (ok(c.x + dx, c.y + dy)) return { x: c.x + dx, y: c.y + dy };
        }
      }
    }
    return c;
  }

  /** Walk to the cell containing this world pixel. */
  moveToPixel(worldX: number, worldY: number): void {
    this.moveToCell({ x: Math.floor(worldX / this.cellPx), y: Math.floor(worldY / this.cellPx) });
  }

  /** Snap instantly to a cell (no walk) — used when (re)entering a world. */
  teleportToCell(cell: Cell): void {
    this.scene.tweens.killTweensOf(this.container);
    this.px = cell.x * this.cellPx + this.cellPx / 2;
    this.py = cell.y * this.cellPx + this.cellPx / 2;
    this.container.setPosition(this.px, this.py - SHADOW_Y);
    this.container.setDepth(100 + Math.round(this.py));
    this.sprite.anims.stop();
    this.sprite.setTexture(frameKey(this.lastDir, 0));
  }

  moveToCell(target: Cell): void {
    const goal = this.nearestWalkable(target);
    const path = aStar(this.walk, this.cols, this.rows, this.cell, goal);
    if (!path || path.length < 2) return;
    this.scene.tweens.killTweensOf(this.container);
    const pts = path.map((c) => ({ x: c.x * this.cellPx + this.cellPx / 2, y: c.y * this.cellPx + this.cellPx / 2 }));
    this.walkStep(pts, 1);
  }

  /** Walk one segment at a time (plain per-waypoint tweens — same proven path the
   *  agents use), recursing to the next waypoint on complete. */
  private walkStep(pts: Point[], i: number): void {
    if (i >= pts.length) {
      this.sprite.anims.stop();
      this.sprite.setTexture(frameKey(this.lastDir, 0));
      return;
    }
    const to = pts[i];
    const dir = this.dirOf(to.x - this.px, to.y - this.py);
    this.lastDir = dir;
    this.sprite.play(`walk-player-${dir}`, true);
    const dur = Math.max(60, (Math.hypot(to.x - this.px, to.y - this.py) / SPEED) * 1000);
    this.scene.tweens.add({
      targets: this.container,
      x: to.x,
      y: to.y - SHADOW_Y,
      duration: dur,
      ease: 'Linear',
      onUpdate: () => {
        this.px = this.container.x;
        this.py = this.container.y + SHADOW_Y;
        this.container.setDepth(100 + Math.round(this.py));
      },
      onComplete: () => {
        this.px = this.container.x;
        this.py = this.container.y + SHADOW_Y;
        this.walkStep(pts, i + 1);
      },
    });
  }

  /** Pixel feet position (for portal-overlap checks etc.). */
  get position(): Point {
    return { x: this.px, y: this.py };
  }
}
