import type { Server as HTTPServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { ProtocolAgent } from '../agent/protocol/agent.js';
import type { AgentRegistry } from './agent-registry.js';
import type { EventEmitter } from 'node:events';

export function setupWebSocket(
  httpServer: HTTPServer,
  registry: AgentRegistry,
  events: EventEmitter
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  const subscribers = new Map<string, Set<WebSocket>>();

  // Listen for meeting events and broadcast to subscribers
  events.on('transcript', (meetingId: string, msg: unknown) => {
    broadcast(meetingId, { type: 'meeting_event', event: 'transcript_append', meetingId, message: msg });
  });
  events.on('phase', (meetingId: string, phase: string) => {
    broadcast(meetingId, { type: 'meeting_event', event: 'phase_change', meetingId, phase });
  });
  events.on('status', (meetingId: string, status: string) => {
    broadcast(meetingId, { type: 'meeting_event', event: 'status_change', meetingId, status });
  });
  events.on('turn_start', (meetingId: string, agentName: string) => {
    broadcast(meetingId, { type: 'meeting_event', event: 'turn_start', meetingId, agentName });
  });
  events.on('turn_end', (meetingId: string, agentName: string) => {
    broadcast(meetingId, { type: 'meeting_event', event: 'turn_end', meetingId, agentName });
  });

  function broadcast(meetingId: string, data: unknown): void {
    const sockets = subscribers.get(meetingId);
    if (!sockets) return;
    const payload = JSON.stringify(data);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

    if (url.pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleConnection(ws, registry, subscribers);
      });
    } else {
      socket.destroy();
    }
  });

  return wss;
}

function handleConnection(
  ws: WebSocket,
  registry: AgentRegistry,
  subscribers: Map<string, Set<WebSocket>>
): void {
  let agent: ProtocolAgent | null = null;
  let mode: 'agent' | 'client' | null = null;

  const timeout = setTimeout(() => {
    if (!mode) {
      ws.close(4001, 'Registration timeout — send register or subscribe within 10s');
    }
  }, 10_000);

  ws.on('message', (data) => {
    let msg: { type: string; [key: string]: unknown };

    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    // First message determines connection mode
    if (!mode) {
      if (msg.type === 'subscribe') {
        mode = 'client';
        clearTimeout(timeout);
        handleClientSubscribe(ws, msg, subscribers);
        return;
      }
    }

    switch (msg.type) {
      case 'register': {
        if (mode === 'client') {
          ws.send(JSON.stringify({ type: 'error', message: 'Already subscribed as client' }));
          return;
        }
        if (agent) {
          ws.send(JSON.stringify({ type: 'error', message: 'Already registered' }));
          return;
        }

        mode = 'agent';
        clearTimeout(timeout);

        const id = String(msg.id ?? '');
        const name = String(msg.name ?? '');
        const capabilities = Array.isArray(msg.capabilities) ? msg.capabilities.map(String) : [];

        if (!id || !name) {
          ws.send(JSON.stringify({ type: 'error', message: 'Registration requires id and name' }));
          return;
        }

        if (registry.get(id)) {
          ws.send(JSON.stringify({ type: 'error', message: `Agent "${id}" is already registered` }));
          return;
        }

        agent = new ProtocolAgent(ws, id, name, capabilities);
        registry.register(agent);

        ws.send(JSON.stringify({ type: 'registered', id }));

        ws.on('close', () => {
          if (agent) {
            registry.unregister(agent.id).catch(() => {});
          }
        });
        break;
      }

      case 'heartbeat': {
        if (agent) {
          ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
        }
        break;
      }

      case 'unsubscribe': {
        if (mode === 'client' && typeof msg.meetingId === 'string') {
          const set = subscribers.get(msg.meetingId);
          if (set) {
            set.delete(ws);
            if (set.size === 0) subscribers.delete(msg.meetingId);
          }
        }
        break;
      }

      default: {
        break;
      }
    }
  });

  ws.on('close', () => {
    if (mode === 'client') {
      for (const [meetingId, set] of subscribers) {
        set.delete(ws);
        if (set.size === 0) subscribers.delete(meetingId);
      }
    }
  });

  ws.on('error', () => {
    if (agent) {
      registry.unregister(agent.id).catch(() => {});
    }
  });
}

function handleClientSubscribe(
  ws: WebSocket,
  msg: { meetingId?: unknown; [key: string]: unknown },
  subscribers: Map<string, Set<WebSocket>>
): void {
  const meetingId = typeof msg.meetingId === 'string' ? msg.meetingId : null;
  if (!meetingId) {
    ws.send(JSON.stringify({ type: 'error', message: 'subscribe requires meetingId' }));
    return;
  }

  let set = subscribers.get(meetingId);
  if (!set) {
    set = new Set();
    subscribers.set(meetingId, set);
  }
  set.add(ws);

  ws.send(JSON.stringify({ type: 'subscribed', meetingId }));
}
