// The overseer dashboard: a villager roster (status, current action, energy,
// and assignable tasks) plus a chat bar to speak to the agents. All text is set
// via textContent — agent/LLM output never touches innerHTML.

import type { AgentInfo, AgentSnapshot, Dir } from './types';

export interface DashCallbacks {
  onAssignTask(agentId: string, text: string): void;
  onClearTask(agentId: string): void;
  onChat(target: string, text: string): void;
  onSelectAgent(agentId: string): void;
  /** Tessa's intake: a downscaled JPEG (base64, no data: prefix) + its filename. */
  onIntake(dataB64: string, mediaType: string, filename: string): void;
}

interface CardRefs {
  root: HTMLDivElement;
  state: HTMLSpanElement;
  energy: HTMLElement;
  act: HTMLDivElement;
  think: HTMLDivElement;
  chip: HTMLSpanElement;
  ttext: HTMLSpanElement;
  edit: HTMLDivElement;
  input: HTMLInputElement;
}

const cards = new Map<string, CardRefs>();

const cardsEl = document.getElementById('agent-cards') as HTMLDivElement;
const chatTarget = document.getElementById('chat-target') as HTMLSelectElement;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatSend = document.getElementById('chat-send') as HTMLButtonElement;
const intakeBtn = document.getElementById('intake-btn') as HTMLButtonElement;
const intakeFile = document.getElementById('intake-file') as HTMLInputElement;

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

const DIR_ARROW: Record<Dir, string> = { down: '↓', left: '←', right: '→', up: '↑' };

export function initDash(agents: AgentInfo[], cb: DashCallbacks): void {
  cardsEl.replaceChildren();
  cards.clear();

  for (const a of agents) {
    const root = document.createElement('div');
    root.className = 'agent-card';
    root.style.borderLeftColor = a.color;

    // row 1: dot + name + state + energy
    const row1 = document.createElement('div');
    row1.className = 'ac-row1';
    const dot = document.createElement('span');
    dot.className = 'dot on';
    dot.style.background = a.color;
    const name = document.createElement('span');
    name.className = 'ac-name';
    name.style.color = a.color;
    name.textContent = a.name;
    const state = document.createElement('span');
    state.className = 'ac-state';
    state.textContent = 'idle';
    const toggle = document.createElement('span');
    toggle.className = 'ac-toggle';
    toggle.textContent = '✎ task';
    toggle.title = 'Assign or clear a task';
    const energy = document.createElement('div');
    energy.className = 'ac-energy';
    const energyFill = document.createElement('i');
    energy.appendChild(energyFill);
    row1.append(dot, name, state, toggle, energy);

    // current action + thought
    const act = document.createElement('div');
    act.className = 'ac-act';
    act.textContent = 'waiting…';
    const think = document.createElement('div');
    think.className = 'ac-think';

    // task chip + text
    const task = document.createElement('div');
    task.className = 'ac-task';
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.hidden = true;
    const ttext = document.createElement('span');
    ttext.className = 'ttext none';
    ttext.textContent = 'no task';
    task.append(chip, ttext);

    // editor (hidden until toggled)
    const edit = document.createElement('div');
    edit.className = 'ac-edit';
    edit.hidden = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = 'Assign a task…';
    const assignBtn = document.createElement('button');
    assignBtn.textContent = 'Assign';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    edit.append(input, assignBtn, clearBtn);

    root.append(row1, act, think, task, edit);
    cardsEl.appendChild(root);

    // interactions
    name.style.cursor = 'pointer';
    name.title = 'Filter the log to this villager';
    name.addEventListener('click', () => cb.onSelectAgent(a.id));
    toggle.addEventListener('click', () => {
      edit.hidden = !edit.hidden;
      if (!edit.hidden) input.focus();
    });
    const assign = () => {
      const text = input.value.trim();
      if (!text) return;
      cb.onAssignTask(a.id, text);
      input.value = '';
      edit.hidden = true;
    };
    assignBtn.addEventListener('click', assign);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') assign();
      else if (e.key === 'Escape') edit.hidden = true;
    });
    clearBtn.addEventListener('click', () => cb.onClearTask(a.id));

    cards.set(a.id, { root, state, energy: energyFill, act, think, chip, ttext, edit, input });
  }

  // chat target dropdown: Everyone + each villager
  chatTarget.replaceChildren();
  const everyone = document.createElement('option');
  everyone.value = 'all';
  everyone.textContent = 'Everyone';
  chatTarget.appendChild(everyone);
  for (const a of agents) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    chatTarget.appendChild(opt);
  }

  const sendChat = () => {
    const text = chatInput.value.trim();
    if (!text) return;
    cb.onChat(chatTarget.value, text);
    chatInput.value = '';
  };
  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // Intake photo → Tessa. The 📋 button opens a file picker; the chosen image
  // is downscaled and sent. Tessa reads it, drafts the documents, and emails them.
  intakeBtn.addEventListener('click', () => intakeFile.click());
  intakeFile.addEventListener('change', async () => {
    const file = intakeFile.files?.[0];
    intakeFile.value = ''; // allow re-selecting the same file later
    if (!file) return;
    intakeBtn.disabled = true;
    try {
      const b64 = await fileToDownscaledJpegB64(file);
      cb.onIntake(b64, 'image/jpeg', file.name || 'intake.jpg');
    } catch {
      // createImageBitmap can reject on a non-image / corrupt file — ignore quietly.
    } finally {
      intakeBtn.disabled = false;
    }
  });
}

function actionPhrase(s: AgentSnapshot): string {
  if (s.state === 'crossing_bridge') return '🌉 crossing the bridge';
  if (s.state === 'talking') return '💬 in conversation';
  switch (s.action) {
    case 'move_to':
      return `➡️ heading to ${s.target ?? '…'} ${DIR_ARROW[s.dir]}`;
    case 'work':
      return `🔨 working at ${s.target ?? '…'}`;
    case 'talk_to':
      return `💬 going to talk to ${s.target ?? '…'}`;
    case 'rest':
      return '😴 resting';
    case 'wander':
      return '🚶 wandering';
    default:
      return '🧍 idle';
  }
}

export function updateDash(snaps: AgentSnapshot[]): void {
  for (const s of snaps) {
    const c = cards.get(s.id);
    if (!c) continue;
    c.state.textContent = s.state === 'crossing_bridge' ? 'crossing' : s.state;
    c.energy.style.width = `${Math.max(0, Math.min(100, s.energy))}%`;
    c.energy.style.background = s.energy >= 60 ? '#3fb950' : s.energy >= 30 ? '#d29922' : '#f85149';
    c.act.textContent = actionPhrase(s);
    c.think.textContent = s.lastThought ? `“${s.lastThought}”` : '';

    if (s.task) {
      c.chip.hidden = false;
      c.chip.className = `chip ${s.task.status}`;
      c.chip.textContent = s.task.status;
      c.ttext.className = 'ttext';
      c.ttext.textContent = s.task.text;
      c.ttext.title = s.task.note ? `${s.task.text}\n— ${s.task.note}` : s.task.text;
    } else {
      c.chip.hidden = true;
      c.ttext.className = 'ttext none';
      c.ttext.textContent = 'no task';
      c.ttext.title = '';
    }
  }
}
