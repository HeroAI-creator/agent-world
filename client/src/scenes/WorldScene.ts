// Renders the world: one painted background image (user-supplied) with agent
// sprites layered on top along the server's invisible walkability grid.
// This is NOT a tilemap — the visual richness is the background image.
//
// - assets/background.png missing → a dark green gradient placeholder with
//   instructions is shown instead; the simulation keeps running on it.
// - assets/<id>_<dir>_<0|1>.png (128×128 transparent frames; dir ∈
//   down/left/right/up, 2 walk frames each) missing for an agent → that agent
//   uses a small generated pixel sprite.
// - Press G to toggle the walkability/locations debug overlay (debugGrid.ts).

import Phaser from 'phaser';
import { DebugGrid } from '../debugGrid';
import type { AgentInfo, AgentSnapshot, BubbleMsg, Dir, InitData, TickMsg } from '../types';
import { ensureCharTexture } from '../textures';
import { Player } from '../player';

const DIRS: Dir[] = ['down', 'left', 'right', 'up'];

// texture keys for the per-direction frame images
const frameKey = (id: string, dir: Dir, frame: 0 | 1) => `walk-${id}-${dir}-${frame}`;
const animKey = (id: string, dir: Dir) => `walk-${id}-${dir}`;

interface ViewMetrics {
  scale: number;
  nameY: number;
  barY: number;
  barW: number;
  statusY: number;
  shadowY: number;
  shadowW: number;
  shadowH: number;
  bubbleGap: number;
  hitW: number;
  hitH: number;
}

interface LocationInfo {
  name: string;
  x: number;
  y: number;
  radius: number;
}

export class WorldScene extends Phaser.Scene {
  readonly cell: number;
  readonly worldW: number;
  readonly worldH: number;

  private views = new Map<string, AgentView>();
  private debugGrid: DebugGrid | null = null;
  private jarvis: Phaser.GameObjects.Container | null = null;
  private jarvisCore: Phaser.GameObjects.Image | null = null;
  private jarvisGlow: Phaser.GameObjects.Arc | null = null;
  private jarvisBaseY = 0;
  private player: Player | null = null;
  private ready = false;

  constructor(
    private readonly initData: InitData,
    private readonly onAgentClick: (agentId: string | null) => void,
    private readonly onDebugToggle: (visible: boolean) => void,
    private readonly onLocationClick: (locationName: string) => void,
    private readonly onJarvisOpen: () => void,
    private readonly onReady?: () => void,
  ) {
    super({ key: 'world' });
    this.cell = initData.grid.cellPx;
    this.worldW = initData.grid.cols * this.cell;
    this.worldH = initData.grid.rows * this.cell;
  }

  preload(): void {
    // Load every asset in a single batch. With ~43 files the default 32-file
    // cap forces a second batch that can stall on throttled/background tabs;
    // a high cap keeps the whole scene loading as one pass.
    this.load.maxParallelDownloads = 128;
    this.load.image('bg', 'assets/background.png');
    this.load.image('jarvis-fireball', 'assets/jarvis_fireball.png');
    // Optional front-railing overlay drawn ABOVE agents so the bridge looks
    // layered (agent walks between the back and front railing). No-ops if absent.
    this.load.image('bridge-overlay', 'assets/bridge_overlay.png');
    for (const dir of DIRS) {
      this.load.image(`walk-player-${dir}-0`, `assets/player_${dir}_0.png`);
      this.load.image(`walk-player-${dir}-1`, `assets/player_${dir}_1.png`);
    }
    for (const a of this.initData.agents) {
      for (const dir of DIRS) {
        this.load.image(frameKey(a.id, dir, 0), `assets/${a.id}_${dir}_0.png`);
        this.load.image(frameKey(a.id, dir, 1), `assets/${a.id}_${dir}_1.png`);
      }
    }
    this.load.on('loaderror', (file: { key: string }) => {
      if (file.key !== 'bridge-overlay') console.warn(`asset failed to load: ${file.key} — using a fallback for it`);
    });
  }

