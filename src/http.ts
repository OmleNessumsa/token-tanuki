export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  body?: string;
  method?: "GET" | "POST";
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_RETRIES = 2;

export async function fetchJson<T = unknown>(
  url: string,
  opts: FetchOptions = {},
): Promise<T> {
  const { headers = {}, timeoutMs = DEFAULT_TIMEOUT, retries = DEFAULT_RETRIES, body, method = "GET" } = opts;
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: "application/json", ...headers },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status >= 500 || res.status === 429) {
          throw new HttpError(`HTTP ${res.status}`, res.status, url, text);
        }
        throw new HttpError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, url, text);
      }
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const retriable =
        err instanceof HttpError ? err.status >= 500 || err.status === 429 : true;
      if (!retriable || attempt === retries) break;
      const backoff = 250 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, backoff));
      attempt++;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
