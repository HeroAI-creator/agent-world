// The terminal-style agent log: append, color-code, filter, autoscroll, API stats.
// All text is inserted via textContent — LLM output never touches innerHTML.

import type { AgentInfo, LlmStats, LogEvent } from './types';

const MAX_ROWS = 600;

const linesEl = document.getElementById('log-lines') as HTMLDivElement;
const statsEl = document.getElementById('log-stats') as HTMLDivElement;
const filterSel = document.getElementById('filter-select') as HTMLSelectElement;
const autoscrollChk = document.getElementById('autoscroll-chk') as HTMLInputElement;
const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement;

let filter = 'all';

export function initLogControls(onFilterChange?: (id: string) => void): void {
  filterSel.addEventListener('change', () => {
    setFilter(filterSel.value);
    onFilterChange?.(filterSel.value);
  });
  clearBtn.addEventListener('click', () => {
    linesEl.replaceChildren();
  });
  // Pause autoscroll automatically when the user scrolls up to read.
  linesEl.addEventListener('wheel', () => {
    const nearBottom = linesEl.scrollHeight - linesEl.scrollTop - linesEl.clientHeight < 40;
    if (!nearBottom && autoscrollChk.checked) autoscrollChk.checked = false;
  });
}

export function populateFilter(agents: AgentInfo[]): void {
  for (const a of agents) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    filterSel.appendChild(opt);
  }
}

export function setFilter(id: string): void {
  filter = id;
  if (filterSel.value !== id) filterSel.value = id;
  for (const row of Array.from(linesEl.children) as HTMLElement[]) {
    row.style.display = filter === 'all' || row.dataset.agent === filter ? '' : 'none';
  }
  linesEl.scrollTop = linesEl.scrollHeight;
}

export function appendLog(e: LogEvent): void {
  const row = document.createElement('div');
  row.className = `row k-${e.kind}`;
  row.dataset.agent = e.agentId ?? 'system';

  const time = document.createElement('span');
  time.className = 't';
  time.textContent = `[${new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false })}] `;
  row.appendChild(time);

  if (e.name) {
    const name = document.createElement('span');
    name.className = 'n';
    name.style.color = e.color ?? '#e6edf3';
    name.textContent = `[${e.name}] `;
    row.appendChild(name);
  }

  const icon = document.createElement('span');
  icon.textContent = `${e.icon}  `;
  row.appendChild(icon);

  const text = document.createElement('span');
  text.className = 'x';
  text.textContent = e.text;
  row.appendChild(text);

  if (filter !== 'all' && row.dataset.agent !== filter) row.style.display = 'none';

  linesEl.appendChild(row);
  while (linesEl.children.length > MAX_ROWS) linesEl.removeChild(linesEl.firstChild!);
  if (autoscrollChk.checked) linesEl.scrollTop = linesEl.scrollHeight;
}

export function appendSystem(text: string, warn = false): void {
  appendLog({ ts: Date.now(), icon: warn ? '⚠️' : '⭐', text, kind: warn ? 'warn' : 'system' });
}

const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function updateStats(s: LlmStats): void {
  statsEl.textContent =
    `API: ${s.calls} calls (${s.callsPerMin}/min) · tokens in ${fmtTok(s.inputTokens)} / out ${fmtTok(s.outputTokens)}` +
    ` · est. cost $${s.estCostUsd.toFixed(4)}`;
}
