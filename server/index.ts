// Express + WebSocket bootstrap. Serves client/dist in production;
// in dev, Vite (port 5173) proxies /ws here.

import 'dotenv/config';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Agent, loadAgentSeeds } from './agent.js';
import * as llm from './llm.js';
import { Simulation } from './simulation.js';
import type { ClientMsg, InitMsg, ServerMsg } from './types.js';
import { World } from './world.js';

// Prefer an explicit API_PORT — in dev (.env sets it) this keeps the simulation
// server off Vite's port even if some tool injects PORT. In a cloud deploy
// (Railway/Render/etc.) there is no .env, so we fall back to the platform's
// PORT, then to 3001 locally.
const PORT = Number(process.env.API_PORT) || Number(process.env.PORT) || 3001;
const TICK_MS = Math.max(500, Number(process.env.TICK_INTERVAL_MS) || 3000);

// ---- World + agents ----

const world = new World();
const seeds = loadAgentSeeds();
const spawnCells = seeds.map((seed, i) => {
  const loc = world.resolveLocation(seed.spawn) ?? world.locations[i % world.locations.length];
  return world.spawnFor(loc);
});
world.validate(spawnCells);
const agents = seeds.map((seed, i) => new Agent(seed, world.centerOf(spawnCells[i]), world.cellPx));

// ---- HTTP + WS ----

const app = express();
const distDir = fileURLToPath(new URL('../client/dist', import.meta.url));
if (existsSync(distDir)) {
  app.use(express.static(distDir));
}
app.get('/health', (_req, res) => {
  res.json({ ok: true, tick: sim.tick, paused: sim.paused });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg: ServerMsg): void {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

const sim = new Simulation(world, agents, broadcast, TICK_MS);

wss.on('connection', (ws) => {
  const init: InitMsg = {
    type: 'init',
    grid: {
      cols: world.width,
      rows: world.height,
      cellPx: world.config.cellPx,
      blocked: world.config.blocked,
    },
    locations: world.locations,
    bridgePath: world.bridge.path,
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
      outfit: a.seed.outfit,
      persona: a.persona,
      px: a.px,
      py: a.py,
    })),
    tickMs: TICK_MS,
    speed: sim.speed,
    paused: sim.paused,
    tick: sim.tick,
    day: sim.clockInfo().day,
    clock: sim.clockInfo().clock,
    timeOfDay: sim.clockInfo().timeOfDay,
    model: llm.MODEL,
    hasKey: llm.hasApiKey(),
    stats: llm.getStats(),
  };
  ws.send(JSON.stringify(init));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data)) as ClientMsg;
      if (msg.type === 'control') {
        if (msg.action === 'toggle_pause') sim.togglePause();
        else if (msg.action === 'set_speed' && typeof msg.value === 'number') sim.setSpeed(msg.value);
      } else if (msg.type === 'task') {
        if (msg.action === 'assign' && typeof msg.text === 'string') sim.assignTask(msg.agentId, msg.text);
        else if (msg.action === 'clear') sim.clearTask(msg.agentId);
      } else if (msg.type === 'chat') {
        if (typeof msg.text === 'string' && typeof msg.target === 'string') sim.handleChat(msg.target, msg.text);
      }
    } catch {
      // ignore malformed client messages
    }
  });
});

server.listen(PORT, () => {
  const keyLine = llm.hasApiKey()
    ? 'API key: present — agents will think via the Anthropic API'
    : 'API key: MISSING — agents will wander aimlessly. Set ANTHROPIC_API_KEY in .env and restart.';
  console.log('');
  console.log('  Agent World server');
  console.log(`  http://localhost:${PORT}  (WebSocket on /ws)`);
  console.log(`  Model: ${llm.MODEL} | tick ${TICK_MS}ms | rate cap ${llm.maxCallsPerMin()} calls/min`);
  console.log(`  ${keyLine}`);
  console.log(`  Estimated cost: ${llm.describeHourlyCost()}`);
  if (!existsSync(distDir)) {
    console.log('  Dev mode: open the Vite client at http://localhost:5173');
  }
  console.log('');
  sim.start();
});
