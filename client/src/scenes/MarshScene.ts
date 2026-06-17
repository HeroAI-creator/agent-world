// World 2 — the Marsh Outpost. A self-contained, client-only scene reached
// through the village portal. It reuses the Player (click-to-move) and shows the
// four marsh agents roaming the bog. There is no server here yet: the agents
// wander client-side; wiring them to Claude is a later step.
//
// Layout (background, walkability, agent homes, spawn + return portal) lives in
// marshConfig.ts. Press G for the same walkability overlay as the village.

import Phaser from 'phaser';
import { DebugGrid } from '../debugGrid';
import { Player } from '../player';
import { Portal } from '../portal';
import {
  MARSH_AGENTS,
  MARSH_GRID,
  MARSH_LOCATIONS,
  MARSH_PLAYER_SPAWN,
  MARSH_RETURN_PORTAL,
  type MarshAgentDef,
} from '../marshConfig';
import type { Dir, InitData, Point } from '../types';

const DIRS: Dir[] = ['down', 'left', 'right', 'up'];
const frameKey = (id: string, dir: Dir, f: 0 | 1) => `walk-${id}-${dir}-${f}`;
const animKey = (id: string, dir: Dir) => `walk-${id}-${dir}`;
const SHADOW_Y = 34;

interface MarshCallbacks {
  onReturn: () => void; // player stepped onto the return portal
  onReady: () => void; // scene finished (re)building — hide the loading screen
  onAgentClick: (def: MarshAgentDef) => void;
}

export class MarshScene extends Phaser.Scene {
  readonly cell = MARSH_GRID.cellPx;
  readonly worldW = MARSH_GRID.cols * MARSH_GRID.cellPx;
  readonly worldH = MARSH_GRID.rows * MARSH_GRID.cellPx;

  private player: Player | null = null;
  private portal: Portal | null = null;
  private debugGrid: DebugGrid | null = null;
  private portalArmed = false; // re-arms once the player walks off the portal
  private built = false;

  constructor(private readonly cb: MarshCallbacks) {
    super({ key: 'marsh' });
  }

  preload(): void {
    this.load.maxParallelDownloads = 128;
    const need = (key: string, path: string) => {
      if (!this.textures.exists(key)) this.load.image(key, path);
    };
    need('marsh-bg', 'assets/marsh_background.png');
    need('world_portal_idle_0', 'assets/world_portal_idle_0.png');
    need('world_portal_idle_1', 'assets/world_portal_idle_1.png');
    // player frames usually already loaded by the village scene; load if missing
    for (const dir of DIRS) {
      need(`walk-player-${dir}-0`, `assets/player_${dir}_0.png`);
      need(`walk-player-${dir}-1`, `assets/player_${dir}_1.png`);
    }
    for (const a of MARSH_AGENTS) {
      for (const dir of DIRS) {
        need(frameKey(a.id, dir, 0), `assets/${a.id}_${dir}_0.png`);
        need(frameKey(a.id, dir, 1), `assets/${a.id}_${dir}_1.png`);
      }
    }
    this.load.on('loaderror', (file: { key: string }) => console.warn(`marsh asset failed: ${file.key}`));
  }

  create(): void {
    if (this.textures.exists('marsh-bg')) {
      this.add.image(0, 0, 'marsh-bg').setOrigin(0, 0).setDepth(0);
    } else {
      this.add.graphics().fillStyle(0x0c1a1f, 1).fillRect(0, 0, this.worldW, this.worldH).setDepth(0);
    }

    // faint landmark labels
    for (const loc of MARSH_LOCATIONS) {
      this.add
        .text(loc.x * this.cell + this.cell / 2, Math.max(14, (loc.y - loc.radius) * this.cell - 8), loc.name, {
          fontFamily: 'Consolas, monospace',
          fontSize: '15px',
          color: '#bfe9ff',
        })
        .setOrigin(0.5)
        .setAlpha(0.32)
        .setStroke('#06141a', 4)
        .setDepth(40);
    }

    // roaming agents
    for (const def of MARSH_AGENTS) new MarshAgent(this, def, MARSH_GRID, (d) => this.cb.onAgentClick(d));

    // the return portal (back to the village)
    this.portal = new Portal(this, MARSH_RETURN_PORTAL, this.cell, '↩ Back to the Village');

    // the player — arrives on the field camp, a few cells off the portal
    this.player = new Player(this, MARSH_GRID, MARSH_PLAYER_SPAWN);
    this.portalArmed = false; // don't fire until they walk off the spawn / onto it fresh

    this.input.on('pointerdown', (p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      if (over.length === 0) this.player?.moveToPixel(p.worldX, p.worldY);
    });

    // G overlay — reuse the village's DebugGrid with a marsh-shaped init
    const fakeInit = { grid: MARSH_GRID, bridgePath: [] as Point[], locations: MARSH_LOCATIONS } as unknown as InitData;
    this.debugGrid = new DebugGrid(this, fakeInit);
    this.input.keyboard?.on('keydown-G', () => this.debugGrid?.toggle());

    this.built = true;
    this.cb.onReady();
  }

  /** Called every frame by Phaser. Watch for the player reaching the return portal. */
  update(): void {
    if (!this.built || !this.player || !this.portal) return;
    const feet = this.player.position;
    const on = this.portal.contains(feet.x, feet.y);
    if (on && this.portalArmed) {
      this.portalArmed = false;
      this.cb.onReturn();
    } else if (!on && !this.portalArmed) {
      this.portalArmed = true; // armed once they've stepped away from the portal
    }
  }

  /** Re-place the player at the spawn when re-entering the marsh. */
  resetPlayerToSpawn(): void {
    this.player?.teleportToCell(MARSH_PLAYER_SPAWN);
    this.portalArmed = false;
  }
}

