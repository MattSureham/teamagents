import { Command } from 'commander';
import { loadConfig } from '../../config/loader.js';
import { ProviderRegistry } from '../../server/provider-registry.js';
import { getDefaultConfigPath } from '../../utils/runtime-paths.js';

export function configCommand(): Command {
  const cmd = new Command('config')
    .description('Validate or show configuration');

  cmd
    .command('validate')
    .description('Validate a config file')
    .option('-c, --config <path>', 'Path to config file', getDefaultConfigPath())
    .action(async (options) => {
      try {
        loadConfig(options.config);
        console.log('Config is valid.');
      } catch (e) {
        console.error('Config validation failed:', (e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('show')
    .description('Show the current effective config')
    .option('-c, --config <path>', 'Path to config file', getDefaultConfigPath())
    .action(async (options) => {
      try {
        const config = loadConfig(options.config);
        const printout = { ...config };
        // Mask API keys
        printout.agents = printout.agents.map((a) => {
          if ('apiKey' in a && a.apiKey) {
            return { ...a, apiKey: '***' };
          }
          return a;
        });
        console.log(JSON.stringify(printout, null, 2));
      } catch (e) {
        console.error('Failed to load config:', (e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('discover')
    .description('Detect installed subprocess tools (Claude Code, Codex, etc.)')
    .action(async () => {
      const registry = new ProviderRegistry();
      const detected = registry.detectInstalled();

      console.log('\nSubprocess tools:');
      for (const [id, entry] of registry.listSubprocessTools()) {
        const found = detected.includes(id);
        console.log(`  ${found ? '✓' : '✗'} ${id} — ${entry.name}`);
        if (found) {
          console.log(`      command: ${entry.command}`);
          console.log(`      timeout: ${Math.round(entry.defaultTimeoutMs / 1000)}s`);
        }
      }

      console.log('\nLLM providers:');
      for (const [id, entry] of registry.listLLMProviders()) {
        console.log(`  • ${id} — ${entry.name} (default: ${entry.defaultModel})`);
      }

      console.log('\nBrowser sites:');
      for (const [id, entry] of registry.listBrowserSites()) {
        console.log(`  • ${id} — ${entry.name}`);
      }

      console.log(`\n${detected.length} tool(s) detected on PATH.`);
      if (detected.length > 0) {
        console.log('Add detected tools to meetings.config.yml to use them as agents.');
      }
    });

  return cmd;
}
