import { randomUUID } from 'node:crypto';
import type { IAgent, TranscriptMessage } from '../agent/types.js';
import type { LLMAdapter } from '../llm/types.js';
import type { DataStore } from '../persistence/types.js';
import {
  MeetingPhase,
  type MeetingMode,
  type MeetingStatus,
  type Message,
  type PhaseTransition,
  type MeetingSummary,
  type StoredMeeting,
  type TurnManagerState,
  type ResumePoint,
} from './types.js';
import { TurnManager } from './turn-manager.js';
import { Moderator } from './moderator.js';
import { Summarizer } from './summarizer.js';

export interface MeetingConfig {
  topic: string;
  context: string;
  contextImages?: { data: string; mimeType: string }[];
  participants: IAgent[];
  moderatorId?: string;
  mode?: MeetingMode;
  speakerOrder?: string[];
  workDir?: string;
  turnTimeoutMs?: number;
  maxRebuttalRounds?: number;
  maxDeliberationRounds?: number;
  maxPlanRounds?: number;
  maxBuildRounds?: number;
  maxReviewRounds?: number;
  maxTotalRounds?: number;
  defaultLLM?: LLMAdapter;
  onTurnStart?: (agentName: string) => void;
  onTurnEnd?: (agentName: string) => void;
  onTranscript?: (msg: Message) => void;
  onPhaseChange?: (phase: MeetingPhase) => void;
  onStatusChange?: (status: MeetingStatus) => void;
  // Resume fields
  resumeId?: string;
  resumeFrom?: ResumePoint;
  resumePhase?: MeetingPhase;
  initialTranscript?: Message[];
  initialPhaseTimeline?: PhaseTransition[];
  initialTurnManager?: TurnManagerState;
  initialContextImages?: { data: string; mimeType: string }[];
  checkpointStore?: DataStore;
}

const PHASE_ORDER_DEBATE: MeetingPhase[] = [
  MeetingPhase.OPENING,
  MeetingPhase.POSITION,
  MeetingPhase.REBUTTAL,
  MeetingPhase.DELIBERATION,
  MeetingPhase.VOTING,
];

const PHASE_ORDER_DISCUSSION: MeetingPhase[] = [
  MeetingPhase.OPENING,
  MeetingPhase.DELIBERATION,
];

const PHASE_ORDER_COLLAB: MeetingPhase[] = [
  MeetingPhase.OPENING,
  MeetingPhase.PLAN,
  MeetingPhase.BUILD,
  MeetingPhase.REVIEW,
];

export class MeetingEngine {
  readonly id: string;
  readonly topic: string;
  readonly context: string;
  readonly contextImages: { data: string; mimeType: string }[];
  readonly participantIds: string[];
  readonly moderatorId: string;
  readonly mode: MeetingMode;
  readonly speakerOrder: string[];

  status: MeetingStatus = 'pending';
  currentPhase: MeetingPhase = MeetingPhase.OPENING;
  transcript: Message[] = [];
  phaseTimeline: PhaseTransition[] = [];
  summary: MeetingSummary | null = null;
  createdAt: number;
  updatedAt?: number;
  concludedAt: number | null = null;

  private agents: Map<string, IAgent>;
  private turnManager: TurnManager;
  private moderator: Moderator;
  private summarizer: Summarizer;
  private turnTimeoutMs: number;
  private maxRebuttalRounds: number;
  private maxDeliberationRounds: number;
  private maxPlanRounds: number;
  private maxBuildRounds: number;
  private maxReviewRounds: number;
  private maxTotalRounds: number;
  private aborted = false;
  private totalTurns = 0;
  private totalRounds = 0;
  private consecutiveFailures = new Map<string, number>();
  private seenContextImages = new Set<string>();
  reasonEnded: 'completed' | 'cancelled' = 'completed';
  currentTurn: string | null = null;
  workDir: string | undefined;

  private resumePoint: ResumePoint = { rebuttalRound: 0 };
  private checkpointStore: DataStore | null = null;
  private isResuming = false;
  private abortController = new AbortController();

