import { Command } from 'commander';
import { createServer } from '../../server/index.js';

export function serveCommand(): Command {
  return new Command('serve')
    .description('Start the Agent Meetings server')
    .option('-p, --port <port>', 'Port to listen on')
    .option('-c, --config <path>', 'Path to config file', './meetings.config.yml')
    .option('-d, --data-dir <path>', 'Data directory for persistence')
    .option('--no-mcp', 'Disable the MCP server endpoint (/mcp)')
    .option('--mcp-stdio', 'Run MCP server on stdin/stdout instead of HTTP')
    .option('--ws-token <token>', 'Fixed WebSocket auth token (random if omitted)')
    .action(async (options) => {
      const configPath = options.config;

      try {
        const server = await createServer(configPath);
        await server.start();

        const shutdown = async () => {
          console.log('\nShutting down...');
          await server.stop();
          process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (e) {
        console.error('Failed to start server:', e);
        process.exit(1);
      }
    });
}
