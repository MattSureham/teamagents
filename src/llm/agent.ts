import type { IAgent, AgentHealth, AgentResponse, MeetingPrompt } from '../agent/types.js';
import type { LLMAdapter, ChatMessage, ContentBlock } from './types.js';
import type { DebatePhase } from '../meeting/types.js';

export class LLMAgent implements IAgent {
  readonly type = 'llm';

  constructor(
    readonly id: string,
    readonly name: string,
    readonly capabilities: string[],
    private adapter: LLMAdapter
  ) {}

  get supportsVision(): boolean {
    return this.adapter.supportsVision ?? false;
  }

  async respond(prompt: MeetingPrompt): Promise<AgentResponse> {
    const systemPrompt = this.buildSystemPrompt(prompt);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.transcriptToMessages(prompt.transcript),
    ];

    // Build the user message — with images if available and adapter supports vision
    const hasVision = this.adapter.supportsVision && prompt.contextImages?.length;
    if (hasVision && prompt.contextImages) {
      const content: ContentBlock[] = [
        { type: 'text', text: prompt.currentPrompt },
        ...prompt.contextImages.map((img): ContentBlock => ({
          type: 'image_url',
          image_url: { url: img.data },
        })),
      ];
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: prompt.currentPrompt });
    }

    const text = await this.adapter.chat(messages);
    return { content: text };
  }

  async health(): Promise<AgentHealth> {
    // Don't make an API call — health checks must be fast (server boot blocks on them).
    // The real API test happens when the agent responds to a meeting prompt.
    if (!this.adapter) {
      return { status: 'unhealthy', lastCheck: Date.now(), error: 'No LLM adapter configured' };
    }
    return { status: 'healthy', lastCheck: Date.now() };
  }

  async shutdown(): Promise<void> {
    // nothing to clean up
  }

  private buildSystemPrompt(prompt: MeetingPrompt): string {
    const imageNote = prompt.contextImages?.length
      ? `\nThe context for this meeting includes ${prompt.contextImages.length} image(s). Examine them closely — they are attached to this message.`
      : '';
    return [
      `You are "${this.name}", an AI agent participating in a structured meeting.`,
      `Meeting topic: "${prompt.topic}"`,
      `Background context: ${prompt.background || 'None provided.'}${imageNote}`,
      `Current phase: ${prompt.phase.toUpperCase()}`,
      `Your capabilities: ${this.capabilities.join(', ') || 'general reasoning'}`,
      '',
      this.phaseInstructions(prompt.phase),
      '',
      'Speak naturally as a meeting participant. Be concise but thorough.',
      'Address the other participants by name when responding to their points.',
    ].join('\n');
  }

  private phaseInstructions(phase: DebatePhase): string {
    switch (phase) {
      case 'opening':
        return 'The moderator is introducing the topic. Listen and prepare your initial thoughts.';
      case 'position':
        return 'State your position on the topic clearly. Explain your reasoning and what evidence or principles support your view.';
      case 'rebuttal':
        return 'Respond to the positions stated by other participants. Challenge claims you genuinely disagree with, but do not invent disagreement. If you mostly agree, say so and add useful nuance, caveats, or open questions.';
      case 'deliberation':
        return 'Open discussion. Raise points you think are important, ask questions, build on others, resolve disagreements, and work toward consensus. Agreement is a valid contribution when it advances the discussion; if you have nothing meaningful to add, you may pass.';
      case 'voting':
        return 'Cast your vote on the question presented. State your vote clearly and briefly justify it.';
      case 'plan':
        return 'Propose your architectural approach and how you would divide the work. Be specific about components, modules, and responsibilities.';
      case 'build':
        return 'The builders are implementing now. You are an advisor — provide feedback, guidance, and suggestions. Do NOT emit tool calls or code blocks pretending to execute commands; you are text-only.';
      case 'review':
        return 'Review what the team has built. What works well? What needs improvement? What should happen next? Be constructive and specific.';
      case 'summary':
        return 'The meeting is concluding. The moderator will summarize.';
      case 'concluded':
        return 'The meeting has concluded.';
      default:
        return 'Participate appropriately for the current meeting phase.';
    }
  }

  private transcriptToMessages(
    transcript: MeetingPrompt['transcript']
  ): ChatMessage[] {
    const maxMessages = 12;
    const recent = transcript.length > maxMessages
      ? transcript.slice(-maxMessages)
      : transcript;
    return recent.map((msg) => ({
      role: msg.authorId === this.id ? ('assistant' as const) : ('user' as const),
      content: `[${msg.authorName}]: ${msg.content}`,
    }));
  }
}
