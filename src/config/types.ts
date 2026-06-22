import type { MeetingMode } from '../meeting/types.js';

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  wsToken?: string;
}

export interface SubprocessAgentDef {
  id: string;
  name: string;
  type: 'subprocess';
  tool: string;
  capabilities: string[];
  command: string;
  args: string[];
  promptMode?: 'argument' | 'stdin' | 'file';
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface LLMAgentDef {
  id: string;
  name: string;
  type: 'llm';
  capabilities: string[];
  provider: string;
  model: string;
  apiKey: string;
  endpoint?: string;
  vision?: boolean;
}

export interface BrowserAgentDef {
  id: string;
  name: string;
  type: 'browser';
  capabilities: string[];
  site: 'chatgpt' | 'claude' | 'gemini' | 'deepseek';
  timeoutMs?: number;
}

export interface ProtocolAgentDef {
  id: string;
  name: string;
  type: 'protocol';
  capabilities: string[];
  timeoutMs?: number;
}

export type AgentDef = SubprocessAgentDef | LLMAgentDef | BrowserAgentDef | ProtocolAgentDef;

export interface MeetingsConfig {
  mode: MeetingMode;
  turnTimeoutMs: number;
  maxRebuttalRounds: number;
  maxDeliberationRounds: number;
  maxPlanRounds: number;
  maxBuildRounds: number;
  maxReviewRounds: number;
  maxTotalRounds: number;
  defaultModerator: string;
  presets?: Record<string, { agents: string[]; moderator?: string }>;
  worktree?: {
    enabled?: boolean;
    baseRef?: string;
    setupCommand?: string;
    archiveOnTeardown?: boolean;
  };
}

export interface Config {
  server: ServerConfig;
  agents: AgentDef[];
  meetings: MeetingsConfig;
}