  create(): void {
    if (this.textures.exists('bg')) {
      this.add.image(0, 0, 'bg').setOrigin(0, 0).setDepth(0);
    } else {
      this.drawPlaceholder();
    }

    // Faint location labels
    for (const loc of this.initData.locations) {
      this.add
        .text(loc.x * this.cell + this.cell / 2, Math.max(14, (loc.y - loc.radius) * this.cell - 8), loc.name, {
          fontFamily: 'Consolas, monospace',
          fontSize: '15px',
          color: '#ffffff',
        })
        .setOrigin(0.5)
        .setAlpha(0.34)
        .setStroke('#0a0d12', 4)
        .setDepth(40);
    }
    this.createLocationHotspots();

    // Flickering glow over the campfire location
    const fire = this.initData.locations.find((l) => l.name === 'Campfire');
    if (fire) {
      const glow = this.add
        .circle(fire.x * this.cell + this.cell / 2, fire.y * this.cell + this.cell / 2, this.cell * 1.4, 0xffa030, 0.14)
        .setDepth(50);
      this.tweens.add({
        targets: glow,
        alpha: { from: 0.09, to: 0.2 },
        scale: { from: 0.9, to: 1.15 },
        duration: 900,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    this.createJarvis();

    for (const agent of this.initData.agents) {
      this.views.set(agent.id, new AgentView(this, agent, this.onAgentClick));
    }

    // Optional bridge foreground overlay: front railing/posts drawn above the
    // agents (depth 1500 > agents' 100+row) so crossing feels layered.
    if (this.textures.exists('bridge-overlay')) {
      this.add.image(0, 0, 'bridge-overlay').setOrigin(0, 0).setDepth(1500);
    }

    // Dev overlay: G toggles grid + blocked rects + location markers + bridge path
    this.debugGrid = new DebugGrid(this, this.initData);
    this.input.keyboard?.on('keydown-G', () => {
      const visible = this.debugGrid!.toggle();
      this.onDebugToggle(visible);
    });

    // The player avatar — click-to-move. Starts on the open plaza near the fire.
    this.player = new Player(this, this.initData.grid, this.playerSpawnCell());

    // Click on empty ground: clear the log filter AND walk the player there.
    this.input.on(
      'pointerdown',
      (p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
        if (over.length === 0) {
          this.onAgentClick(null);
          this.player?.moveToPixel(p.worldX, p.worldY);
        }
      },
    );

    this.ready = true;
    this.onReady?.();
  }

  /** A walkable cell near the village centre for the player to start on. */
  private playerSpawnCell(): { x: number; y: number } {
    const fire = this.initData.locations.find((l) => l.name === 'Campfire');
    return fire
      ? { x: fire.x - 3, y: fire.y + 4 }
      : { x: Math.floor(this.initData.grid.cols / 2), y: Math.floor(this.initData.grid.rows / 2) };
  }

  private drawPlaceholder(): void {
    const g = this.add.graphics().setDepth(0);
    g.fillGradientStyle(0x0c1f12, 0x123222, 0x143824, 0x1d4a2e, 1);
    g.fillRect(0, 0, this.worldW, this.worldH);
    this.add
      .text(this.worldW / 2, this.worldH / 2 - 24, 'Drop background.png into client/public/assets/', {
        fontFamily: 'Consolas, monospace',
        fontSize: '26px',
        color: '#9fd8ad',
      })
      .setOrigin(0.5)
      .setDepth(1);
    this.add
      .text(this.worldW / 2, this.worldH / 2 + 16, '1920×1080 painted scene — the agents are already living on its grid (press G)', {
        fontFamily: 'Consolas, monospace',
        fontSize: '15px',
        color: '#5f8f6c',
      })
      .setOrigin(0.5)
      .setDepth(1);
  }

  applyTick(msg: TickMsg, moveMs: number): void {
    if (!this.ready) return;
    for (const snap of msg.agents) {
      this.views.get(snap.id)?.applyState(snap, moveMs);
    }
  }

  showBubble(msg: BubbleMsg): void {
    if (!this.ready) return;
    this.views.get(msg.agentId)?.showBubble(msg.text, msg.durationMs);
  }

  wakeJarvis(): void {
    if (!this.ready || !this.jarvis || !this.jarvisCore || !this.jarvisGlow) return;

    this.tweens.killTweensOf([this.jarvis, this.jarvisCore, this.jarvisGlow]);
    this.jarvis.setVisible(true).setAlpha(1).setScale(0.38);
    this.jarvisCore.setAngle(0);
    this.jarvisGlow.setAlpha(0.28).setScale(1);

    this.tweens.add({
      targets: this.jarvis,
      scale: { from: 0.38, to: 0.72 },
      y: { from: this.jarvisBaseY, to: this.jarvisBaseY - 34 },
      duration: 460,
      yoyo: true,
      ease: 'Back.easeOut',
      onComplete: () => this.startJarvisIdle(),
    });
    this.tweens.add({
      targets: this.jarvisCore,
      angle: 18,
      duration: 920,
      ease: 'Sine.easeInOut',
    });
    this.tweens.add({
      targets: this.jarvisGlow,
      alpha: { from: 0.2, to: 0.5 },
      scale: { from: 0.9, to: 1.7 },
      duration: 460,
      yoyo: true,
      ease: 'Sine.easeOut',
    });
  }

  private createLocationHotspots(): void {
    for (const loc of this.initData.locations as LocationInfo[]) {
      const cx = loc.x * this.cell + this.cell / 2;
      const cy = loc.y * this.cell + this.cell / 2;
      const w = Math.max(this.cell * loc.radius * 2.2, 96);
      const h = Math.max(this.cell * loc.radius * 1.35, 64);
      const halo = this.add
        .ellipse(cx, cy, w, h, 0x32e6ff, 0.07)
        .setStrokeStyle(2, 0x32e6ff, 0.3)
        .setDepth(62)
        .setVisible(false);
      const zone = this.add.zone(cx, cy, w, h).setDepth(1700).setInteractive({ useHandCursor: true });

      zone.on('pointerover', () => {
        halo.setVisible(true);
        this.tweens.killTweensOf(halo);
        this.tweens.add({
          targets: halo,
          alpha: { from: 0.12, to: 0.25 },
          scale: { from: 0.96, to: 1.04 },
          duration: 650,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      });
      zone.on('pointerout', () => {
        this.tweens.killTweensOf(halo);
        halo.setScale(1).setAlpha(1).setVisible(false);
      });
      zone.on('pointerdown', () => {
        this.onLocationClick(loc.name);
        this.player?.moveToCell({ x: loc.x, y: loc.y });
      });
    }
  }

  private createJarvis(): void {
    if (!this.textures.exists('jarvis-fireball')) return;

    const campfire = this.initData.locations.find((l) => l.name === 'Campfire');
    const x = campfire ? campfire.x * this.cell + this.cell * 0.85 : this.worldW / 2;
    const y = campfire ? campfire.y * this.cell - this.cell * 2.25 : this.worldH * 0.2;
    this.jarvisBaseY = y;
    this.jarvisGlow = this.add.circle(0, 40, 104, 0xff9d22, 0.22);
    this.jarvisCore = this.add.image(0, 0, 'jarvis-fireball').setOrigin(0.5, 0.58);
    this.jarvis = this.add.container(x, y, [this.jarvisGlow, this.jarvisCore]);
    this.jarvis.setDepth(1800).setScale(0.38).setSize(190, 250).setInteractive({ useHandCursor: true });
    this.jarvis.on('pointerdown', () => {
      this.wakeJarvis();
      this.onJarvisOpen();
    });
    this.startJarvisIdle();
  }

  private startJarvisIdle(): void {
    if (!this.jarvis || !this.jarvisCore || !this.jarvisGlow) return;

    this.jarvis.setScale(0.38);
    this.tweens.add({
      targets: this.jarvis,
      y: { from: this.jarvisBaseY, to: this.jarvisBaseY - 18 },
      duration: 1700,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    this.tweens.add({
      targets: this.jarvisCore,
      angle: { from: -4, to: 4 },
      duration: 1200,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    this.tweens.add({
      targets: this.jarvisGlow,
      alpha: { from: 0.14, to: 0.3 },
      scale: { from: 0.9, to: 1.18 },
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }
}

class AgentView {
  private readonly container: Phaser.GameObjects.Container;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly energyFill: Phaser.GameObjects.Rectangle;
  private readonly statusText: Phaser.GameObjects.Text;
  private readonly m: ViewMetrics;
  private readonly rich: boolean;
  private readonly agentId: string;
  private readonly fallbackKey: string = '';
  private bubble: Phaser.GameObjects.Container | null = null;
  private last: { px: number; py: number };

  constructor(
    private readonly scene: WorldScene,
    info: AgentInfo,
    onClick: (agentId: string) => void,
  ) {
    this.agentId = info.id;
    // "rich" only if every per-direction frame for this agent actually loaded.
    this.rich = DIRS.every(
      (d) => scene.textures.exists(frameKey(info.id, d, 0)) && scene.textures.exists(frameKey(info.id, d, 1)),
    );

    if (this.rich) {
      // One 2-frame walk cycle per direction, built from the standalone images.
      for (const dir of DIRS) {
        const key = animKey(info.id, dir);
        if (!scene.anims.exists(key)) {
          scene.anims.create({
            key,
            frames: [{ key: frameKey(info.id, dir, 0) }, { key: frameKey(info.id, dir, 1) }],
            frameRate: 5,
            repeat: -1,
          });
        }
      }
      this.m = {
        scale: 0.62, // 128px frames → ~80px on screen
        nameY: -52,
        barY: -44,
        barW: 30,
        statusY: -66,
        shadowY: 34,
        shadowW: 32,
        shadowH: 9,
        bubbleGap: 62,
        hitW: 50,
        hitH: 86,
      };
      this.sprite = scene.add.sprite(0, 0, frameKey(info.id, 'down', 0)).setScale(this.m.scale);
    } else {
      this.fallbackKey = ensureCharTexture(scene, info);
      const walkKey = `${this.fallbackKey}-walk`;
      if (!scene.anims.exists(walkKey)) {
        scene.anims.create({
          key: walkKey,
          frames: [
            { key: this.fallbackKey, frame: '1' },
            { key: this.fallbackKey, frame: '0' },
            { key: this.fallbackKey, frame: '2' },
            { key: this.fallbackKey, frame: '0' },
          ],
          frameRate: 7,
          repeat: -1,
        });
      }
      this.m = {
        scale: 2.5,
        nameY: -34,
        barY: -25,
        barW: 26,
        statusY: -47,
        shadowY: 19,
        shadowW: 22,
        shadowH: 7,
        bubbleGap: 50,
        hitW: 36,
        hitH: 46,
      };
      this.sprite = scene.add.sprite(0, 0, this.fallbackKey, '0').setScale(this.m.scale);
    }

    // drop shadow grounds the sprite on the painted scene
    const shadow = scene.add.ellipse(0, this.m.shadowY, this.m.shadowW, this.m.shadowH, 0x000000, 0.28);
    const nameText = scene.add
      .text(0, this.m.nameY, info.name, {
        fontFamily: 'Consolas, monospace',
        fontSize: this.rich ? '13px' : '12px',
        color: info.color,
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setStroke('#0b0e0b', 3);
    const energyBg = scene.add.rectangle(0, this.m.barY, this.m.barW, 3, 0x10151c).setStrokeStyle(1, 0x000000, 0.5);
    this.energyFill = scene.add
      .rectangle(-this.m.barW / 2, this.m.barY, this.m.barW, 3, 0x3fb950)
      .setOrigin(0, 0.5);
    this.statusText = scene.add
      .text(0, this.m.statusY, '', { fontFamily: '"Segoe UI Emoji", sans-serif', fontSize: '13px' })
      .setOrigin(0.5);

    // The server sends feet (bottom-center) pixels; the shadow sits at the feet
    // (+shadowY below the container center), so the container rides shadowY above.
    this.container = scene.add.container(info.px, info.py - this.m.shadowY, [
      shadow,
      this.sprite,
      nameText,
      energyBg,
      this.energyFill,
      this.statusText,
    ]);
    this.container.setDepth(100 + Math.round(info.py));
    this.container.setSize(this.m.hitW, this.m.hitH);
    this.container.setInteractive({ useHandCursor: true });
    this.container.on('pointerdown', () => onClick(info.id));
    this.last = { px: info.px, py: info.py };
  }

  applyState(s: AgentSnapshot, moveMs: number): void {
    const scene = this.scene;
    // Server sends feet pixels; container rides shadowY above so the shadow lands on them.
    const tx = s.px;
    const ty = s.py - this.m.shadowY;
    const moved = Math.abs(s.px - this.last.px) > 0.5 || Math.abs(s.py - this.last.py) > 0.5;
    this.last = { px: s.px, py: s.py };

    if (moved) {
      scene.tweens.killTweensOf(this.container);
      scene.tweens.add({ targets: this.container, x: tx, y: ty, duration: moveMs, ease: 'Linear' });
      // Facing is computed server-side (getDirectionFromDelta) and arrives in s.dir.
      if (this.rich) this.sprite.play(animKey(this.agentId, s.dir), true);
      else this.sprite.play(`${this.fallbackKey}-walk`, true);
    } else {
      this.sprite.anims.stop();
      if (this.rich) {
        this.sprite.setTexture(frameKey(this.agentId, s.dir, 0)); // direction's standing pose
      } else {
        this.sprite.setFrame('0');
        this.sprite.setFlipX(s.facing === -1);
      }
    }

    this.energyFill.scaleX = Math.max(0, Math.min(1, s.energy / 100));
    this.energyFill.fillColor = s.energy >= 60 ? 0x3fb950 : s.energy >= 30 ? 0xd29922 : 0xf85149;

    const status =
      s.state === 'talking' ? '' : s.action === 'rest' ? '💤' : s.action === 'work' && s.state === 'acting' ? '🔨' : '';
    if (this.statusText.text !== status) this.statusText.setText(status);

    this.container.setDepth(100 + Math.round(s.py));
  }

  showBubble(text: string, durationMs: number): void {
    this.bubble?.destroy();
    this.bubble = null;

    const scene = this.scene;
    const txt = scene.add
      .text(0, 0, text, {
        fontFamily: 'Segoe UI, sans-serif',
        fontSize: '14px',
        color: '#1f1a13',
        wordWrap: { width: 200 },
        align: 'left',
      })
      .setOrigin(0.5);
    const w = Math.max(30, txt.width + 16);
    const h = txt.height + 12;

    const below = this.container.y < h + this.m.bubbleGap + 30;
    const g = scene.add.graphics();
    g.fillStyle(0xf7f3e8, 0.97);
    g.lineStyle(2, 0x2a221a, 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, 7);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, 7);
    if (below) {
      g.fillTriangle(-4, -h / 2 + 1, 4, -h / 2 + 1, 0, -h / 2 - 8);
    } else {
      g.fillTriangle(-4, h / 2 - 1, 4, h / 2 - 1, 0, h / 2 + 8);
    }

    const bubble = scene.add.container(
      0,
      below ? this.m.shadowY + 14 + h / 2 : -(this.m.bubbleGap + h / 2),
      [g, txt],
    );

    // keep the bubble inside the canvas horizontally
    const half = w / 2;
    if (this.container.x - half < 4) bubble.x = 4 + half - this.container.x;
    else if (this.container.x + half > scene.worldW - 4) bubble.x = scene.worldW - 4 - half - this.container.x;

    bubble.setAlpha(0).setScale(0.85);
    this.container.add(bubble);
    this.bubble = bubble;
    this.statusText.setVisible(false);

    scene.tweens.add({ targets: bubble, alpha: 1, scale: 1, duration: 140, ease: 'Back.easeOut' });
    scene.time.delayedCall(durationMs, () => {
      if (this.bubble !== bubble) return;
      scene.tweens.add({
        targets: bubble,
        alpha: 0,
        duration: 220,
        onComplete: () => {
          bubble.destroy();
          if (this.bubble === bubble) {
            this.bubble = null;
            this.statusText.setVisible(true);
          }
        },
      });
    });
  }
}
