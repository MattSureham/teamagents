import type { IAgent } from '../agent/types.js';
import type { LLMAdapter } from '../llm/types.js';
import { MeetingPhase } from './types.js';

export class Moderator {
  private adapter: LLMAdapter | null;
  private mode: 'debate' | 'collaboration';
  private workDir: string | null;

  constructor(adapter: LLMAdapter | null = null, mode: 'debate' | 'collaboration' = 'debate', workDir: string | null = null) {
    this.adapter = adapter;
    this.mode = mode;
    this.workDir = workDir;
  }

  get activeWorkDir(): string | null { return this.workDir; }

  setWorkDir(path: string): void {
    this.workDir = path;
  }

  systemModeratorId = '__system_moderator__';
  systemModeratorName = 'Moderator';

  buildOpeningPrompt(topic: string, context: string, agents: IAgent[]): string {
    const participantList = agents.map((a) => `- ${a.name} (${a.id}): ${a.capabilities.join(', ')}`).join('\n');

    if (this.mode === 'collaboration') {
      const workDirInfo = this.workDir
        ? `\nWorking directory: ${this.workDir} (all agents share this directory to build in)\n`
        : '';
      return [
        '========================================',
        `PROJECT: ${topic}`,
        '========================================',
        context ? `\nBACKGROUND CONTEXT:\n${context}\n` : '',
        'TEAM:',
        participantList,
        workDirInfo,
        'WORKFLOW:',
        '1. PLAN — Each team member proposes an approach and division of work.',
        '2. BUILD — Team members take turns implementing their parts. Each turn should produce concrete output — code, files, documentation, or design artifacts.',
        '3. REVIEW — Team members review what was built and suggest improvements.',
        '4. SUMMARY — The moderator produces a final summary of deliverables and decisions.',
        '',
        'We now begin with planning.',
        `Each team member, please propose your approach to: "${topic}"`,
      ].join('\n');
    }

    return [
      '========================================',
      `MEETING TOPIC: ${topic}`,
      '========================================',
      context ? `\nBACKGROUND CONTEXT:\n${context}\n` : '',
      'PARTICIPANTS:',
      participantList,
      '',
      'GROUND RULES:',
      '1. Each participant will state their position in round-robin order.',
      '2. Participants may then offer rebuttals to other positions.',
      '3. Free-form deliberation follows, with raised-hand turn-taking.',
      '4. A vote may be called to reach consensus.',
      '5. The meeting concludes with a structured summary.',
      '',
      'We now begin with position statements.',
      `Each participant, please state your position on: "${topic}"`,
    ].join('\n');
  }

  buildPositionPrompt(topic: string, agentName: string): string {
    return `What is your position on "${topic}"? State your reasoning clearly.`;
  }

  buildRebuttalPrompt(topic: string, agentName: string): string {
    return `You have heard the positions stated so far. Please offer your rebuttal — respond to specific points made by other participants and defend your own position. Only rebut points you actually disagree with. Do not re-state or summarize positions you agree with — skip them and focus on genuine disagreements. Topic: "${topic}"`;
  }

  buildDeliberationPrompt(topic: string, agentName: string): string {
    return `The floor is open for deliberation on "${topic}". Only contribute if you have a genuinely new perspective or argument not already covered by others. Do not repeat, rephrase, or echo what has already been said — that wastes everyone's time. If you have nothing new to add, say "I have nothing new to add" and pass.`;
  }

  buildVotingPrompt(topic: string, question: string): string {
    return `VOTE: Regarding "${topic}" — ${question} Please respond with VOTE: YES or VOTE: NO and a brief justification.`;
  }

  // ── Collaboration prompts ──

  buildPlanPrompt(topic: string, agentName: string): string {
    const workDirInfo = this.workDir
      ? `\nWorking directory: ${this.workDir}\n`
      : '';
    return [
      `PLANNING PHASE — "${topic}"`,
      '',
      `You are ${agentName}. Propose your approach:`,
      '1. How should this project be architected?',
      '2. What components/modules are needed?',
      '3. Which part do you want to build?',
      '',
      'Be specific. Reference what other team members have already proposed in the transcript.',
      workDirInfo,
    ].join('\n');
  }