  constructor(config: MeetingConfig) {
    this.id = config.resumeId ?? randomUUID();
    this.topic = config.topic;
    this.context = config.context;
    this.contextImages = config.initialContextImages ?? config.contextImages ?? [];
    this.moderatorId = config.moderatorId ?? '__system_moderator__';
    this.mode = config.mode ?? 'debate';
    this.speakerOrder = this.normalizeSpeakerOrder(config.participants, config.speakerOrder);
    this.turnTimeoutMs = config.turnTimeoutMs ?? 60_000;
    this.maxRebuttalRounds = config.maxRebuttalRounds ?? 1;
    this.maxDeliberationRounds = config.maxDeliberationRounds ?? 3;
    this.maxPlanRounds = config.maxPlanRounds ?? 1;
    this.maxBuildRounds = config.maxBuildRounds ?? 3;
    this.maxReviewRounds = config.maxReviewRounds ?? 1;
    this.maxTotalRounds = config.maxTotalRounds ?? 50;
    this.createdAt = Date.now();
    this.participantIds = config.participants.map((a) => a.id);

    this.agents = new Map(config.participants.map((a) => [a.id, a]));
    this.moderator = new Moderator(config.defaultLLM ?? null, this.mode, config.workDir ?? null);
    this.workDir = config.workDir;
    this.summarizer = new Summarizer(config.defaultLLM ?? null);
    this.onTurnStart = config.onTurnStart;
    this.onTurnEnd = config.onTurnEnd;
    this.onTranscript = config.onTranscript;
    this.onPhaseChange = config.onPhaseChange;
    this.onStatusChange = config.onStatusChange;

    // Resume state
    if (config.resumeFrom) {
      this.resumePoint = { ...config.resumeFrom };
    }
    if (config.initialTranscript) {
      this.transcript = config.initialTranscript;
    }
    if (config.initialPhaseTimeline) {
      this.phaseTimeline = config.initialPhaseTimeline;
      const last = config.initialPhaseTimeline[config.initialPhaseTimeline.length - 1];
      if (last) {
        this.currentPhase = last.phase;
      }
    }
    if (config.resumePhase) {
      this.currentPhase = config.resumePhase;
    }
    if (config.initialTurnManager) {
      this.turnManager = TurnManager.fromJSON(config.initialTurnManager);
    } else {
      this.turnManager = new TurnManager();
    }
    this.checkpointStore = config.checkpointStore ?? null;
    this.isResuming = !!(
      config.resumeId ||
      config.initialTranscript ||
      config.initialPhaseTimeline
    );
  }

  static fromStoredMeeting(
    stored: StoredMeeting,
    participants: IAgent[],
    options: {
      defaultLLM?: LLMAdapter;
      onTurnStart?: (name: string) => void;
      onTurnEnd?: (name: string) => void;
      onTranscript?: (msg: Message) => void;
      onPhaseChange?: (phase: MeetingPhase) => void;
      onStatusChange?: (status: MeetingStatus) => void;
      checkpointStore?: DataStore;
      workDir?: string;
      context?: string;
      moderatorId?: string;
      mode?: MeetingMode;
      speakerOrder?: string[];
      maxRebuttalRounds?: number;
      maxDeliberationRounds?: number;
      maxPlanRounds?: number;
      maxBuildRounds?: number;
      maxReviewRounds?: number;
      maxTotalRounds?: number;
      turnTimeoutMs?: number;
    } = {}
  ): MeetingEngine {
    const storedConfig = stored.config;
    const engine = new MeetingEngine({
      topic: stored.topic,
      context: options.context ?? stored.context,
      contextImages: stored.contextImages,
      participants,
      moderatorId: options.moderatorId ?? stored.moderatorId,
      mode: (options.mode ?? storedConfig?.mode ?? stored.mode) as MeetingMode,
      speakerOrder: options.speakerOrder ?? storedConfig?.speakerOrder,
      workDir: options.workDir ?? storedConfig?.workDir ?? undefined,
      turnTimeoutMs: options.turnTimeoutMs ?? storedConfig?.turnTimeoutMs,
      maxRebuttalRounds: options.maxRebuttalRounds ?? storedConfig?.maxRebuttalRounds,
      maxDeliberationRounds: options.maxDeliberationRounds ?? storedConfig?.maxDeliberationRounds,
      maxPlanRounds: options.maxPlanRounds ?? storedConfig?.maxPlanRounds,
      maxBuildRounds: options.maxBuildRounds ?? storedConfig?.maxBuildRounds,
      maxReviewRounds: options.maxReviewRounds ?? storedConfig?.maxReviewRounds,
      maxTotalRounds: options.maxTotalRounds ?? storedConfig?.maxTotalRounds,
      defaultLLM: options.defaultLLM,
      onTurnStart: options.onTurnStart,
      onTurnEnd: options.onTurnEnd,
      onTranscript: options.onTranscript,
      onPhaseChange: options.onPhaseChange,
      onStatusChange: options.onStatusChange,
      resumeId: stored.id,
      resumeFrom: stored.resumePoint,
      resumePhase: stored.currentPhase as MeetingPhase | undefined,
      initialTranscript: stored.transcript,
      initialPhaseTimeline: stored.phaseTimeline,
      initialTurnManager: stored.turnManagerState,
      initialContextImages: stored.contextImages,
      checkpointStore: options.checkpointStore,
    });

    // Restore fields that aren't part of MeetingConfig
    engine.status = (stored.status === 'active' || stored.status === 'concluded') ? 'active' : 'pending';
    engine.createdAt = stored.createdAt;
    engine.updatedAt = Date.now();
    engine.totalTurns = stored.totalTurns ?? stored.transcript.length;
    engine.totalRounds = stored.totalRounds ?? 0;
    engine.reasonEnded = (stored.reasonEnded as 'completed' | 'cancelled') ?? 'completed';
    engine.concludedAt = stored.concludedAt;
    engine.summary = stored.summary;

    return engine;
  }