/** A lightweight client-side villager: wanders walkable cells around its home. */
class MarshAgent {
  private readonly container: Phaser.GameObjects.Container;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly walk: boolean[][];
  private readonly cellPx: number;
  private readonly cols: number;
  private readonly rows: number;
  private fx: number;
  private fy: number;
  private lastDir: Dir = 'down';
  private bubble: Phaser.GameObjects.Container | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly def: MarshAgentDef,
    grid: typeof MARSH_GRID,
    onClick: (def: MarshAgentDef) => void,
  ) {
    this.cellPx = grid.cellPx;
    this.cols = grid.cols;
    this.rows = grid.rows;
    this.walk = buildWalkable(grid);
    this.fx = def.home.x * this.cellPx + this.cellPx / 2;
    this.fy = def.home.y * this.cellPx + this.cellPx / 2;

    const rich = DIRS.every((d) => scene.textures.exists(frameKey(def.id, d, 0)) && scene.textures.exists(frameKey(def.id, d, 1)));
    for (const d of DIRS) {
      const k = animKey(def.id, d);
      if (rich && !scene.anims.exists(k)) {
        scene.anims.create({ key: k, frames: [{ key: frameKey(def.id, d, 0) }, { key: frameKey(def.id, d, 1) }], frameRate: 5, repeat: -1 });
      }
    }

    const shadow = scene.add.ellipse(0, SHADOW_Y, 32, 9, 0x000000, 0.28);
    const baseKey = scene.textures.exists(frameKey(def.id, 'down', 0)) ? frameKey(def.id, 'down', 0) : '__DEFAULT';
    this.sprite = scene.add.sprite(0, 0, baseKey).setScale(rich ? 0.62 : 1);
    const label = scene.add
      .text(0, -52, def.name, { fontFamily: 'Consolas, monospace', fontSize: '13px', color: def.color, fontStyle: 'bold' })
      .setOrigin(0.5)
      .setStroke('#06141a', 3);
    this.container = scene.add.container(this.fx, this.fy - SHADOW_Y, [shadow, this.sprite, label]);
    this.container.setDepth(100 + Math.round(this.fy)).setSize(50, 86).setInteractive({ useHandCursor: true });
    this.container.on('pointerdown', () => {
      onClick(def);
      this.showBubble(def.role);
    });

    this.scheduleRoam(400 + Math.random() * 1600);
  }

  private scheduleRoam(delay: number): void {
    this.scene.time.delayedCall(delay, () => this.roam());
  }

  private roam(): void {
    const target = this.pickNear(this.def.home, 4);
    if (!target) {
      this.scheduleRoam(1500);
      return;
    }
    const tx = target.x * this.cellPx + this.cellPx / 2;
    const ty = target.y * this.cellPx + this.cellPx / 2;
    const dist = Math.hypot(tx - this.fx, ty - this.fy);
    const dir = Math.abs(tx - this.fx) >= Math.abs(ty - this.fy) ? (tx >= this.fx ? 'right' : 'left') : ty >= this.fy ? 'down' : 'up';
    this.lastDir = dir;
    if (this.scene.anims.exists(animKey(this.def.id, dir))) this.sprite.play(animKey(this.def.id, dir), true);
    this.scene.tweens.add({
      targets: this.container,
      x: tx,
      y: ty - SHADOW_Y,
      duration: Math.max(450, (dist / 55) * 1000),
      ease: 'Linear',
      onUpdate: () => {
        this.fx = this.container.x;
        this.fy = this.container.y + SHADOW_Y;
        this.container.setDepth(100 + Math.round(this.fy));
      },
      onComplete: () => {
        this.fx = this.container.x;
        this.fy = this.container.y + SHADOW_Y;
        this.sprite.anims?.stop();
        if (this.scene.textures.exists(frameKey(this.def.id, this.lastDir, 0))) this.sprite.setTexture(frameKey(this.def.id, this.lastDir, 0));
        this.scheduleRoam(1200 + Math.random() * 3200);
      },
    });
  }

  /** A random walkable cell within `r` of `home` (a few tries; null if none found). */
  private pickNear(home: Point, r: number): Point | null {
    for (let i = 0; i < 14; i++) {
      const x = home.x + Math.floor(Math.random() * (r * 2 + 1)) - r;
      const y = home.y + Math.floor(Math.random() * (r * 2 + 1)) - r;
      if (x >= 0 && y >= 0 && x < this.cols && y < this.rows && this.walk[y][x]) return { x, y };
    }
    return null;
  }

  private showBubble(text: string): void {
    this.bubble?.destroy();
    const pad = 8;
    const t = this.scene.add.text(0, 0, text, {
      fontFamily: 'Consolas, monospace',
      fontSize: '12px',
      color: '#eaf6ff',
      align: 'center',
      wordWrap: { width: 220 },
    }).setOrigin(0.5);
    const bg = this.scene.add
      .rectangle(0, 0, t.width + pad * 2, t.height + pad * 2, 0x10222b, 0.92)
      .setStrokeStyle(1, 0x6fd3c2, 0.8);
    const b = this.scene.add.container(this.container.x, this.container.y - 70, [bg, t]).setDepth(2100);
    this.bubble = b;
    this.scene.tweens.add({ targets: b, alpha: { from: 0, to: 1 }, duration: 140 });
    this.scene.time.delayedCall(3600, () => {
      if (this.bubble === b) {
        this.scene.tweens.add({ targets: b, alpha: 0, duration: 200, onComplete: () => b.destroy() });
        this.bubble = null;
      }
    });
  }
}

/** Build a walkable[y][x] lookup from a grid's blocked rectangles. */
function buildWalkable(grid: typeof MARSH_GRID): boolean[][] {
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
