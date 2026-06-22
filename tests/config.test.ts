import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function writeTempConfig(name: string, content: string): string {
  const dir = join(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}

describe('Config Loader', () => {
  it('loads and interpolates a valid config', () => {
    const path = writeTempConfig(
      'test-config.yml',
      `
server:
  port: 4200
  host: "0.0.0.0"
  dataDir: "./data"

agents:
  - id: test-agent
    name: "Test Agent"
    type: llm
    capabilities: [general]
    provider: openai
    model: gpt-4o
    apiKey: "\${TEST_API_KEY}"

meetings:
  turnTimeoutMs: 30000
  maxRebuttalRounds: 2
  maxDeliberationRounds: 5
  defaultModerator: test-agent
`.trim()
    );

    process.env.TEST_API_KEY = 'test-key-123';
    const config = loadConfig(path);
    delete process.env.TEST_API_KEY;

    expect(config.server.port).toBe(4200);
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].id).toBe('test-agent');

    if (config.agents[0].type === 'llm') {
      expect(config.agents[0].apiKey).toBe('test-key-123');
    }
    expect(config.meetings.turnTimeoutMs).toBe(30000);
    expect(config.meetings.maxRebuttalRounds).toBe(2);

    unlinkSync(path);
  });

  it('throws on invalid config', () => {
    const path = writeTempConfig(
      'bad-config.yml',
      'server: { port: 4200 }'
    );

    expect(() => loadConfig(path)).toThrow();
    unlinkSync(path);
  });

  it('throws on duplicate agent ids', () => {
    const path = writeTempConfig(
      'dupe-config.yml',
      `
server:
  port: 4200
  host: "0.0.0.0"
  dataDir: "./data"

agents:
  - id: same
    name: "First"
    type: llm
    capabilities: []
    provider: openai
    model: gpt-4o
    apiKey: "k1"
  - id: same
    name: "Second"
    type: llm
    capabilities: []
    provider: anthropic
    model: claude
    apiKey: "k2"

meetings:
  turnTimeoutMs: 30000
  maxRebuttalRounds: 1
  maxDeliberationRounds: 5
  defaultModerator: same
`.trim()
    );

    expect(() => loadConfig(path)).toThrow();
    unlinkSync(path);
  });

  it('accepts discussion meeting mode', () => {
    const path = writeTempConfig(
      'discussion-config.yml',
      `
server:
  port: 4200
  host: "0.0.0.0"
  dataDir: "./data"

agents:
  - id: facilitator
    name: "Facilitator"
    type: llm
    capabilities: [general]
    provider: openai
    model: gpt-4o
    apiKey: "test"

meetings:
  mode: discussion
  turnTimeoutMs: 30000
  maxRebuttalRounds: 1
  maxDeliberationRounds: 5
  defaultModerator: facilitator
`.trim()
    );

    const config = loadConfig(path);
    expect(config.meetings.mode).toBe('discussion');
    unlinkSync(path);
  });
});
