export enum MeetingPhase {
  // Debate phases
  OPENING = 'opening',
  POSITION = 'position',
  REBUTTAL = 'rebuttal',
  DELIBERATION = 'deliberation',
  VOTING = 'voting',
  // Collaboration phases
  PLAN = 'plan',
  BUILD = 'build',
  REVIEW = 'review',
  // Shared
  WRAPUP = 'wrapup',
  SUMMARY = 'summary',
  CONCLUDED = 'concluded',
}

export type MeetingMode = 'debate' | 'discussion' | 'collaboration';

/** @deprecated Use MeetingPhase */
export const DebatePhase = MeetingPhase;
export type DebatePhase = MeetingPhase;

export type MeetingStatus = 'pending' | 'active' | 'concluded' | 'cancelled';

export interface Message {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  phase: MeetingPhase;
  timestamp: number;
  durationMs?: number;
}

export interface PhaseTransition {
  phase: MeetingPhase;
  enteredAt: number;
  exitedAt: number | null;
}

export interface MeetingSummary {
  consensus: string;
  keyPoints: string[];
  dissentingViews: string[];
  actionItems: string[];
  voteTally?: Record<string, number>;
  deliverables?: string[];
  decisions?: string[];
}

export interface TurnManagerState {
  order: { id: string; name: string; hasSpoken: boolean }[];
  currentIdx: number;
  handRaised: string[];
  speakerHistory: string[];
}

export interface ResumePoint {
  rebuttalRound: number;
  deliberationRound?: number;
  planRound?: number;
  buildRound?: number;
  reviewRound?: number;
}

export interface StoredMeetingConfig {
  turnTimeoutMs: number;
  maxRebuttalRounds: number;
  maxDeliberationRounds: number;
  maxPlanRounds?: number;
  maxBuildRounds?: number;
  maxReviewRounds?: number;
  maxTotalRounds?: number;
  mode: string;
  workDir?: string;
  speakerOrder?: string[];
}

export interface StoredMeeting {
  id: string;
  topic: string;
  context: string;
  status: MeetingStatus;
  mode: string;
  participantIds: string[];
  moderatorId: string;
  transcript: Message[];
  phaseTimeline: PhaseTransition[];
  summary: MeetingSummary | null;
  currentTurn: string | null;
  currentPhase: string | null;
  createdAt: number;
  updatedAt?: number;
  concludedAt: number | null;
  // Checkpoint/resume fields (all optional for backward compat)
  config?: StoredMeetingConfig;
  turnManagerState?: TurnManagerState;
  resumePoint?: ResumePoint;
  contextImages?: { data: string; mimeType: string }[];
  reasonEnded?: string;
  totalTurns?: number;
  totalRounds?: number;
  lastCheckpointAt?: number;
}