  async checkpoint(): Promise<void> {
    if (!this.checkpointStore) return;
    try {
      await this.checkpointStore.saveMeeting(this.toStoredMeeting());
    } catch {
      // best-effort — don't crash the meeting over a save failure
    }
  }

  async start(): Promise<void> {
    this.status = 'active';
    this.onStatusChange?.('active');

    if (this.mode === 'collaboration') {
      await this.runCollaboration();
    } else if (this.mode === 'discussion') {
      await this.runDiscussion();
    } else {
      await this.runDebate();
    }

    if (this.aborted) return;

    await this.advancePhase(MeetingPhase.SUMMARY);
    try {
      await this.runSummary();
    } catch (e) {
      console.error('Summary generation failed:', (e as Error).message);
      this.summary = {
        consensus: 'Summary generation failed — see transcript for details.',
        keyPoints: [],
        dissentingViews: [],
        actionItems: [],
      };
      this.addMessage(
        this.moderator.systemModeratorId,
        this.moderator.systemModeratorName,
        `=== MEETING SUMMARY (FALLBACK) ===\nTopic: ${this.topic}\nConsensus: ${this.summary.consensus}`
      );
    }
    await this.advancePhase(MeetingPhase.CONCLUDED);

    this.status = 'concluded';
    this.onStatusChange?.('concluded');
    this.concludedAt = Date.now();
    await this.checkpoint();
  }

  private phaseIdx(phase: MeetingPhase): number {
    const order =
      this.mode === 'collaboration'
        ? PHASE_ORDER_COLLAB
        : this.mode === 'discussion'
          ? PHASE_ORDER_DISCUSSION
          : PHASE_ORDER_DEBATE;
    return order.indexOf(phase);
  }

  private shouldEnterPhase(phase: MeetingPhase): boolean {
    if (!this.isResuming) return true;
    return this.phaseIdx(this.currentPhase) <= this.phaseIdx(phase);
  }

  private canRunRound(): boolean {
    return this.totalRounds < this.maxTotalRounds;
  }

  private async finishRound(): Promise<void> {
    this.totalRounds++;
    await this.checkpoint();
  }

  private async runDebate(): Promise<void> {
    // OPENING
    if (this.shouldEnterPhase(MeetingPhase.OPENING)) {
      await this.advancePhase(MeetingPhase.OPENING);
      await this.runOpening();
      if (this.aborted) return;
    }

    // POSITION
    if (this.shouldEnterPhase(MeetingPhase.POSITION)) {
      await this.advancePhase(MeetingPhase.POSITION);
      if (this.canRunRound()) {
        const roundRan = await this.runRoundRobin(MeetingPhase.POSITION);
        if (roundRan && !this.aborted) await this.finishRound();
      }
      if (this.aborted) return;
    }

    // REBUTTAL
    const startRebuttal =
      this.isResuming && this.currentPhase === MeetingPhase.REBUTTAL
        ? this.resumePoint.rebuttalRound
        : 0;
    for (let r = startRebuttal; r < this.maxRebuttalRounds && this.canRunRound(); r++) {
      this.resumePoint.rebuttalRound = r;
      await this.advancePhase(MeetingPhase.REBUTTAL);
      const roundRan = await this.runRoundRobin(MeetingPhase.REBUTTAL);
      if (this.aborted) break;
      if (!roundRan) break;
      this.resumePoint.rebuttalRound = r + 1;
      await this.finishRound();
    }
    if (this.aborted) return;

    // DELIBERATION
    if (this.shouldEnterPhase(MeetingPhase.DELIBERATION)) {
      await this.runDeliberation();
      if (this.aborted) return;
    }

    // VOTING
    if (this.shouldEnterPhase(MeetingPhase.VOTING)) {
      await this.advancePhase(MeetingPhase.VOTING);
      await this.runVoting();
    }
  }

