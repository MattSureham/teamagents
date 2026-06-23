import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MinimaxAdapter } from '../src/llm/minimax.js';
import { resetLLMRateLimitForTests } from '../src/llm/rate-limit.js';

const OLD_ENV = { ...process.env };

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  resetLLMRateLimitForTests();
  process.env.AGENT_MEETINGS_LLM_MIN_INTERVAL_MS = '0';
  process.env.AGENT_MEETINGS_MINIMAX_BACKOFF_MS = '0';
});

afterEach(() => {
  resetLLMRateLimitForTests();
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe('MinimaxAdapter', () => {
  it('returns content on a successful response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ base_resp: { status_code: 0, status_msg: '' }, choices: [{ message: { content: 'hello' } }] })
    );
    const adapter = new MinimaxAdapter('key', 'minimax-m3');
    expect(await adapter.chat([{ role: 'user', content: 'hi' }])).toBe('hello');
  });

  it('surfaces the MiniMax status message instead of crashing on null choices', async () => {
    // HTTP 200 + non-transient error code + null choices — the shape that used
    // to throw "Cannot read properties of null (reading '0')".
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ base_resp: { status_code: 2013, status_msg: 'invalid params' }, choices: null })
    );
    const adapter = new MinimaxAdapter('key', 'minimax-m3');
    await expect(adapter.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/2013.*invalid params/);
  });

  it('retries a transient throttle (HTTP 200 + null choices) and recovers', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ base_resp: { status_code: 1039, status_msg: 'TPM throttled' }, choices: null })
      )
      .mockResolvedValueOnce(
        jsonResponse({ base_resp: { status_code: 0, status_msg: '' }, choices: [{ message: { content: 'recovered' } }] })
      );
    const adapter = new MinimaxAdapter('key', 'minimax-m3');
    expect(await adapter.chat([{ role: 'user', content: 'hi' }])).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a moderated empty string as a (non-error) response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ base_resp: { status_code: 0, status_msg: '' }, choices: [{ message: { content: '' } }] })
    );
    const adapter = new MinimaxAdapter('key', 'minimax-m3');
    expect(await adapter.chat([{ role: 'user', content: 'hi' }])).toBe('');
  });
});
