import { Command } from 'commander';
import { WebSocket } from 'ws';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

export function connectCommand(): Command {
  return new Command('connect')
    .description('Connect as a remote agent to a running Agent Meetings server')
    .requiredOption('--server <url>', 'WebSocket server URL (e.g. ws://localhost:3000)')
    .requiredOption('--token <token>', 'WebSocket auth token')
    .requiredOption('--id <id>', 'Agent ID to register as')
    .requiredOption('--name <name>', 'Display name for this agent')
    .option('--command <cmd>', 'Shell command to run for each prompt (receives prompt via stdin)')
    .option('--capabilities <list>', 'Comma-separated list of capabilities', 'general')
    .option('--timeout <ms>', 'Response timeout in ms', '120000')
    .action(async (options) => {
      const serverUrl = options.server.replace(/\/+$/, '');
      const capabilities = options.capabilities.split(',').map((s: string) => s.trim()).filter(Boolean);
      const responseTimeout = parseInt(options.timeout, 10);

      const wsUrl = `${serverUrl}/ws`;

      let ws: WebSocket | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let reconnectDelay = 1000;
      const maxReconnectDelay = 30_000;

      function connect(): void {
        console.error(`Connecting to ${serverUrl} as "${options.name}" (${options.id})...`);
        ws = new WebSocket(wsUrl);

        ws.on('open', () => {
          console.error('Connected. Registering...');
          reconnectDelay = 1000;
          ws!.send(JSON.stringify({
            type: 'register',
            id: options.id,
            name: options.name,
            capabilities,
            token: options.token,
          }));
        });

        ws.on('message', (data) => {
          let msg: any;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }

          switch (msg.type) {
            case 'registered':
              console.error(`Registered as "${options.id}". Waiting for meeting prompts...`);
              break;

            case 'meeting_prompt': {
              const requestId = msg.requestId as string;
              const promptText = msg.currentPrompt as string;
              const meetingId = msg.meetingId as string;
              const phase = msg.phase as string;
              console.error(`\n[${meetingId}] Prompt received (phase: ${phase})`);

              handlePrompt(requestId, promptText).then((response) => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'meeting_response',
                    requestId,
                    content: response,
                  }));
                }
              });
              break;
            }

            case 'meeting_update': {
              const update = msg.message;
              if (update) {
                console.error(`  [${update.authorName}]: ${update.content.slice(0, 120)}${update.content.length > 120 ? '...' : ''}`);
              }
              break;
            }

            case 'error':
              console.error(`Server error: ${msg.message}`);
              break;

            case 'heartbeat_ack':
              break;
          }
        });

        ws.on('close', (code) => {
          console.error(`Disconnected (code: ${code}). Reconnecting in ${Math.round(reconnectDelay / 1000)}s...`);
          ws = null;
          scheduleReconnect();
        });

        ws.on('error', (err) => {
          console.error(`Connection error: ${err.message}`);
        });
      }

      function scheduleReconnect(): void {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
          connect();
        }, reconnectDelay);
      }

      async function handlePrompt(requestId: string, promptText: string): Promise<string> {
        if (options.command) {
          return runSubprocess(options.command, promptText, responseTimeout);
        }
        return readFromStdin(requestId, promptText);
      }

      function runSubprocess(cmd: string, input: string, timeout: number): Promise<string> {
        return new Promise((resolve) => {
          try {
            const stdout = execSync(cmd, {
              input,
              timeout,
              encoding: 'utf-8',
              maxBuffer: 10 * 1024 * 1024,
              stdio: ['pipe', 'pipe', 'ignore'],
            });
            resolve(stdout.trim() || `[${options.name} produced no output]`);
          } catch (e: any) {
            const output = e.stdout || e.stderr || e.message || `[${options.name} encountered an error]`;
            resolve(typeof output === 'string' ? output : output.toString());
          }
        });
      }

      function readFromStdin(requestId: string, promptText: string): Promise<string> {
        return new Promise((resolve) => {
          // Print the prompt to stdout for the user
          console.log(`\n=== MEETING PROMPT (${requestId}) ===`);
          console.log(promptText);
          console.log('=== END PROMPT ===');
          console.log('Enter your response (end with a line containing only "." or send EOF):');

          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const lines: string[] = [];
          let resolved = false;

          const finish = () => {
            if (resolved) return;
            resolved = true;
            rl.close();
            resolve(lines.join('\n') || `[${options.name} had no input]`);
          };

          rl.on('line', (line) => {
            if (line === '.') {
              finish();
            } else {
              lines.push(line);
            }
          });

          rl.on('close', finish);

          setTimeout(() => {
            if (!resolved) {
              console.error('Response timeout — sending whatever was typed.');
              finish();
            }
          }, responseTimeout);
        });
      }

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        console.error('\nShutting down...');
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (ws) {
          ws.close(1000, 'agent shutdown');
        }
        process.exit(0);
      });

      connect();
    });
}