  private async runDiscussion(): Promise<void> {
    // OPENING
    if (this.shouldEnterPhase(MeetingPhase.OPENING)) {
      await this.advancePhase(MeetingPhase.OPENING);
      await this.runOpening();
      if (this.aborted) return;
    }

    // DELIBERATION
    if (this.shouldEnterPhase(MeetingPhase.DELIBERATION)) {
      await this.runDeliberation();
    }
  }

  private async runCollaboration(): Promise<void> {
    // OPENING
    if (this.shouldEnterPhase(MeetingPhase.OPENING)) {
      await this.advancePhase(MeetingPhase.OPENING);
      await this.runOpening();
      if (this.aborted) return;
    }

    // PLAN
    if (this.shouldEnterPhase(MeetingPhase.PLAN)) {
      const startPlan =
        this.isResuming && this.currentPhase === MeetingPhase.PLAN
          ? this.resumePoint.planRound ?? 0
          : 0;
      for (let r = startPlan; r < this.maxPlanRounds && this.canRunRound(); r++) {
        this.resumePoint.planRound = r;
        await this.advancePhase(MeetingPhase.PLAN);
        const roundRan = await this.runRoundRobin(MeetingPhase.PLAN);
        if (this.aborted) break;
        if (!roundRan) break;
        this.resumePoint.planRound = r + 1;
        await this.finishRound();
      }
      if (this.aborted) return;
    }

    // BUILD
    if (this.shouldEnterPhase(MeetingPhase.BUILD)) {
      const startBuild =
        this.isResuming && this.currentPhase === MeetingPhase.BUILD
          ? this.resumePoint.buildRound ?? 0
          : 0;
      for (let r = startBuild; r < this.maxBuildRounds && this.canRunRound(); r++) {
        this.resumePoint.buildRound = r;
        await this.advancePhase(MeetingPhase.BUILD);
        const roundRan = await this.runRoundRobin(MeetingPhase.BUILD);
        if (this.aborted) break;
        if (!roundRan) break;
        this.resumePoint.buildRound = r + 1;
        await this.finishRound();
      }
      if (this.aborted) return;
    }

    // REVIEW
    if (this.shouldEnterPhase(MeetingPhase.REVIEW)) {
      const startReview =
        this.isResuming && this.currentPhase === MeetingPhase.REVIEW
          ? this.resumePoint.reviewRound ?? 0
          : 0;
      for (let r = startReview; r < this.maxReviewRounds && this.canRunRound(); r++) {
        this.resumePoint.reviewRound = r;
        await this.advancePhase(MeetingPhase.REVIEW);
        const roundRan = await this.runRoundRobin(MeetingPhase.REVIEW);
        if (this.aborted) break;
        if (!roundRan) break;
        this.resumePoint.reviewRound = r + 1;
        await this.finishRound();
      }
    }
  }

  setWorkDir(path: string): void {
    this.workDir = path;
    this.moderator.setWorkDir(path);
  }

  cancel(): void {
    this.aborted = true;
    this.status = 'cancelled';
    this.abortController.abort();
    this.onStatusChange?.('cancelled');
    if (this.phaseTimeline.length > 0) {
      const current = this.phaseTimeline[this.phaseTimeline.length - 1];
      current.exitedAt = Date.now();
    }
  }

  getSummary(): MeetingSummary | null {
    return this.summary;
  }

