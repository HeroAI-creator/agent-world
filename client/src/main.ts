// Boot: connect the WebSocket, build the Phaser game on init, wire the
// pause/speed controls and the log panel.

import Phaser from 'phaser';
import './style.css';
import * as dash from './dash';
import * as log from './log';
import { connect } from './net';
import { WorldScene } from './scenes/WorldScene';

const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement;
const speedSel = document.getElementById('speed-select') as HTMLSelectElement;
const clockLabel = document.getElementById('clock-label') as HTMLSpanElement;
const todLabel = document.getElementById('tod') as HTMLSpanElement;
const connDot = document.getElementById('conn-dot') as HTMLSpanElement;
const filterSel = document.getElementById('filter-select') as HTMLSelectElement;
const appEl = document.getElementById('app') as HTMLDivElement;
const sideCollapseBtn = document.getElementById('side-collapse-btn') as HTMLButtonElement;
const sideReopenBtn = document.getElementById('side-reopen-btn') as HTMLButtonElement;
const locationPopover = document.getElementById('location-popover') as HTMLElement;
const locationTitle = document.getElementById('location-title') as HTMLHeadingElement;
const locationDesc = document.getElementById('location-desc') as HTMLParagraphElement;
const locationClose = document.getElementById('location-close') as HTMLButtonElement;
const jarvisPanel = document.getElementById('jarvis-panel') as HTMLElement;
const jarvisClose = document.getElementById('jarvis-close') as HTMLButtonElement;
const jarvisChatLog = document.getElementById('jarvis-chat-log') as HTMLDivElement;
const jarvisUpload = document.getElementById('jarvis-upload') as HTMLButtonElement;
const jarvisFileInput = document.getElementById('jarvis-file-input') as HTMLInputElement;
const jarvisInput = document.getElementById('jarvis-input') as HTMLInputElement;
const jarvisSend = document.getElementById('jarvis-send') as HTMLButtonElement;

const TOD_EMOJI: Record<string, string> = { morning: '🌅', midday: '☀️', evening: '🌆', night: '🌙' };

function setClock(day: number, clock: string, timeOfDay: string): void {
  clockLabel.textContent = `Day ${day} · ${clock} ${timeOfDay}`;
  todLabel.textContent = TOD_EMOJI[timeOfDay] ?? '🌅';
}

let game: Phaser.Game | null = null;
let scene: WorldScene | null = null;
let tickMs = 3000;
let speed = 1;

const moveMs = () => (tickMs / speed) * 0.82;

function setPausedUi(paused: boolean): void {
  pauseBtn.textContent = paused ? '▶ Play' : '⏸ Pause';
  pauseBtn.classList.toggle('paused', paused);
}

log.initLogControls();

const isJarvisWakePhrase = (text: string) => /\bhey[\s,]+jarvis\b/i.test(text) || /\bjarvis\b/i.test(text);

const LOCATION_COPY: Record<string, { title: string; desc: string }> = {
  Cottage: {
    title: 'Cottage',
    desc: 'A warm timber home tucked into the trees. Villagers return here to rest, recover energy, and plan the next stretch of the day.',
  },
  Well: {
    title: 'Old Well',
    desc: 'The stone well anchors the north path. It is a quiet meeting point and a good place for villagers to notice who is nearby.',
  },
  Campfire: {
    title: 'Campfire',
    desc: 'The bright center of the village. Work pauses here, stories collect here, and Jarvis burns above the flames as the local assistant spirit.',
  },
  'Market Stall': {
    title: 'Market Stall',
    desc: 'A lantern-lit stall stacked with goods from the forest path. It is the trading point for tools, food, and odd discoveries.',
  },
  Garden: {
    title: 'Garden',
    desc: 'A fenced patch of herbs and vegetables, kept close to the firelight. It gives the village its daily rhythm of small work.',
  },
  Bridge: {
    title: 'Bridge',
    desc: 'The wooden bridge crosses the stream between village and clearing. Agents use it as the safe route over the water.',
  },
  'Forest Clearing': {
    title: 'Forest Clearing',
    desc: 'A dim clearing at the edge of the map where the forest opens up. It is useful for wandering, scouting, and quiet tasks away from the village.',
  },
};

