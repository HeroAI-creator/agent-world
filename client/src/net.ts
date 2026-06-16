// WebSocket client with auto-reconnect. On reconnect after a server restart the
// page reloads — the cheapest way to rebuild the whole scene from fresh state.

import type { InitData, ServerMsg } from './types';

export interface NetHandlers {
  onInit(init: InitData): void;
  onMsg(msg: ServerMsg): void;
  onStatus(connected: boolean): void;
}

export interface Net {
  sendControl(action: 'toggle_pause' | 'set_speed', value?: number): void;
  sendTask(action: 'assign' | 'clear', agentId: string, text?: string): void;
  sendChat(target: string, text: string): void;
}

export function connect(handlers: NetHandlers): Net {
  let ws: WebSocket | null = null;
  let everInit = false;

  // Where the simulation server lives. In dev and single-host prod it's the
  // same origin (Vite proxies /ws → :3001; in prod the server serves the
  // client). For a split deploy — static client on Vercel, WS server on
  // Railway — set VITE_SERVER_URL at build time to the server's URL, e.g.
  //   VITE_SERVER_URL=https://agent-world-production.up.railway.app
  const wsEndpoint = (): string => {
    const configured = import.meta.env.VITE_SERVER_URL?.trim();
    if (configured) {
      const u = new URL(configured);
      const proto = u.protocol === 'https:' ? 'wss' : 'ws';
      return `${proto}://${u.host}/ws`;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  };

  const open = () => {
    ws = new WebSocket(wsEndpoint());

    ws.onopen = () => handlers.onStatus(true);

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === 'init') {
        if (everInit) {
          // Server restarted mid-session — full reload keeps state simple.
          location.reload();
          return;
        }
        everInit = true;
        handlers.onInit(msg);
        return;
      }
      handlers.onMsg(msg);
    };

    ws.onclose = () => {
      handlers.onStatus(false);
      setTimeout(open, 1500);
    };

    ws.onerror = () => ws?.close();
  };

  open();

  const send = (obj: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  return {
    sendControl(action, value) {
      send({ type: 'control', action, value });
    },
    sendTask(action, agentId, text) {
      send({ type: 'task', action, agentId, text });
    },
    sendChat(target, text) {
      send({ type: 'chat', target, text });
    },
  };
}
