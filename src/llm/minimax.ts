import type { ChatMessage, ContentBlock, LLMAdapter } from './types.js';
import { requestLLM } from './rate-limit.js';

export class MinimaxAdapter implements LLMAdapter {
  readonly provider = 'minimax';
  readonly supportsVision: boolean;

  constructor(
    private apiKey: string,
    readonly model: string = 'abab6.5s-chat',
    supportsVision: boolean = false,
    private endpoint: string = 'https://api.minimax.chat/v1/text/chatcompletion_v2'
  ) {
    this.supportsVision = supportsVision;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: this.serializeContent(m.content),
      })),
      max_tokens: 4096,
    };

    const response = await requestLLM(this.provider, () => fetch(
      this.endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    ));

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Minimax API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0]?.message?.content ?? '';
  }

  private serializeContent(content: string | ContentBlock[]): string | ContentBlock[] {
    if (typeof content === 'string') return content;
    return content;
  }
}
