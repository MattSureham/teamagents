import { describe, it, expect } from 'vitest';
import { MeetingEngine } from '../src/meeting/engine.js';
import type { IAgent, AgentHealth, AgentResponse, MeetingPrompt } from '../src/agent/types.js';

class MockAgent implements IAgent {
  readonly type = 'llm';
  private responses: string[];
  private idx = 0;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly capabilities: string[],
    responses?: string[]
  ) {
    this.responses = responses ?? [this.name + ' responds.'];
  }

  async respond(_prompt: MeetingPrompt): Promise<AgentResponse> {
    const content = this.responses[this.idx % this.responses.length];
    this.idx++;
    return { content };
  }

  async health(): Promise<AgentHealth> {
    return { status: 'healthy', lastCheck: Date.now() };
  }

  async shutdown(): Promise<void> {}
}

describe('MeetingEngine', () => {
  it('runs a complete meeting through all phases', async () => {
    const agents = [
      new MockAgent('agent-1', 'Alice', ['typescript', 'architecture']),
      new MockAgent('agent-2', 'Bob', ['python', 'data-science']),
      new MockAgent('agent-3', 'Carol', ['security', 'infra']),
    ];

    const engine = new MeetingEngine({
      topic: 'Should we adopt microservices?',
      context: 'We are a team of 10 engineers building a SaaS product.',
      participants: agents,
    });

    await engine.start();

    expect(engine.status).toBe('concluded');
    expect(engine.transcript.length).toBeGreaterThan(0);
    expect(engine.summary).not.toBeNull();
    expect(engine.phaseTimeline.length).toBeGreaterThan(0);

    // Verify phases were entered
    const phases = engine.phaseTimeline.map((p) => p.phase);
    expect(phases).toContain('opening');
    expect(phases).toContain('position');
    expect(phases).toContain('rebuttal');
    expect(phases).toContain('summary');
    expect(phases).toContain('concluded');
  });

  it('handles cancellation', () => {
    const agents = [new MockAgent('agent-1', 'Alice', [])];
    const engine = new MeetingEngine({
      topic: 'Test',
      context: '',
      participants: agents,
    });

    engine.cancel();
    expect(engine.status).toBe('cancelled');
  });

  it('persists to StoredMeeting format', async () => {
    const agents = [new MockAgent('agent-1', 'Alice', ['testing'])];
    const engine = new MeetingEngine({
      topic: 'Test meeting',
      context: 'Some context',
      participants: agents,
    });

    await engine.start();

    const stored = engine.toStoredMeeting();
    expect(stored.id).toBe(engine.id);
    expect(stored.topic).toBe('Test meeting');
    expect(stored.context).toBe('Some context');
    expect(stored.status).toBe('concluded');
    expect(stored.participantIds).toEqual(['agent-1']);
    expect(stored.transcript.length).toBeGreaterThan(0);
    expect(stored.summary).not.toBeNull();
    expect(stored.createdAt).toBeGreaterThan(0);
    expect(stored.concludedAt).toBeGreaterThan(0);
  });

  it('handles agent timeout gracefully', async () => {
    class SlowAgent implements IAgent {
      readonly type = 'llm';
      constructor(
        readonly id: string,
        readonly name: string,
        readonly capabilities: string[]
      ) {}
      async respond(_prompt: MeetingPrompt): Promise<AgentResponse> {
        return new Promise(() => {}); // never resolves
      }
      async health(): Promise<AgentHealth> {
        return { status: 'healthy', lastCheck: Date.now() };
      }
      async shutdown(): Promise<void> {}
    }

    const agents = [new SlowAgent('slow-1', 'Slow', [])];
    const engine = new MeetingEngine({
      topic: 'Test',
      context: '',
      participants: agents,
      turnTimeoutMs: 100,
      maxDeliberationRounds: 1,
      maxRebuttalRounds: 0,
    });

    expect(engine.status).toBe('pending');
  });

  it('respects maxDeliberationRounds and completes all phases', async () => {
    const agents = [
      new MockAgent('a1', 'Alice', ['general']),
      new MockAgent('a2', 'Bob', ['general']),
      new MockAgent('a3', 'Carol', ['general']),
    ];

    const engine = new MeetingEngine({
      topic: 'Test deliberation rounds',
      context: '',
      participants: agents,
      maxRebuttalRounds: 0,
      maxDeliberationRounds: 1,  // one full round-robin deliberation round
    });

    await engine.start();

    // All phases should complete — no turn limit cutting the meeting short
    expect(engine.status).toBe('concluded');
    expect(engine.reasonEnded).toBe('completed');
    expect(engine.summary).not.toBeNull();
    expect(engine.transcript.length).toBeGreaterThan(0);
  });

  it('runs deliberation as configured full round-robin rounds', async () => {
    const agents = [
      new MockAgent('a1', 'Alice', ['general']),
      new MockAgent('a2', 'Bob', ['general']),
      new MockAgent('a3', 'Carol', ['general']),
    ];

    const engine = new MeetingEngine({
      topic: 'Round semantics',
      context: '',
      participants: agents,
      maxRebuttalRounds: 0,
      maxDeliberationRounds: 2,
    });

    await engine.start();

    const deliberationMessages = engine.transcript.filter(
      (m) => m.phase === 'deliberation' && m.authorId !== '__system_moderator__'
    );
    expect(deliberationMessages).toHaveLength(6);
  });

  it('runs discussion mode without position, rebuttal, or voting phases', async () => {
    const agents = [
      new MockAgent('a1', 'Alice', ['general']),
      new MockAgent('a2', 'Bob', ['general']),
    ];

    const engine = new MeetingEngine({
      topic: 'Open discussion',
      context: '',
      participants: agents,
      mode: 'discussion',
      maxRebuttalRounds: 2,
      maxDeliberationRounds: 2,
    });

    await engine.start();

    const phases = engine.transcript.map((m) => m.phase);
    expect(phases).toContain('opening');
    expect(phases).toContain('deliberation');
    expect(phases).toContain('summary');
    expect(phases).not.toContain('position');
    expect(phases).not.toContain('rebuttal');
    expect(phases).not.toContain('voting');

    const deliberationMessages = engine.transcript.filter(
      (m) => m.phase === 'deliberation' && m.authorId !== '__system_moderator__'
    );
    expect(deliberationMessages).toHaveLength(4);
    expect(engine.summary?.voteTally).toBeUndefined();
  });

  it('runs build rounds as builder round-robin rounds', async () => {
    class BuilderAgent extends MockAgent {
      override readonly type = 'subprocess';
    }

    const agents = [
      new BuilderAgent('b1', 'Builder One', ['coding']),
      new BuilderAgent('b2', 'Builder Two', ['coding']),
      new MockAgent('advisor', 'Advisor', ['review']),
    ];

    const engine = new MeetingEngine({
      topic: 'Build round semantics',
      context: '',
      participants: agents,
      mode: 'collaboration',
      maxPlanRounds: 0,
      maxBuildRounds: 2,
      maxReviewRounds: 0,
    });

    await engine.start();

    const buildMessages = engine.transcript.filter(
      (m) => m.phase === 'build' && m.authorId !== '__system_moderator__'
    );
    expect(buildMessages).toHaveLength(4);
    expect(buildMessages.map((m) => m.authorId)).toEqual(['b1', 'b2', 'b1', 'b2']);
  });

  it('caps discussion work by maxTotalRounds', async () => {
    const agents = [
      new MockAgent('a1', 'Alice', ['general']),
      new MockAgent('a2', 'Bob', ['general']),
    ];

    const engine = new MeetingEngine({
      topic: 'Total round cap',
      context: '',
      participants: agents,
      maxRebuttalRounds: 2,
      maxDeliberationRounds: 2,
      maxTotalRounds: 1,
    });

    await engine.start();

    const stored = engine.toStoredMeeting();
    expect(stored.totalRounds).toBe(1);
    expect(engine.transcript.some((m) => m.phase === 'rebuttal')).toBe(false);
    expect(engine.transcript.some((m) => m.phase === 'deliberation')).toBe(false);
  });
});
