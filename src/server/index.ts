import { createServer as createHTTPServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config/loader.js';
import { JsonFileStore } from '../persistence/json-store.js';
import { AgentRegistry } from './agent-registry.js';
import { createRouter } from './http-routes.js';
import { setupWebSocket } from './websocket.js';

export interface ServerInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  registry: AgentRegistry;
}

export async function createServer(configPath?: string): Promise<ServerInstance> {
  const config = loadConfig(configPath);
  const store = new JsonFileStore(config.server.dataDir);
  await store.init();

  const registry = new AgentRegistry(store);
  await registry.boot(config);
  registry.printDetectedHints();

  const meetingEvents = new EventEmitter();

  const router = createRouter(registry, store, config, meetingEvents);
  const httpServer = createHTTPServer(router);

  const authToken = config.server.wsToken ?? randomBytes(16).toString('hex');
  const wss = setupWebSocket(httpServer, registry, meetingEvents, authToken);

  return {
    start(): Promise<void> {
      return new Promise((resolve) => {
        httpServer.listen(config.server.port, config.server.host, () => {
          const displayHost = config.server.host === '0.0.0.0' ? 'localhost' : config.server.host;
          console.log(`Agent Meetings server listening on http://${displayHost}:${config.server.port}`);
          console.log(`WebSocket token: ${authToken}`);
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      // Cancel all meetings first (aborts in-progress agent calls)
      router.cancelAllMeetings();
      // Shutdown agents immediately — kills subprocesses, closes browsers
      await registry.shutdown().catch(() => {});
      // Then close sockets
      wss.close();
      httpServer.close();
    },

    registry,
  };
}
