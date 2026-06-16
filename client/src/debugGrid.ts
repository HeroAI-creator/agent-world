// Dev overlay (toggle with the G key): draws the invisible walkability grid,
// the blocked rectangles, and the named-location markers on top of the
// background so the world config can be tuned to match the image.
//
// Tuning loop: edit server/worldConfig.ts → tsx watch restarts the server →
// the page reloads itself → press G again and compare.

import Phaser from 'phaser';
import type { InitData } from './types';

export class DebugGrid {
  private readonly layer: Phaser.GameObjects.Container;
  private visible = false;

  constructor(scene: Phaser.Scene, init: InitData) {
    const { cols, rows, cellPx, blocked } = init.grid;
    const w = cols * cellPx;
    const h = rows * cellPx;
    const children: Phaser.GameObjects.GameObject[] = [];

    const g = scene.add.graphics();
    children.push(g);

    // grid lines
    g.lineStyle(1, 0xffffff, 0.1);
    for (let x = 0; x <= cols; x++) g.lineBetween(x * cellPx, 0, x * cellPx, h);
    for (let y = 0; y <= rows; y++) g.lineBetween(0, y * cellPx, w, y * cellPx);

    // blocked rectangles
    for (const r of blocked) {
      g.fillStyle(0xf85149, 0.24);
      g.fillRect(r.x * cellPx, r.y * cellPx, r.w * cellPx, r.h * cellPx);
      g.lineStyle(1, 0xf85149, 0.8);
      g.strokeRect(r.x * cellPx, r.y * cellPx, r.w * cellPx, r.h * cellPx);
      children.push(
        scene.add
          .text(r.x * cellPx + 3, r.y * cellPx + 2, r.label, {
            fontFamily: 'Consolas, monospace',
            fontSize: '11px',
            color: '#ffc1be',
          })
          .setAlpha(0.95),
      );
    }

    // bridge crossing path (pixels) — the scripted waypoints agents walk
    const bp = init.bridgePath;
    if (bp.length > 1) {
      g.lineStyle(3, 0xffa030, 0.95);
      g.beginPath();
      g.moveTo(bp[0].x, bp[0].y);
      for (let i = 1; i < bp.length; i++) g.lineTo(bp[i].x, bp[i].y);
      g.strokePath();
      for (const p of bp) {
        g.fillStyle(0xffd97a, 1);
        g.fillCircle(p.x, p.y, 5);
      }
      children.push(
        scene.add
          .text(bp[0].x, bp[0].y + 14, 'bridge path', {
            fontFamily: 'Consolas, monospace',
            fontSize: '12px',
            color: '#ffd97a',
          })
          .setOrigin(0.5)
          .setStroke('#2a1c08', 4),
      );
    }

    // location markers (center dot + arrival radius)
    for (const loc of init.locations) {
      const cx = loc.x * cellPx + cellPx / 2;
      const cy = loc.y * cellPx + cellPx / 2;
      g.lineStyle(2, 0x3fb950, 0.9);
      g.strokeCircle(cx, cy, loc.radius * cellPx);
      g.fillStyle(0x3fb950, 1);
      g.fillCircle(cx, cy, 4);
      children.push(
        scene.add
          .text(cx, cy - loc.radius * cellPx - 12, loc.name, {
            fontFamily: 'Consolas, monospace',
            fontSize: '13px',
            color: '#7ee787',
            fontStyle: 'bold',
          })
          .setOrigin(0.5)
          .setStroke('#04140a', 4),
      );
    }

    this.layer = scene.add.container(0, 0, children).setDepth(2000).setVisible(false);
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.layer.setVisible(this.visible);
    return this.visible;
  }
}