  toStoredMeeting(): StoredMeeting {
    const storedContext = this.contextImages.length > 0
      ? `${this.context}\n\n[${this.contextImages.length} image(s) included in context]`
      : this.context;
    return {
      id: this.id,
      topic: this.topic,
      context: storedContext,
      status: this.status,
      mode: this.mode,
      participantIds: this.participantIds,
      moderatorId: this.moderatorId,
      transcript: this.transcript,
      phaseTimeline: this.phaseTimeline,
      summary: this.summary,
      currentTurn: this.currentTurn,
      currentPhase: this.currentPhase,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      concludedAt: this.concludedAt,
      config: {
        turnTimeoutMs: this.turnTimeoutMs,
        maxRebuttalRounds: this.maxRebuttalRounds,
        maxDeliberationRounds: this.maxDeliberationRounds,
        maxPlanRounds: this.maxPlanRounds,
        maxBuildRounds: this.maxBuildRounds,
        maxReviewRounds: this.maxReviewRounds,
        maxTotalRounds: this.maxTotalRounds,
        mode: this.mode,
        workDir: this.workDir,
        speakerOrder: this.speakerOrder,
      },
      turnManagerState: this.turnManager.toJSON(),
      resumePoint: { ...this.resumePoint },
      contextImages: this.contextImages.length > 0 ? this.contextImages : undefined,
      reasonEnded: this.reasonEnded,
      totalTurns: this.totalTurns,
      totalRounds: this.totalRounds,
      lastCheckpointAt: Date.now(),
    };
  }

  private async advancePhase(phase: MeetingPhase): Promise<void> {
    if (this.phaseTimeline.length > 0) {
      const current = this.phaseTimeline[this.phaseTimeline.length - 1];
      if (current.exitedAt === null) {
        current.exitedAt = Date.now();
      }
    }
    this.currentPhase = phase;
    this.phaseTimeline.push({
      phase,
      enteredAt: Date.now(),
      exitedAt: null,
    });
    this.onPhaseChange?.(phase);
    await this.checkpoint();
  }

  private async runOpening(): Promise<void> {
    let context = this.context;
    if (this.contextImages.length > 0) {
      context += `\n\n[This meeting context includes ${this.contextImages.length} image(s). Vision-capable agents will receive them for analysis.]`;
    }
    const openingText = this.moderator.buildOpeningPrompt(
      this.topic,
      context,
      this.orderedAgents()
    );
    this.addMessage(this.moderator.systemModeratorId, this.moderator.systemModeratorName, openingText);
  }

  private normalizeSpeakerOrder(agents: IAgent[], speakerOrder?: string[]): string[] {
    const available = new Set(agents.map((a) => a.id));
    const ordered = (speakerOrder ?? []).filter((id, index, arr) =>
      available.has(id) && arr.indexOf(id) === index
    );
    const remaining = agents.map((a) => a.id).filter((id) => !ordered.includes(id));
    return [...ordered, ...remaining];
  }

  private orderedAgents(): IAgent[] {
    return this.speakerOrder
      .map((id) => this.agents.get(id))
      .filter((agent): agent is IAgent => agent != null);
  }

  private async runRoundRobin(phase: MeetingPhase): Promise<boolean> {
    let participants = this.orderedAgents();

    if (phase === MeetingPhase.BUILD) {
      participants = participants.filter((a) => a.type === 'subprocess');
      if (participants.length === 0) {
        this.addMessage(
          '__system_moderator__',
          'Moderator',
          'No builder agents available for BUILD phase. Skipping.'
        );
        return false;
      }
    }

    this.turnManager.setRound(participants);

    while (!this.turnManager.allSpoken()) {
      if (this.aborted) return false;
      const speaker = this.turnManager.nextSpeaker();
      if (!speaker) break;

      const agent = this.agents.get(speaker.id);
      if (!agent) continue;

      // Skip agents that have failed 2+ consecutive rounds
      if ((this.consecutiveFailures.get(agent.id) ?? 0) >= 2) {
        this.addMessage(
          agent.id,
          agent.name,
          `[${agent.name} is being skipped after ${this.consecutiveFailures.get(agent.id)} consecutive failures]`
        );
        continue;
      }

      let currentPrompt: string;
      if (phase === MeetingPhase.POSITION) {
        currentPrompt = this.moderator.buildPositionPrompt(this.topic, speaker.name);
      } else if (phase === MeetingPhase.REBUTTAL) {
        currentPrompt = this.moderator.buildRebuttalPrompt(this.topic, speaker.name);
      } else if (phase === MeetingPhase.DELIBERATION) {
        currentPrompt = this.moderator.buildDeliberationPrompt(this.topic, speaker.name);
      } else if (phase === MeetingPhase.PLAN) {
        currentPrompt = this.moderator.buildPlanPrompt(this.topic, speaker.name);
      } else if (phase === MeetingPhase.BUILD) {
        currentPrompt = this.moderator.buildBuildPrompt(this.topic, speaker.name);
      } else {
        currentPrompt = this.moderator.buildReviewPrompt(this.topic, speaker.name);
      }

      await this.promptAgent(agent, currentPrompt);

      // Rounds are fixed round-robin units. Agents may ask to continue in their
      // response, but continuation is controlled by the configured round counts.
    }
    return true;
  }

