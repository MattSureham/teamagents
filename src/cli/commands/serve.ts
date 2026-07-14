import { Command } from 'commander';
import { createServer } from '../../server/index.js';
import { openUrl } from '../../utils/open-url.js';
import { getDefaultConfigPath } from '../../utils/runtime-paths.js';

export function serveCommand(): Command {
  return new Command('serve')
    .description('Start the Agent Meetings server')
    .option('-p, --port <port>', 'Port to listen on')
    .option('-c, --config <path>', 'Path to config file', getDefaultConfigPath())
    .option('-d, --data-dir <path>', 'Data directory for persistence')
    .option('--no-mcp', 'Disable the MCP server endpoint (/mcp)')
    .option('--mcp-stdio', 'Run MCP server on stdin/stdout instead of HTTP')
    .option('--ws-token <token>', 'Fixed WebSocket auth token (random if omitted)')
    .option('--open', 'Open the web UI after the server starts')
    .action(async (options) => {
      const configPath = options.config;

      try {
        const server = await createServer(configPath);
        await server.start();

        if (options.open) {
          try {
            openUrl(server.url);
            console.log(`Opening ${server.url} in your browser.`);
          } catch {
            console.log(`Open ${server.url} in your browser.`);
          }
        }

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
