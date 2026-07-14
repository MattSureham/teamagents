import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import type { Config, AgentDef } from './types.js';
import { getDefaultConfigPath, getEnvFilePath } from '../utils/runtime-paths.js';

function loadEnvFile(): void {
  const envPath = getEnvFilePath();
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function loadCcSwitchEnv(): void {
  const dbPath = resolve(homedir(), '.cc-switch', 'cc-switch.db');
  if (!existsSync(dbPath)) return;

  try {
    const raw = execSync(
      `sqlite3 -readonly -json "${dbPath}" "SELECT id, app_type, name, settings_config FROM providers WHERE settings_config IS NOT NULL"`,
      { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    if (!raw.trim()) return;

    const rows = JSON.parse(raw) as Array<{ id: string; app_type: string; name: string; settings_config: string }>;

    for (const row of rows) {
      try {
        const cfg = JSON.parse(row.settings_config);
        let key: string | null = null;
        let baseUrl = '';

        if (row.app_type === 'claude' && cfg.env?.ANTHROPIC_AUTH_TOKEN) {
          key = cfg.env.ANTHROPIC_AUTH_TOKEN;
          baseUrl = cfg.env.ANTHROPIC_BASE_URL ?? '';
        } else if (row.app_type === 'openclaw' && cfg.apiKey) {
          key = cfg.apiKey;
          baseUrl = cfg.baseUrl ?? '';
        } else {
          continue;
        }

        if (!key) continue;

        const envVar = guessEnvVar(baseUrl, row.name, row.id);
        if (envVar && !(envVar in process.env)) {
          process.env[envVar] = key;
        }
      } catch {
        // skip malformed provider rows
      }
    }
  } catch {
    // cc-switch DB doesn't exist on this machine, or sqlite3 is not available
  }
}

function guessEnvVar(baseUrl: string, name: string, id: string): string | null {
  const url = baseUrl.toLowerCase();
  const label = (name + ' ' + id).toLowerCase();

  if (url.includes('deepseek') || label.includes('deepseek')) return 'DEEPSEEK_API_KEY';
  if (url.includes('api.minimaxi.com')) return 'MINIMAX_CN_API_KEY';
  if (url.includes('api.minimax.io') || url.includes('api.minimax.com') || label.includes('minimax')) return 'MINIMAX_API_KEY';
  if (url.includes('api.kimi.com')) return 'KIMI_API_KEY';
  if (url.includes('api.moonshot')) return 'MOONSHOT_API_KEY';
  if (url.includes('qwen') || label.includes('qwen')) return 'QWEN_API_KEY';
  if (url.includes('anthropic') || label.includes('claude')) return 'ANTHROPIC_API_KEY';
  if (url.includes('openai') || label.includes('openai')) return 'OPENAI_API_KEY';
  if (url.includes('generativelanguage') || label.includes('gemini')) return 'GEMINI_API_KEY';

  return null;
}

export function loadConfig(path?: string): Config {
  loadEnvFile();
  loadCcSwitchEnv();
  const configPath = resolve(path ?? getDefaultConfigPath());

  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\n` +
      `Copy meetings.config.example.yml to meetings.config.yml to get started, or run: am config discover`
    );
  }

  const raw = readFileSync(configPath, 'utf-8');
  const interpolated = interpolateEnv(raw);
  const parsed = parseYaml(interpolated);

  const config = parsed as Config;

  validateConfig(config);

  config.agents = config.agents.map((agent) => ({
    ...agent,
    capabilities: agent.capabilities ?? [],
  }));

  warnMissingEnvVars(config.agents);

  return config;
}

const missingEnvVars: string[] = [];

function interpolateEnv(raw: string): string {
  return raw.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_, name, fallback) => {
    const value = process.env[name];
    if (!value) {
      missingEnvVars.push(name);
      return fallback ?? '';
    }
    return value;
  });
}

function warnMissingEnvVars(agents: AgentDef[]): void {
  if (missingEnvVars.length > 0) {
    const unique = [...new Set(missingEnvVars)];
    console.warn('⚠  The following environment variables are referenced in your config but not set:');
    for (const v of unique) {
      console.warn(`   $${v}`);
    }
    const affected = agents.filter((a) =>
      'apiKey' in a && a.apiKey === ''
    );
    if (affected.length > 0) {
      console.warn('   Affected agents:', affected.map((a) => a.id).join(', '));
      console.warn('   These agents may fail when called.');
    }
    console.warn();
  }
}

function validateConfig(config: Config): void {
  if (!config.server) {
    throw new Error('Config must have a `server` section');
  }
  if (!config.server.port || !config.server.host) {
    throw new Error('Server config requires `port` and `host`');
  }
  if (!Array.isArray(config.agents)) {
    throw new Error('Config must have an `agents` array');
  }
  if (!config.meetings) {
    throw new Error('Config must have a `meetings` section');
  }

  const ids = new Set<string>();
  for (const agent of config.agents) {
    if (!agent.id || !agent.name) {
      throw new Error('Each agent must have `id` and `name`');
    }
    if (ids.has(agent.id)) {
      throw new Error(`Duplicate agent id: ${agent.id}`);
    }
    ids.add(agent.id);

    if (agent.type === 'subprocess') {
      if (!agent.command) {
        throw new Error(`Subprocess agent "${agent.id}" requires a command`);
      }
    }
    if (agent.type === 'llm') {
      if (!agent.provider || !agent.model) {
        throw new Error(`LLM agent "${agent.id}" requires provider and model`);
      }
    }
    if (agent.type === 'browser') {
      if (!agent.site) {
        throw new Error(`Browser agent "${agent.id}" requires a site`);
      }
    }
  }

  if (config.meetings.defaultModerator && !ids.has(config.meetings.defaultModerator)) {
    throw new Error(
      `defaultModerator "${config.meetings.defaultModerator}" not found in agents`
    );
  }

  if (
    config.meetings.mode &&
    !['debate', 'discussion', 'collaboration'].includes(config.meetings.mode)
  ) {
    throw new Error(`meetings.mode must be "debate", "discussion", or "collaboration"`);
  }

  // Apply defaults
  config.server.dataDir = config.server.dataDir ?? './data';
  config.meetings.mode = config.meetings.mode ?? 'debate';
  config.meetings.maxRebuttalRounds = config.meetings.maxRebuttalRounds ?? 1;
  config.meetings.maxDeliberationRounds = config.meetings.maxDeliberationRounds ?? 3;
  config.meetings.maxPlanRounds = config.meetings.maxPlanRounds ?? 1;
  config.meetings.maxBuildRounds = config.meetings.maxBuildRounds ?? 3;
  config.meetings.maxReviewRounds = config.meetings.maxReviewRounds ?? 1;
  config.meetings.maxTotalRounds = config.meetings.maxTotalRounds ?? 50;
  config.meetings.turnTimeoutMs = config.meetings.turnTimeoutMs ?? 60_000;
}