  private async runDeliberation(): Promise<void> {
    const startDeliberation =
      this.isResuming && this.currentPhase === MeetingPhase.DELIBERATION
        ? this.resumePoint.deliberationRound ?? 0
        : 0;

    for (let r = startDeliberation; r < this.maxDeliberationRounds && this.canRunRound(); r++) {
      this.resumePoint.deliberationRound = r;
      await this.advancePhase(MeetingPhase.DELIBERATION);
      const roundRan = await this.runRoundRobin(MeetingPhase.DELIBERATION);
      if (this.aborted) break;
      if (!roundRan) break;
      this.resumePoint.deliberationRound = r + 1;
      await this.finishRound();
    }
  }

  private async runVoting(): Promise<void> {
    const voteQuestion = `Do you agree with the emerging consensus on this topic?`;
    const votePrompt = this.moderator.buildVotingPrompt(this.topic, voteQuestion);

    for (const agent of this.agents.values()) {
      if (this.aborted) return;
      if ((this.consecutiveFailures.get(agent.id) ?? 0) >= 2) {
        this.addMessage(
          agent.id,
          agent.name,
          `[${agent.name} is being skipped after ${this.consecutiveFailures.get(agent.id)} consecutive failures]`
        );
        continue;
      }
      await this.promptAgent(agent, votePrompt);
    }
  }

  private async runSummary(): Promise<void> {
    const transcriptText = this.transcript
      .map((m) => `[${m.authorName} (${m.phase})]: ${m.content}`)
      .join('\n\n');

    let summary: MeetingSummary;
    try {
      summary = await Promise.race([
        this.summarizer.summarize(
          this.topic,
          this.context,
          this.transcript.map((m) => ({
            authorName: m.authorName,
            content: m.content,
          })),
          [...this.agents.values()],
          this.mode
        ),
        new Promise<MeetingSummary>((resolve) =>
          setTimeout(() => resolve({
            consensus: 'Summary generation timed out.',
            keyPoints: [],
            dissentingViews: [],
            actionItems: [],
          }), this.turnTimeoutMs)
        ),
      ]);
    } catch (e) {
      console.error('Summarizer error:', (e as Error).message);
      summary = {
        consensus: 'Summary generation failed — see transcript for details.',
        keyPoints: [],
        dissentingViews: [],
        actionItems: [],
      };
    }

    if (this.mode === 'debate') {
      const voteTally = this.summarizer.parseVotes(
        this.transcript
          .filter((m) => m.phase === MeetingPhase.VOTING)
          .map((m) => ({ authorName: m.authorName, content: m.content }))
      );
      summary.voteTally = voteTally;
    }
    this.summary = summary;

    const heading = this.mode === 'collaboration' ? 'PROJECT SUMMARY' : 'MEETING SUMMARY';
    const lines: string[] = [
      `=== ${heading} ===`,
      `Topic: ${this.topic}`,
      `Consensus: ${summary.consensus}`,
      '',
      'Key Points:',
      ...summary.keyPoints.map((p) => `  • ${p}`),
    ];

    if (this.mode === 'collaboration') {
      if (summary.deliverables && summary.deliverables.length > 0) {
        lines.push('', 'Deliverables:', ...summary.deliverables.map((d) => `  • ${d}`));
      }
      if (summary.decisions && summary.decisions.length > 0) {
        lines.push('', 'Key Decisions:', ...summary.decisions.map((d) => `  • ${d}`));
      }
    } else {
      lines.push(
        '',
        'Dissenting Views:',
        ...(summary.dissentingViews.length > 0
          ? summary.dissentingViews.map((v) => `  • ${v}`)
          : ['  (none)'])
      );
      if (summary.voteTally) {
        const t = summary.voteTally;
        lines.push('', `Vote Tally: YES=${t.yes} NO=${t.no} ABSTAIN=${t.abstain}`);
      }
    }

    lines.push(
      '',
      'Action Items:',
      ...(summary.actionItems.length > 0
        ? summary.actionItems.map((a) => `  • ${a}`)
        : ['  (none)'])
    );

    const summaryText = lines.join('\n');

    this.addMessage(this.moderator.systemModeratorId, this.moderator.systemModeratorName, summaryText);
  }

