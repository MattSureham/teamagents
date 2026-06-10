import type { ChatMessage, LLMAdapter } from './types.js';
import { requestLLM } from './rate-limit.js';

export class DeepSeekAdapter implements LLMAdapter {
  readonly provider = 'deepseek';
  readonly supportsVision = true;

  constructor(
    private apiKey: string,
    readonly model: string = 'deepseek-chat'
  ) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const response = await requestLLM(this.provider, () => fetch('https://api.deepseek.com/v1/chat/completions', {
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
    }));

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0]?.message?.content ?? '';
  }
}