  buildBuildPrompt(topic: string, agentName: string): string {
    const workDirInfo = this.workDir
      ? `\nAll agents share the working directory: ${this.workDir}\nFiles created by other agents are already there for you to read, modify, or extend.`
      : '';
    return [
      `BUILD PHASE — "${topic}"`,
      '',
      `You are ${agentName}. It's your turn to implement ONE piece of this project.`,
      '',
      'IMPORTANT: Do NOT try to build the entire project. Other team members will handle other parts.',
      '',
      '1. Check the transcript above to see what has already been planned and built.',
      `2. If files already exist in the working directory, read them first to understand the current state.`,
      '3. Pick the NEXT logical piece that needs doing — one feature, one module, one component.',
      '4. Implement just that piece. Write real code, create real files.',
      '5. If the project already looks complete, say so and move on — do not rewrite working code.',
      workDirInfo,
      '',
      'After your work is done, briefly summarize the ONE thing you built so the next builder can pick up where you left off.',
    ].join('\n');
  }

  buildReviewPrompt(topic: string, agentName: string): string {
    return [
      `REVIEW PHASE — "${topic}"`,
      '',
      `You are ${agentName}. Review everything the team has built so far (see the transcript).`,
      '',
      '1. What works well?',
      '2. What needs improvement or is missing?',
      '3. What should happen next?',
      '',
      'Be constructive and specific.',
    ].join('\n');
  }

  async buildSummaryPrompt(
    topic: string,
    transcript: string,
    agents: IAgent[]
  ): Promise<string> {
    if (this.adapter) {
      return this.buildLLMSummary(topic, transcript, agents);
    }
    return this.buildTemplateSummary(topic, transcript, agents);
  }

  private async buildLLMSummary(
    topic: string,
    transcript: string,
    agents: IAgent[]
  ): Promise<string> {
    const participantNames = agents.map((a) => a.name).join(', ');

    if (this.mode === 'collaboration') {
      const systemPrompt = [
        'You are a project lead synthesizing the results of a team collaboration.',
        'Produce a project summary with these sections:',
        '1. DELIVERABLES: What was actually built or produced?',
        '2. KEY DECISIONS: What technical and design decisions were made?',
        '3. KEY POINTS: Important discussion points and findings',
        '4. UNRESOLVED ISSUES: What remains open or needs further work?',
        '5. NEXT STEPS: Concrete action items',
        '',
        'Format each section clearly. Be concise.',
      ].join('\n');

      const summary = await this.adapter!.chat([
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Project: ${topic}\nTeam: ${participantNames}\n\nTranscript:\n${transcript}\n\nProduce the project summary.`,
        },
      ]);
      return summary;
    }

    const systemPrompt = `You are a meeting moderator synthesizing the results of a structured debate.
Produce a meeting summary with these sections:
1. CONSENSUS: What was agreed upon?
2. KEY POINTS: The main arguments and findings
3. DISSENTING VIEWS: Minority opinions
4. ACTION ITEMS: Follow-up tasks

Format each section clearly. Be concise.`;

    const summary = await this.adapter!.chat([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Topic: ${topic}\nParticipants: ${participantNames}\n\nTranscript:\n${transcript}\n\nProduce the meeting summary.`,
      },
    ]);

    return summary;
  }

  private buildTemplateSummary(
    topic: string,
    transcript: string,
    agents: IAgent[]
  ): string {
    if (this.mode === 'collaboration') {
      return [
        `=== PROJECT SUMMARY ===`,
        `Project: ${topic}`,
        `Team: ${agents.map((a) => a.name).join(', ')}`,
        '',
        `DELIVERABLES: [No LLM available for summary generation]`,
        `KEY DECISIONS: [See transcript below]`,
        `UNRESOLVED ISSUES: [See transcript below]`,
        `NEXT STEPS: [None recorded]`,
        '',
        `=== FULL TRANSCRIPT ===`,
        transcript,
      ].join('\n');
    }

    return [
      `=== MEETING SUMMARY ===`,
      `Topic: ${topic}`,
      `Participants: ${agents.map((a) => a.name).join(', ')}`,
      '',
      `CONSENSUS: [No LLM available for summary generation]`,
      `KEY POINTS: [See transcript below]`,
      `DISSENTING VIEWS: [See transcript below]`,
      `ACTION ITEMS: [None recorded]`,
      '',
      `=== FULL TRANSCRIPT ===`,
      transcript,
    ].join('\n');
  }
}
