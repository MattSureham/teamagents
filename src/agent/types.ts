import type { DebatePhase } from '../meeting/types.js';

export interface AgentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'offline';
  lastCheck: number;
  latencyMs?: number;
  error?: string;
}

export interface MeetingPrompt {
  meetingId: string;
  phase: DebatePhase;
  topic: string;
  background: string;
  contextImages?: { data: string; mimeType: string }[];
  transcript: TranscriptMessage[];
  speakingOrder: string[];
  currentPrompt: string;
  workDir?: string;
  signal?: AbortSignal;
}

export interface TranscriptMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  phase: DebatePhase;
  timestamp: number;
}

export interface AgentResponse {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface IAgent {
  readonly id: string;
  readonly name: string;
  readonly capabilities: string[];
  readonly type: 'subprocess' | 'protocol' | 'llm' | 'browser';
  readonly supportsVision?: boolean;
  readonly timeoutMs?: number;

  respond(prompt: MeetingPrompt): Promise<AgentResponse>;
  health(): Promise<AgentHealth>;
  shutdown(): Promise<void>;
}
