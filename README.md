# 🏘 Agent World

AI agents living autonomously in a pixel RPG village. Four villagers — powered by the
Anthropic API (Claude Haiku 4.5) — wander a forest village, pursue their own goals,
form memories, and strike up conversations you can watch as speech bubbles. The right
panel is a terminal-style log streaming every thought 💭, action ➡️, and spoken line 💬
in real time.

Inspired by Stanford's *Generative Agents* (Smallville) and a16z's AI Town — built
small and from scratch.

```
┌───────────────────────────────┬──────────────────────────────┐
│  pixel village (Phaser 3)     │  AGENT LOG                   │
│                               │  [12:03:41] [Mira] 💭 The    │
│   agents walk, rest, work,    │  campfire looks warm…        │
│   chat with speech bubbles    │  [12:03:41] [Mira] ➡️ move_to │
│                               │  → Campfire (8 ticks)        │
│                               │  ─────────────────────────── │
│  ⏸ pause · speed 0.5/1/2×     │  API: 12 calls · $0.0103     │
└───────────────────────────────┴──────────────────────────────┘
```

## Quick start

```bash
npm install
cp .env.example .env        # then put your Anthropic API key in .env
npm run dev
```

Open **http://localhost:5173**. Within a minute you should see agents think (💭),
choose actions, walk somewhere, and eventually two of them will hold a conversation.

No API key? Everything still runs — agents just wander aimlessly and the log tells
you why. An invalid key degrades the same way (clear ⚠️ lines, no crash).

## Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | *(empty)* | Required for agents to think. Server-side only — never sent to the browser. |
| `TICK_INTERVAL_MS` | `3000` | One simulation tick = one tile of movement. |
| `MAX_API_CALLS_PER_MIN` | `10` | Hard local rate cap. When hit, agents wander and a warning is logged. |
| `MODEL` | `claude-haiku-4-5-20251001` | Model for decisions + conversations. |
| `API_PORT` | `3001` | Simulation server port (Vite proxies `/ws` to it in dev). |

## Cost

The server prints an estimate at boot. At defaults: roughly **$0.09–$0.37/hour**
typical (1–4 calls/min), with a hard ceiling of ~$0.93/hour at the 10 calls/min cap.
Live spend (calls, tokens, estimated $) is always visible at the bottom of the log
panel, and the **⏸ Pause** button freezes the tick loop — and therefore all API spend.

Guardrails: `max_tokens` 300 on decision calls / 500 on conversation calls, sliding-window
rate cap, LLM calls only when an action completes or a conversation starts (never per tick).

## How it works

- **Server** (`server/`): Node + Express + ws, TypeScript (run with tsx).
  - `simulation.ts` — tick loop: movement (A* paths, 1 cell/tick), energy decay/rest,
    observation memories, conversation choreography, decision scheduling.
  - `llm.ts` — Anthropic SDK wrapper: rate cap, usage/cost accounting, typed failures.
  - `prompts.ts` — every prompt template + defensive JSON parsers (markdown fences
    stripped, unknown actions → `wander`, unknown locations → nearest valid).
  - `worldConfig.ts` — **the world definition**: a 60×34 invisible grid (32 px cells
    over the 1920×1080 image) where everything is walkable except hand-marked
    blocked rectangles (`{x, y, w, h, label}`), plus 7 named locations as
    center + radius (Cottage, Well, Campfire, Market Stall, Garden, Bridge,
    Forest Clearing). "Arriving" = entering the radius. Also holds the
    **bridge**: the crossing waypoints (in pixels), the two mouth cells, and the
    river line. **This is the file you tune to your image** (see the debug
    overlay below).
  - `world.ts` — walkability + A* + location queries + which-bank test over that
    config; self-validates at boot (rects in bounds, every location/spawn
    reachable — treating the scripted bridge as connecting its two mouths).
  - `movement.ts` — reusable pixel-space movement: `followPath(mover, path, speed)`
    walks a polyline of pixel waypoints; `getDirectionFromDelta(dx, dy)` picks the
    walk facing. Agents carry a float `(px, py)` feet position; every route —
    A* trips and the scripted bridge alike — is just a pixel polyline fed to
    `followPath`.
  - **Bridge crossing**: the stream is blocked, so A* can't cross it. When an
    agent heads for a location on the far bank, `simulation.ts` splices a route
    of *A\* to the near bridge mouth → the scripted `BRIDGE_PATH` (reversed if
    crossing the other way) → A\* on to the destination*. While on the bridge
    segment the agent's `state` is `crossing_bridge`: it's locked to the
    waypoints (no wandering) and faces along them. Agents never path onto the
    water.
  - `agents.json` — the four villagers. Edit names/personas/colors/spawns freely.
- **Client** (`client/`): Vite + TypeScript + Phaser 3 for the world; plain DOM for
  the dashboard (`dash.ts` = villager roster + chat, `log.ts` = log console).
  State arrives over a WebSocket (`/ws`); the browser never holds the API key or
  talks to Anthropic.
- **Tasks** (the Overseer assigns work): a task is stored on the agent and shown
  in its card with a status chip (todo / doing / done) and a progress note. On
  assignment the server tries to parse a **concrete directive** (a place name +
  a verb like "work"/"rest"/"go") and the agent does it immediately — so tasks
  work even with no API key. If it can't parse one, the task is injected into the
  agent's decision prompt as a priority the AI pursues, and the agent marks it
  done itself. **Clear** removes it.
