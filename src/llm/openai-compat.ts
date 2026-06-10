import type { ChatMessage, LLMAdapter } from './types.js';
import { requestLLM } from './rate-limit.js';

export class OpenAICompatAdapter implements LLMAdapter {
  readonly provider = 'openai-compat';
  readonly supportsVision: boolean;

  constructor(
    private apiKey: string,
    readonly model: string,
    private endpoint: string = 'http://127.0.0.1:8000/v1',
    supportsVision: boolean = false
  ) {
    this.supportsVision = supportsVision;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const response = await requestLLM(this.provider, () => fetch(
      `${this.endpoint}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
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
      throw new Error(`OpenAI-compat API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0]?.message?.content ?? '';
  }
}
