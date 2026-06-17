// A shimmering world portal: an animated sprite that sits on a grid cell, bobs
// and glows, and reports when the player's feet are standing on it. Used on both
// sides — the village portal goes to the marsh, the marsh portal comes back.

import Phaser from 'phaser';
import type { Point } from './types';

const FRAME_0 = 'world_portal_idle_0';
const FRAME_1 = 'world_portal_idle_1';
const ANIM_KEY = 'portal-idle';

export class Portal {
  readonly center: Point; // pixel center of the portal's cell (feet target)
  private readonly triggerPx: number;

  constructor(
    scene: Phaser.Scene,
    cell: Point,
    cellPx: number,
    label: string,
  ) {
    this.center = { x: cell.x * cellPx + cellPx / 2, y: cell.y * cellPx + cellPx / 2 };
    this.triggerPx = cellPx * 0.9; // step within ~1 cell to activate

    // 2-frame idle shimmer (no-op if the frames didn't load — falls back to a glow).
    const hasArt = scene.textures.exists(FRAME_0) && scene.textures.exists(FRAME_1);
    if (hasArt && !scene.anims.exists(ANIM_KEY)) {
      scene.anims.create({ key: ANIM_KEY, frames: [{ key: FRAME_0 }, { key: FRAME_1 }], frameRate: 3, repeat: -1 });
    }

    const glow = scene.add.ellipse(this.center.x, this.center.y + 6, cellPx * 2.2, cellPx * 0.9, 0x8a6bff, 0.22);
    const ground = scene.add.ellipse(this.center.x, this.center.y + 10, cellPx * 1.5, cellPx * 0.5, 0x000000, 0.25);
    void ground;

    let core: Phaser.GameObjects.Sprite | Phaser.GameObjects.Arc;
    if (hasArt) {
      // 256px art → ~96px on the ground; origin at the base so it stands on the cell.
      core = scene.add.sprite(this.center.x, this.center.y + 8, FRAME_0).setOrigin(0.5, 0.86).setScale(0.42);
      (core as Phaser.GameObjects.Sprite).play(ANIM_KEY);
    } else {
      core = scene.add.circle(this.center.x, this.center.y - 18, cellPx * 0.8, 0x9d7bff, 0.7);
    }

    const tag = scene.add
      .text(this.center.x, this.center.y - cellPx * 2.4, label, {
        fontFamily: 'Consolas, monospace',
        fontSize: '14px',
        color: '#cbb6ff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setStroke('#140b2e', 4);

    // depth: ground glow under agents, the standing portal among them, tag above
    glow.setDepth(55);
    core.setDepth(100 + Math.round(this.center.y));
    tag.setDepth(1850);

    scene.tweens.add({ targets: core, y: core.y - 10, duration: 1600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    scene.tweens.add({ targets: glow, alpha: { from: 0.14, to: 0.34 }, scaleX: { from: 0.92, to: 1.12 }, duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    scene.tweens.add({ targets: tag, alpha: { from: 0.6, to: 1 }, duration: 1300, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
  }

  /** True if the given feet position is standing on the portal. */
  contains(feetX: number, feetY: number): boolean {
    return Math.hypot(feetX - this.center.x, feetY - this.center.y) <= this.triggerPx;
  }
}