function refreshLayout(): void {
  window.dispatchEvent(new Event('resize'));
}

function setSidebarCollapsed(collapsed: boolean): void {
  appEl.classList.toggle('sidebar-collapsed', collapsed);
  sideReopenBtn.hidden = !collapsed;
  setTimeout(refreshLayout, 260);
}

function showLocation(locationName: string): void {
  const copy = LOCATION_COPY[locationName] ?? {
    title: locationName,
    desc: 'A marked village station. Agents can travel here, idle nearby, and use it as part of their daily route.',
  };
  locationTitle.textContent = copy.title;
  locationDesc.textContent = copy.desc;
  locationPopover.hidden = false;
}

function appendJarvisMessage(kind: 'jarvis' | 'you' | 'system', text: string): void {
  const row = document.createElement('div');
  row.className = `jarvis-line ${kind}`;
  const label = document.createElement('span');
  label.className = 'jarvis-label';
  label.textContent = kind === 'you' ? 'You' : kind === 'system' ? 'Files' : 'Jarvis';
  const body = document.createElement('span');
  body.textContent = text;
  row.append(label, body);
  jarvisChatLog.appendChild(row);
  jarvisChatLog.scrollTop = jarvisChatLog.scrollHeight;
}

// Downscale a chosen image to a JPEG no larger than maxEdge on its long side,
// then return raw base64 (no data: prefix). Keeps the WebSocket payload — and
// the vision token cost — modest while staying sharp enough to read a form.
async function fileToDownscaledJpegB64(file: File, maxEdge = 2000): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

function openJarvisPanel(): void {
  jarvisPanel.hidden = false;
  if (jarvisChatLog.childElementCount === 0) {
    appendJarvisMessage('jarvis', 'I am awake above the fire. Send a message or attach files for this village session.');
  }
  jarvisInput.focus();
}

function sendJarvisMessage(): void {
  const text = jarvisInput.value.trim();
  if (!text) return;
  appendJarvisMessage('you', text);
  jarvisInput.value = '';
  // Route to Tessa, the village's intake assistant. Her reply appears as a
  // speech bubble over the fire and in the agent log.
  net.sendChat('tessa', text);
  appendJarvisMessage('jarvis', 'Passed to Tessa — watch her reply over the campfire and in the log.');
}

sideCollapseBtn.addEventListener('click', () => setSidebarCollapsed(true));
sideReopenBtn.addEventListener('click', () => setSidebarCollapsed(false));
locationClose.addEventListener('click', () => (locationPopover.hidden = true));
jarvisClose.addEventListener('click', () => (jarvisPanel.hidden = true));
jarvisUpload.addEventListener('click', () => jarvisFileInput.click());
jarvisFileInput.addEventListener('change', async () => {
  const files = Array.from(jarvisFileInput.files ?? []);
  jarvisFileInput.value = ''; // allow re-selecting the same file later
  if (!files.length) return;
  const images = files.filter((f) => f.type.startsWith('image/'));
  const others = files.filter((f) => !f.type.startsWith('image/'));
  if (others.length) appendJarvisMessage('system', `Skipped (not an image): ${others.map((f) => f.name).join(', ')}`);
  // Each intake photo → Tessa drafts the Welcome Letter + Notice to Insurance and emails them.
  for (const file of images) {
    appendJarvisMessage('system', file.name);
    appendJarvisMessage('jarvis', `Reading "${file.name}" — Tessa is drafting the Welcome Letter & carrier Notice. Watch her at the Market Stall.`);
    try {
      const b64 = await fileToDownscaledJpegB64(file);
      net.sendIntake(b64, 'image/jpeg', file.name || 'intake.jpg');
      scene?.wakeJarvis();
    } catch {
      appendJarvisMessage('jarvis', `I couldn't read "${file.name}" — is it a valid image?`);
    }
  }
});
jarvisSend.addEventListener('click', sendJarvisMessage);
jarvisInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendJarvisMessage();
});

