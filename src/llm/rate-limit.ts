const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

type RequestFn = () => Promise<Response>;

interface ProviderState {
  queue: Promise<void>;
  lastStartedAt: number;
}

const providers = new Map<string, ProviderState>();

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

function isRetryable(response: Response): boolean {
  return response.status === 408 || response.status === 429 || response.status >= 500;
}

function backoffMs(attempt: number, response?: Response): number {
  if (response) {
    const retryAfter = retryAfterMs(response);
    if (retryAfter != null) return retryAfter;
  }

  const initial = envNumber('AGENT_MEETINGS_LLM_INITIAL_BACKOFF_MS', DEFAULT_INITIAL_BACKOFF_MS);
  const max = envNumber('AGENT_MEETINGS_LLM_MAX_BACKOFF_MS', DEFAULT_MAX_BACKOFF_MS);
  const exponential = initial * 2 ** Math.max(0, attempt - 1);
  return Math.min(max, exponential);
}

async function runForProvider<T>(provider: string, work: () => Promise<T>): Promise<T> {
  const minIntervalMs = envNumber('AGENT_MEETINGS_LLM_MIN_INTERVAL_MS', DEFAULT_MIN_INTERVAL_MS);
  const state = providers.get(provider) ?? { queue: Promise.resolve(), lastStartedAt: 0 };
  providers.set(provider, state);

  const previous = state.queue.catch(() => {});
  let release!: () => void;
  state.queue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    const waitMs = Math.max(0, state.lastStartedAt + minIntervalMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    state.lastStartedAt = Date.now();
    return await work();
  } finally {
    release();
  }
}

export async function requestLLM(provider: string, request: RequestFn): Promise<Response> {
  const maxRetries = envNumber('AGENT_MEETINGS_LLM_MAX_RETRIES', DEFAULT_MAX_RETRIES);

  return runForProvider(provider, async () => {
    for (let attempt = 0; ; attempt++) {
      const response = await request();
      if (!isRetryable(response) || attempt >= maxRetries) {
        return response;
      }

      // Drain the body before retrying so the socket can be reused.
      await response.text().catch(() => {});
      await sleep(backoffMs(attempt + 1, response));
    }
  });
}

export function resetLLMRateLimitForTests(): void {
  providers.clear();
}
