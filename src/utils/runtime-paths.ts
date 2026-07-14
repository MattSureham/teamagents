import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Root directory for persistent Agent Meetings state that is not covered by
 * the configured meeting data directory (currently browser profiles).
 */
export function getAgentMeetingsHome(): string {
  const configured = process.env.AGENT_MEETINGS_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), '.agent-meetings');
}

/** Resolve the dotenv file, allowing launchers to keep it outside process.cwd(). */
export function getEnvFilePath(): string {
  const configured = process.env.AGENT_MEETINGS_ENV_FILE?.trim();
  return resolve(configured || '.env');
}

/** Default config path used by CLI commands and portable launchers. */
export function getDefaultConfigPath(): string {
  return process.env.AGENT_MEETINGS_CONFIG?.trim() || './meetings.config.yml';
}