const net = connect({
  onInit(init) {
    tickMs = init.tickMs;
    speed = init.speed;
    speedSel.value = String(init.speed);
    setPausedUi(init.paused);
    log.populateFilter(init.agents);
    log.updateStats(init.stats);
    setClock(init.day, init.clock, init.timeOfDay);
    dash.initDash(init.agents, {
      onAssignTask: (id, text) => net.sendTask('assign', id, text),
      onClearTask: (id) => net.sendTask('clear', id),
      onChat: (target, text) => {
        net.sendChat(target, text);
        if (isJarvisWakePhrase(text)) {
          scene?.wakeJarvis();
          openJarvisPanel();
        }
      },
      onSelectAgent: (id) => log.setFilter(id),
    });
    log.appendSystem(`Connected. Model ${init.model}, 4h = 1 day. Assign tasks and chat from the panel; click a villager to filter their log.`);
    if (!init.hasKey) {
      log.appendSystem('Server has no ANTHROPIC_API_KEY — agents roam and tasks run as direct directives. Add a key to .env for AI thinking + chat replies.', true);
    }

    scene = new WorldScene(
      init,
      (agentId) => log.setFilter(agentId ?? 'all'),
      (visible) => log.appendSystem(`Debug overlay ${visible ? 'ON' : 'OFF'} (G to toggle) — tune server/worldConfig.ts to match the image.`),
      showLocation,
      openJarvisPanel,
    );
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game-container',
      width: scene.worldW,
      height: scene.worldH,
      backgroundColor: '#0a140d',
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene,
    });
    log.appendSystem('Press G over the world to toggle the walkability debug overlay.');
    // debug handle (handy in the browser console)
    (window as unknown as Record<string, unknown>).__game = game;

    // WebGL self-heal: if the GPU context is lost (tab backgrounded too long,
    // driver reset, or too many live contexts), the canvas goes blank. Catch it
    // and recover instead of leaving an empty "can't see the world" panel.
    const canvas = game.canvas as HTMLCanvasElement | undefined;
    canvas?.addEventListener(
      'webglcontextlost',
      (e) => {
        e.preventDefault(); // lets the browser fire 'webglcontextrestored'
        log.appendSystem('Graphics context lost — restoring the view…', true);
        setTimeout(() => location.reload(), 400);
      },
      { once: true },
    );
  },
  onMsg(msg) {
    switch (msg.type) {
      case 'tick':
        scene?.applyTick(msg, moveMs());
        setClock(msg.day, msg.clock, msg.timeOfDay);
        dash.updateDash(msg.agents);
        break;
      case 'log':
        log.appendLog(msg.event);
        break;
      case 'bubble':
        scene?.showBubble(msg);
        break;
      case 'stats':
        log.updateStats(msg.stats);
        break;
      case 'control':
        speed = msg.speed;
        speedSel.value = String(msg.speed);
        setPausedUi(msg.paused);
        break;
    }
  },
  onStatus(connected) {
    connDot.classList.toggle('on', connected);
    connDot.classList.toggle('off', !connected);
    if (!connected) log.appendSystem('Disconnected from server — retrying…', true);
  },
});

pauseBtn.addEventListener('click', () => net.sendControl('toggle_pause'));
speedSel.addEventListener('change', () => net.sendControl('set_speed', parseFloat(speedSel.value)));
filterSel.addEventListener('change', () => log.setFilter(filterSel.value));

// Vite HMR: a stale Phaser.Game can't survive module replacement — just reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => location.reload());
  import.meta.hot.dispose(() => game?.destroy(true));
}
