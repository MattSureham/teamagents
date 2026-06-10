import type { ChatMessage, LLMAdapter } from './types.js';
import { requestLLM } from './rate-limit.js';

export class MinimaxAdapter implements LLMAdapter {
  readonly provider = 'minimax';
  readonly supportsVision = false;

  constructor(
    private apiKey: string,
    readonly model: string = 'abab6.5s-chat'
  ) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const response = await requestLLM(this.provider, () => fetch(
      'https://api.minimax.chat/v1/text/chatcompletion_v2',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          max_tokens: 4096,
        }),
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
}
