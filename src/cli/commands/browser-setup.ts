import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { loadConfig } from '../../config/loader.js';
import { AgentRegistry } from '../../server/agent-registry.js';
import { JsonFileStore } from '../../persistence/json-store.js';
import { BrowserAgent } from '../../agent/browser/adapter.js';
import { getDefaultConfigPath } from '../../utils/runtime-paths.js';

export function browserSetupCommand(): Command {
  return new Command('browser-setup')
    .description('Open browser windows so you can log into chat sites before a meeting')
    .option('-c, --config <path>', 'Path to config file', getDefaultConfigPath())
    .option('-a, --agents <ids>', 'Comma-separated browser agent IDs to set up (default: all browser agents)')
    .action(async (options) => {
      let config;
      try {
        config = loadConfig(options.config);
      } catch (e) {
        console.error('Failed to load config:', (e as Error).message);
        process.exit(1);
      }

      const registry = new AgentRegistry(new JsonFileStore(config.server.dataDir));
      await registry.boot(config);

      const allBrowsers = registry.list().filter(
        (a): a is BrowserAgent => a.type === 'browser'
      );

      if (allBrowsers.length === 0) {
        console.log('No browser agents found in config.');
        await registry.shutdown();
        process.exit(0);
      }

      let browsers: BrowserAgent[];
      if (options.agents) {
        const requested = options.agents.split(',').map((s: string) => s.trim());
        browsers = allBrowsers.filter((b) => requested.includes(b.id));
        if (browsers.length === 0) {
          console.error('None of the specified agents are browser agents.');
          console.error(
            'Available browser agents:',
            allBrowsers.map((b) => b.id).join(', ')
          );
          await registry.shutdown();
          process.exit(1);
        }
      } else {
        browsers = allBrowsers;
      }

      console.log(`Opening ${browsers.length} browser window(s)...`);
      console.log('Log into each site, then return here and press Enter.');
      console.log('');

      for (const b of browsers) {
        try {
          await b.open();
          console.log(`  ${b.name} — opened`);
        } catch (e) {
          console.error(`  ${b.name} — failed: ${(e as Error).message}`);
        }
      }

      console.log('');
      console.log('Press Enter when done logging in...');

      await new Promise<void>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.on('line', () => {
          rl.close();
          resolve();
        });
      });

      console.log('Closing browser windows...');
      await registry.shutdown();
      console.log('Done. Sessions saved. You can now run meetings with browser agents.');
    });
}
