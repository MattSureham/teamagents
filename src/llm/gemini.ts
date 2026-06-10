import type { ChatMessage, LLMAdapter } from './types.js';
import { requestLLM } from './rate-limit.js';

export class GeminiAdapter implements LLMAdapter {
  readonly provider = 'gemini';

  constructor(
    private apiKey: string,
    readonly model: string = 'gemini-2.0-flash'
  ) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const systemMsg = messages.find((m) => m.role === 'system');
    const chatMessages = messages.filter((m) => m.role !== 'system');

    const contents = chatMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`
    );
    url.searchParams.set('key', this.apiKey);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: 4096 },
    };

    if (systemMsg) {
      body.systemInstruction = {
        parts: [{ text: systemMsg.content }],
      };
    }

    const response = await requestLLM(this.provider, () => fetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };

    return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  }
}
