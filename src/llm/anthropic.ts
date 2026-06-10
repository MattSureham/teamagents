import type { ChatMessage, LLMAdapter, ContentBlock } from './types.js';
import { getTextContent } from './types.js';
import { requestLLM } from './rate-limit.js';

export class AnthropicAdapter implements LLMAdapter {
  readonly provider = 'anthropic';
  readonly supportsVision = true;

  constructor(
    private apiKey: string,
    readonly model: string = 'claude-sonnet-4-20250514'
  ) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const systemMsg = messages.find((m) => m.role === 'system');
    const chatMessages = messages.filter((m) => m.role !== 'system');

    const response = await requestLLM(this.provider, () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        ...(systemMsg ? { system: getTextContent(systemMsg.content) } : {}),
        messages: chatMessages.map((m) => ({
          role: m.role,
          content: toAnthropicContent(m.content),
        })),
      }),
    }));

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };

    return data.content.map((c) => c.text).join('');
  }
}

function toAnthropicContent(
  content: string | ContentBlock[]
): string | Record<string, unknown>[] {
  if (typeof content === 'string') return content;
  return content.map((block): Record<string, unknown> => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    const url = block.image_url.url;
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] },
      };
    }
    return {
      type: 'image',
      source: { type: 'url', url },
    };
  });
}
