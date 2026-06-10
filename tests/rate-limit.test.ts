import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestLLM, resetLLMRateLimitForTests } from '../src/llm/rate-limit.js';

const OLD_ENV = { ...process.env };

beforeEach(() => {
  resetLLMRateLimitForTests();
  process.env.AGENT_MEETINGS_LLM_MIN_INTERVAL_MS = '15';
  process.env.AGENT_MEETINGS_LLM_MAX_RETRIES = '1';
  process.env.AGENT_MEETINGS_LLM_INITIAL_BACKOFF_MS = '0';
});

afterEach(() => {
  resetLLMRateLimitForTests();
  process.env = { ...OLD_ENV };
});

describe('LLM rate limiting', () => {
  it('serializes requests for the same provider', async () => {
    const starts: number[] = [];

    await Promise.all([
      requestLLM('test-provider', async () => {
        starts.push(Date.now());
        return new Response('{}', { status: 200 });
      }),
      requestLLM('test-provider', async () => {
        starts.push(Date.now());
        return new Response('{}', { status: 200 });
      }),
    ]);

    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(10);
  });

  it('retries retryable responses', async () => {
    let attempts = 0;

    const response = await requestLLM('retry-provider', async () => {
      attempts++;
      if (attempts === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return new Response('ok', { status: 200 });
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(attempts).toBe(2);
  });
});
