// Fallback character sprites, drawn onto a canvas at runtime (16×16, 3 frames).
// Used only for agents whose <id>_walk.png sheet is missing, so the simulation
// stays watchable even with no character assets on disk.

import Phaser from 'phaser';
import type { AgentInfo } from './types';

type Ctx = CanvasRenderingContext2D;

const px = (ctx: Ctx, x: number, y: number, w: number, h: number, color: string) => {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
};

function paintCharFrame(ctx: Ctx, ox: number, outfit: Record<string, string>, frame: 0 | 1 | 2) {
  const hair = outfit.hair ?? '#4a3520';
  const skin = outfit.skin ?? '#e8b88a';
  const top = outfit.top ?? '#3f8f4f';
  const legs = outfit.legs ?? '#3f3328';
  const beard = outfit.beard;
  const lift = frame === 0 ? 0 : -1; // body bobs up a pixel mid-step

  // head
  px(ctx, ox + 5, 2 + lift, 6, 2, hair);
  px(ctx, ox + 4, 3 + lift, 1, 3, hair);
  px(ctx, ox + 11, 3 + lift, 1, 3, hair);
  px(ctx, ox + 5, 4 + lift, 6, 3, skin);
  px(ctx, ox + 6, 5 + lift, 1, 1, '#26221c'); // eyes
  px(ctx, ox + 9, 5 + lift, 1, 1, '#26221c');
  if (beard) {
    px(ctx, ox + 5, 6 + lift, 6, 2, beard);
    px(ctx, ox + 7, 6 + lift, 2, 1, skin); // mouth gap
  } else {
    px(ctx, ox + 5, 6 + lift, 6, 1, skin);
  }

  // body + arms
  px(ctx, ox + 4, 7 + lift, 8, 5, top);
  px(ctx, ox + 3, 8 + lift, 1, 3, top);
  px(ctx, ox + 12, 8 + lift, 1, 3, top);
  px(ctx, ox + 3, 11 + lift, 1, 1, skin); // hands
  px(ctx, ox + 12, 11 + lift, 1, 1, skin);
  px(ctx, ox + 4, 11 + lift, 8, 1, '#3a2f23'); // belt

  // legs (frame 1: left forward, frame 2: right forward)
  if (frame === 0) {
    px(ctx, ox + 5, 12, 2, 3, legs);
    px(ctx, ox + 9, 12, 2, 3, legs);
    px(ctx, ox + 5, 14, 2, 1, '#2b231a');
    px(ctx, ox + 9, 14, 2, 1, '#2b231a');
  } else if (frame === 1) {
    px(ctx, ox + 4, 12, 2, 4, legs);
    px(ctx, ox + 9, 12, 2, 2, legs);
    px(ctx, ox + 4, 15, 2, 1, '#2b231a');
    px(ctx, ox + 9, 13, 2, 1, '#2b231a');
  } else {
    px(ctx, ox + 5, 12, 2, 2, legs);
    px(ctx, ox + 10, 12, 2, 4, legs);
    px(ctx, ox + 5, 13, 2, 1, '#2b231a');
    px(ctx, ox + 10, 15, 2, 1, '#2b231a');
  }
}

/** Build (or reuse) a 3-frame fallback character texture: char-<id> with frames "0","1","2". */
export function ensureCharTexture(scene: Phaser.Scene, agent: AgentInfo): string {
  const key = `char-${agent.id}`;
  if (scene.textures.exists(key)) return key;
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  paintCharFrame(ctx, 0, agent.outfit, 0);
  paintCharFrame(ctx, 16, agent.outfit, 1);
  paintCharFrame(ctx, 32, agent.outfit, 2);
  const tex = scene.textures.addCanvas(key, canvas)!;
  tex.add('0', 0, 0, 0, 16, 16);
  tex.add('1', 0, 16, 0, 16, 16);
  tex.add('2', 0, 32, 0, 16, 16);
  tex.setFilter(Phaser.Textures.FilterMode.NEAREST); // crisp pixels despite smooth canvas
  return key;
}
