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
        if (isJarvisWakePhrase(text)) scene?.wakeJarvis();
      },
      onSelectAgent: (id) => log.setFilter(id),
      onIntake: (dataB64, mediaType, filename) => {
        net.sendIntake(dataB64, mediaType, filename);
        scene?.wakeJarvis();
      },
    });
    log.appendSystem(`Connected. Model ${init.model}, 4h = 1 day. Assign tasks and chat from the panel; click a villager to filter their log.`);
    if (!init.hasKey) {
      log.appendSystem('Server has no ANTHROPIC_API_KEY — agents roam and tasks run as direct directives. Add a key to .env for AI thinking + chat replies.', true);
    }

    scene = new WorldScene(
      init,
      (agentId) => log.setFilter(agentId ?? 'all'),
      (visible) => log.appendSystem(`Debug overlay ${visible ? 'ON' : 'OFF'} (G to toggle) — tune server/worldConfig.ts to match the image.`),
    );
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game-container',
      width: scene.worldW,
      height: scene.worldH,
      backgroundColor: '#0a140d',
      scale: { mode: Phaser.Scale.ENVELOP, autoCenter: Phaser.Scale.CENTER_BOTH },
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
