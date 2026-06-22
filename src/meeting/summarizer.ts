import type { MeetingMode, MeetingSummary } from './types.js';
import type { LLMAdapter } from '../llm/types.js';
import type { IAgent } from '../agent/types.js';

export class Summarizer {
  private adapter: LLMAdapter | null;

  constructor(adapter: LLMAdapter | null = null) {
    this.adapter = adapter;
  }

  async summarize(
    topic: string,
    context: string,
    transcript: { authorName: string; content: string }[],
    participants: IAgent[],
    mode: MeetingMode = 'debate'
  ): Promise<MeetingSummary> {
    if (this.adapter) {
      return this.llmSummary(topic, context, transcript, participants, mode);
    }
    return this.fallbackSummary(participants, mode);
  }

  private async llmSummary(
    topic: string,
    context: string,
    transcript: { authorName: string; content: string }[],
    participants: IAgent[],
    mode: MeetingMode
  ): Promise<MeetingSummary> {
    const transcriptText = transcript
      .map((m) => `[${m.authorName}]: ${m.content}`)
      .join('\n\n');

    const isCollab = mode === 'collaboration';

    const systemPrompt = isCollab
      ? [
          'You produce structured project summaries in JSON format.',
          'Output ONLY valid JSON matching this schema:',
          '{',
          '  "consensus": "string — overall project outcome and what was accomplished",',
          '  "keyPoints": ["string — main discussion points and findings"],',
          '  "actionItems": ["string — concrete next steps"],',
          '  "deliverables": ["string — what was actually built or produced"],',
          '  "decisions": ["string — key technical and design decisions made"]',
          '}',
        ].join('\n')
      : mode === 'discussion'
        ? [
            'You produce structured open-discussion summaries in JSON format.',
            'Output ONLY valid JSON matching this schema:',
            '{',
            '  "consensus": "string — what the group converged on, or the current state of the discussion",',
            '  "keyPoints": ["string — main ideas, trade-offs, useful questions, and findings"],',
            '  "dissentingViews": ["string — unresolved questions or meaningful remaining disagreements"],',
            '  "actionItems": ["string — concrete follow-up tasks"]',
            '}',
          ].join('\n')
        : [
          'You produce structured meeting summaries in JSON format.',
          'Output ONLY valid JSON matching this schema:',
          '{',
          '  "consensus": "string — the main agreement or decision reached",',
          '  "keyPoints": ["string — main arguments and findings"],',
          '  "dissentingViews": ["string — minority or opposing opinions"],',
          '  "actionItems": ["string — concrete follow-up tasks"]',
          '}',
        ].join('\n');

    const response = await this.adapter!.chat([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          `Topic: ${topic}`,
          `Context: ${context}`,
          `Participants: ${participants.map((p) => p.name).join(', ')}`,
          '',
          'TRANSCRIPT:',
          transcriptText,
          '',
          isCollab ? 'Produce the project summary as JSON.' : 'Produce the meeting summary as JSON.',
        ].join('\n'),
      },
    ]);

    try {
      const json = JSON.parse(response.replace(/```json\n?|\n?```/g, '').trim());
      const summary: MeetingSummary = {
        consensus: json.consensus ?? (isCollab ? 'Project completed.' : 'No consensus recorded.'),
        keyPoints: json.keyPoints ?? [],
        dissentingViews: json.dissentingViews ?? [],
        actionItems: json.actionItems ?? [],
        deliverables: json.deliverables,
        decisions: json.decisions,
      };
      return summary;
    } catch {
      return {
        consensus: response.slice(0, 500),
        keyPoints: [],
        dissentingViews: [],
        actionItems: [],
      };
    }
  }

  private fallbackSummary(participants: IAgent[], mode: MeetingMode = 'debate'): MeetingSummary {
    return {
      consensus: mode === 'collaboration'
        ? 'Project completed (no LLM available for automated summary).'
        : 'Meeting concluded (no LLM available for automated summary).',
      keyPoints: [],
      dissentingViews: [],
      actionItems: [],
    };
  }

  parseVotes(transcript: { authorName: string; content: string }[]): Record<
    string,
    number
  > {
    const tally: Record<string, number> = { yes: 0, no: 0, abstain: 0 };

    for (const msg of transcript) {
      const content = msg.content.toUpperCase();
      if (content.includes('VOTE: YES') || content.includes('VOTE YES')) {
        tally.yes++;
      } else if (content.includes('VOTE: NO') || content.includes('VOTE NO')) {
        tally.no++;
      } else if (
        content.includes('VOTE: ABSTAIN') ||
        content.includes('VOTE ABSTAIN')
      ) {
        tally.abstain++;
      }
    }

    return tally;
  }
}
