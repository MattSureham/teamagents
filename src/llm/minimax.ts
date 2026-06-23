import type { ChatMessage, ContentBlock, LLMAdapter } from './types.js';
import { requestLLM } from './rate-limit.js';

// MiniMax reports failures inside an HTTP-200 body via `base_resp.status_code`
// (with `choices` null) rather than an HTTP error status, so the shared
// rate-limit retry — which keys off the HTTP status — never sees them and the
// caller would otherwise crash on `choices[0]`. These codes are transient
// (rate limit / TPM throttle / internal error) and worth retrying here.
const TRANSIENT_STATUS_CODES = new Set([1000, 1002, 1013, 1039]);
const MAX_ATTEMPTS = 3;

interface MinimaxResponse {
  choices?: Array<{ message?: { content?: string } }>;
  base_resp?: { status_code?: number; status_msg?: string };
}

function backoffMs(): number {
  const raw = Number(process.env.AGENT_MEETINGS_MINIMAX_BACKOFF_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
}

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

    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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

      const data = (await response.json()) as MinimaxResponse;
      const statusCode = data.base_resp?.status_code ?? 0;
      const content = data.choices?.[0]?.message?.content;

      // status_code 0 with content present is success. A moderated response can
      // legitimately return an empty string, so only a missing/null content
      // (typically alongside null `choices`) counts as a failure.
      if (statusCode === 0 && content != null) {
        return content;
      }

      lastError = `status ${statusCode}: ${data.base_resp?.status_msg || 'no content returned'}`;
      const isTransient =
        TRANSIENT_STATUS_CODES.has(statusCode) || (statusCode === 0 && content == null);
      if (!isTransient || attempt === MAX_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, backoffMs() * attempt));
    }

    throw new Error(`Minimax API error (${lastError})`);
  }

  private serializeContent(content: string | ContentBlock[]): string | ContentBlock[] {
    if (typeof content === 'string') return content;
    return content;
  }
}