  private onTurnStart?: (agentName: string) => void;
  private onTurnEnd?: (agentName: string) => void;
  private onTranscript?: (msg: Message) => void;
  private onPhaseChange?: (phase: MeetingPhase) => void;
  private onStatusChange?: (status: MeetingStatus) => void;

  private async promptAgent(agent: IAgent, promptText: string): Promise<void> {
    this.totalTurns++;
    this.currentTurn = agent.name;
    this.onTurnStart?.(agent.name);

    const transcriptMessages: TranscriptMessage[] = this.transcript.map((m) => ({
      id: m.id,
      authorId: m.authorId,
      authorName: m.authorName,
      content: m.content,
      phase: m.phase,
      timestamp: m.timestamp,
    }));

    try {
      const started = Date.now();
      // Safety net: agent's own timeout + 60s buffer. For text-only phases
      // (debate, deliberation, etc.) cap at 5 min — no agent needs longer.
      // BUILD phase uses the full agent timeout since tool work is legitimately slow.
      const isBuildPhase = this.currentPhase === MeetingPhase.BUILD;
      const engineTimeout = isBuildPhase
        ? (agent.timeoutMs ?? 1_800_000) + 60_000
        : Math.min(agent.timeoutMs ?? 300_000, 300_000) + 60_000;
      // Per-turn abort controller: aborts on meeting cancel OR engine timeout.
      // This ensures the subprocess is killed when the timeout fires instead of
      // leaking an orphaned process that can later cause unhandled rejections.
      const turnController = new AbortController();
      const onMeetingAbort = () => turnController.abort();
      this.abortController.signal.addEventListener('abort', onMeetingAbort, { once: true });

      const contextImages =
        agent.supportsVision && this.contextImages.length > 0 && !this.seenContextImages.has(agent.id)
          ? this.contextImages
          : undefined;
      const currentPrompt = contextImages
        ? [
            promptText,
            '',
            'You are receiving image context for this meeting. Start by describing the visually relevant contents, labels, layout, and any uncertainty so participants without vision can rely on your observations.',
          ].join('\n')
        : promptText;

      const response = await Promise.race([
        agent.respond({
          meetingId: this.id,
          phase: this.currentPhase,
          topic: this.topic,
          background: this.context,
          contextImages,
          transcript: transcriptMessages,
          speakingOrder: this.speakerOrder,
          currentPrompt,
          workDir: this.workDir,
          signal: turnController.signal,
        }),
        new Promise<{ content: string }>((resolve) =>
          setTimeout(() => {
            turnController.abort();
            resolve({ content: `[${agent.name} did not respond within ${engineTimeout}ms]` });
          }, engineTimeout)
        ),
      ]);

      // Clean up the meeting-level abort listener (turn is done)
      this.abortController.signal.removeEventListener('abort', onMeetingAbort);

      // Mark that this agent has received context images (don't re-send)
      if (agent.supportsVision && this.contextImages.length > 0) {
        this.seenContextImages.add(agent.id);
      }

      this.consecutiveFailures.delete(agent.id);
      this.addMessage(agent.id, agent.name, response.content, Date.now() - started);
      await this.checkpoint();
    } catch (e) {
      console.error(`[engine] ${agent.name} failed:`, e instanceof Error ? e.message : e);
      const reason = e instanceof Error ? e.message : String(e);
      this.addMessage(
        agent.id,
        agent.name,
        `[${agent.name} encountered an error: ${reason}]`
      );
      this.consecutiveFailures.set(agent.id, (this.consecutiveFailures.get(agent.id) ?? 0) + 1);
    } finally {
      this.currentTurn = null;
      this.onTurnEnd?.(agent.name);
    }
  }

  private addMessage(
    authorId: string,
    authorName: string,
    content: string,
    durationMs?: number
  ): void {
    const msg: Message = {
      id: randomUUID(),
      authorId,
      authorName,
      content,
      phase: this.currentPhase,
      timestamp: Date.now(),
      durationMs,
    };
    this.transcript.push(msg);
    this.onTranscript?.(msg);
  }
}
