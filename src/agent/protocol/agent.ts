import type { WebSocket } from 'ws';
import type { IAgent, AgentHealth, AgentResponse, MeetingPrompt } from '../types.js';

export class ProtocolAgent implements IAgent {
  readonly type = 'protocol';
  readonly id: string;
  readonly name: string;
  readonly capabilities: string[];
  private ws: WebSocket;
  private timeoutMs: number;
  private pendingRequests: Map<
    string,
    { resolve: (value: AgentResponse) => void; reject: (reason: Error) => void }
  > = new Map();

  constructor(ws: WebSocket, id: string, name: string, capabilities: string[], timeoutMs = 60_000) {
    this.ws = ws;
    this.id = id;
    this.name = name;
    this.capabilities = capabilities;
    this.timeoutMs = timeoutMs;

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'meeting_response' && msg.requestId) {
          const pending = this.pendingRequests.get(msg.requestId);
          if (pending) {
            this.pendingRequests.delete(msg.requestId);
            pending.resolve({ content: msg.content, metadata: msg.metadata });
          }
        }
      } catch {
        // malformed message, ignore
      }
    });
  }

  async respond(prompt: MeetingPrompt): Promise<AgentResponse> {
    const requestId = crypto.randomUUID();
    this.ws.send(
      JSON.stringify({
        type: 'meeting_prompt',
        requestId,
        ...prompt,
      })
    );

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve({
          content: `[${this.name} did not respond within the time limit]`,
        });
      }, this.timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  async health(): Promise<AgentHealth> {
    if (this.ws.readyState !== this.ws.OPEN) {
      return { status: 'offline', lastCheck: Date.now() };
    }
    try {
      const start = Date.now();
      this.ws.ping();
      return { status: 'healthy', lastCheck: Date.now(), latencyMs: Date.now() - start };
    } catch {
      return { status: 'unhealthy', lastCheck: Date.now() };
    }
  }

  async shutdown(): Promise<void> {
    this.ws.close(1000, 'agent shutdown');
  }

  isAlive(): boolean {
    return this.ws.readyState === this.ws.OPEN;
  }

  sendUpdate(meetingId: string, message: { id: string; authorName: string; content: string }): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'meeting_update',
          meetingId,
          message,
        })
      );
    }
  }
}