- **Chat** (you talk to the village): your message is added to the target
  agent's memory (or everyone's, for "Everyone") and one agent voices a reply
  (speech bubble + log). With an API key the reply is generated in-character;
  without one you get a brief acknowledgement so it's never silent. Either way
  the message is in memory, so the agent's next AI decision can act on it.
- **Time**: one virtual day = 4 real hours at 1× (derived from `TICK_INTERVAL_MS`),
  shown as `Day N · HH:MM` that resets every day. Internally a monotonic tick
  still drives movement and cooldowns; the clock is computed from it.
- **Agents decide via LLM only when needed**: on spawn (staggered), when an action
  finishes, or when a conversation ends. Conversations are generated as one API call
  (2–4 lines + a one-line memory for each participant), then played out as timed
  speech bubbles.

### The villagers

| | Persona |
| --- | --- |
| 🟢 **Mira** | Curious herbalist cataloguing every plant. Slightly nosy. |
| 🔵 **Bram** | Superstitious fisherman; something strange lives under the bridge. |
| 🟠 **Oren** | Gruff carpenter; just wants quiet to finish the well roof. |
| 🟣 **Tessa** | Ambitious vendor recruiting everyone to expand her stall. |

Their seed memories deliberately interlock (Bram's lights, Tessa's plans for Oren…)
so early conversations have something to collide over.

## Art

The world is **not** a tilemap — it's one painted scene with sprites on top.

- **Background**: `client/public/assets/background.png`, 1920×1080. If it's
  missing the app shows a dark green gradient with "Drop background.png into
  client/public/assets/" and keeps running, so nothing ever crashes on assets.
  Want a new scene? A prompt that works well (Midjourney/DALL-E/etc.):
  > "Isometric fantasy forest village game map, painted style, detailed trees,
  > glowing lanterns and campfire, wooden cottages, stone paths, a well, a small
  > bridge over a stream, soft magical lighting, top-down 3/4 view, no
  > characters, no UI, 16:9"
- **Characters**: per agent, eight standalone **128×128** transparent frames —
  `<id>_<dir>_<0|1>.png` for `dir` ∈ `down/left/right/up` (a 2-frame walk cycle
  each), plus `<id>.png` as the idle portrait. The direction is in the filename,
  so there's no sheet-row ordering to get wrong. Sprites render with a
  drop-shadow ellipse so they sit naturally on the painting. If any of an
  agent's eight frames is missing, that agent degrades to a small generated
  pixel sprite (`client/src/textures.ts`).

### Bridge overlay (optional, for depth)

Agents render on top of the painted bridge. To make the crossing feel layered —
the front railing passing *in front of* an agent on the deck — drop a
transparent **front-railing-only** PNG (sized to the 1920×1080 scene) at
`client/public/assets/bridge_overlay.png`. It's drawn above the agents
automatically; if absent, nothing breaks (agents just render over the whole
painted bridge). The bundled background's bridge has its railing baked in, so
this overlay is the only way to get the in-front layering.

### Tuning the world to your image (press `G`)

The walkability grid, locations, and bridge path are hand-tuned to the image in
`server/worldConfig.ts`. Press **G** in the browser to toggle a translucent
overlay showing the grid, every blocked rectangle (red, labeled), each
location's center + arrival radius (green), and the **bridge crossing path**
(orange waypoints). Edit the config, save — in dev the
server restarts and the page reloads itself — then compare again. The default
config matches the bundled painting (campfire plaza center, cabins at the
edges, stream + bridge bottom-left).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server (tsx watch, :3001) + client (Vite, :5173) together. |
| `npm run build` | Builds the client to `client/dist`. |
| `npm start` | Runs the server; serves `client/dist` if present (production mode). |
| `npm run typecheck` | Type-checks both server and client. |

## Controls

- **⏸ Pause / ▶ Play** — freezes the simulation and all API spend.
- **Speed** — 0.5× / 1× / 2× tick rate.
- **Clock** — top bar shows `Day N · HH:MM` + time-of-day; **4 real hours = 1
  virtual day** at 1× (the clock resets each day). Speed scales it (2× → 2 real
  hours/day).
- **Villagers panel** (top-right) — a live card per agent: current action, last
  thought, energy, state, and assigned task. Click **✎ task** to assign or
  clear a task; click a villager's **name** to filter the log to them.
- **Chat bar** (bottom-right) — pick a target (a villager or **Everyone**), type,
  and press Enter. The agent hears you (it enters their memory), replies with a
  speech bubble + log line, and may act on it next decision.
- **G** (over the world) — toggle the walkability/locations/bridge debug overlay.
- **autoscroll** — unchecks itself when you scroll up to read history.

## v2 ideas (deliberately out of scope)

Persistence/save files · player-controlled character · vector-DB memory retrieval ·
day-night visuals · sound · more than ~6 agents · mobile layout ·
depth-sorting agents behind foreground objects (agents always render on top of
the background) · structured outputs (`output_config.format`) instead of
defensive JSON parsing.
