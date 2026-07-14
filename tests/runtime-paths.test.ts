import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  getAgentMeetingsHome,
  getDefaultConfigPath,
  getEnvFilePath,
} from '../src/utils/runtime-paths.js';

const originalHome = process.env.AGENT_MEETINGS_HOME;
const originalEnvFile = process.env.AGENT_MEETINGS_ENV_FILE;
const originalConfig = process.env.AGENT_MEETINGS_CONFIG;

afterEach(() => {
  restoreEnv('AGENT_MEETINGS_HOME', originalHome);
  restoreEnv('AGENT_MEETINGS_ENV_FILE', originalEnvFile);
  restoreEnv('AGENT_MEETINGS_CONFIG', originalConfig);
});

describe('runtime paths', () => {
  it('uses platform defaults when portable overrides are not set', () => {
    delete process.env.AGENT_MEETINGS_HOME;
    delete process.env.AGENT_MEETINGS_ENV_FILE;
    delete process.env.AGENT_MEETINGS_CONFIG;

    expect(getAgentMeetingsHome()).toBe(join(homedir(), '.agent-meetings'));
    expect(getEnvFilePath()).toBe(resolve('.env'));
    expect(getDefaultConfigPath()).toBe('./meetings.config.yml');
  });

  it('resolves portable state and env overrides', () => {
    process.env.AGENT_MEETINGS_HOME = './portable data';
    process.env.AGENT_MEETINGS_ENV_FILE = './portable config/settings.env';
    process.env.AGENT_MEETINGS_CONFIG = './portable config/meetings.config.yml';

    expect(getAgentMeetingsHome()).toBe(resolve('./portable data'));
    expect(getEnvFilePath()).toBe(resolve('./portable config/settings.env'));
    expect(getDefaultConfigPath()).toBe('./portable config/meetings.config.yml');
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
