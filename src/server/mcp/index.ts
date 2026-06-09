import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { DataStore } from '../../persistence/types.js';
import type { Config } from '../../config/types.js';
import type { RunningMeeting } from '../http-routes.js';
import { registerAllTools } from './tools.js';

export function setupMCP(
  registry: AgentRegistry,
  store: DataStore,
  config: Config,
  meetings: Map<string, RunningMeeting>
) {
  const server = new McpServer({
    name: 'agent-meetings',
    version: '2.0.0',
  });

  registerAllTools(server, { registry, store, config, meetings });

  // Track active SSE transports by session ID
  const transports = new Map<string, SSEServerTransport>();

  async function handleSSE(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET') {
      const transport = new SSEServerTransport('/mcp', res);
      transports.set(transport.sessionId, transport);

      res.on('close', () => {
        transports.delete(transport.sessionId);
      });

      await server.connect(transport);
      return;
    }

    if (req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing sessionId query parameter' }));
        return;
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(405);
    res.end();
  }

  return { handleSSE };
}
