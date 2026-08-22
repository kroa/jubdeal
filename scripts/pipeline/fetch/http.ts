import { getCrawlDelayMs, isAllowed, parseRobotsTxt, type RobotsTxt } from '@pipeline/fetch/robots';

/**
 * 예의 있는 HTTP 수집기
 * ---------------------------------------------------------------------------
 * 남의 서버에 부담을 주지 않고, 우리 인프라도 위험에 빠뜨리지 않기 위해:
 *
 *  - robots.txt 를 호스트별로 한 번 읽고 캐시한 뒤 **매 홉마다** 확인
 *  - 리다이렉트를 직접 따라갑니다(`redirect: 'manual'`).
 *    `follow` 로 두면 undici 가 내부에서 처리해 버려, 리다이렉트된 호스트의
 *    robots·레이트리밋·프로토콜 검사를 전부 건너뛰게 됩니다.
 *  - 사설/루프백/링크로컬 주소로의 접근을 차단합니다 (SSRF 방어).
 *    클라우드 메타데이터 엔드포인트(169.254.169.254)가 대표적 표적입니다.
 *  - 호스트별 최소 요청 간격 (robots 의 Crawl-delay 가 더 길면 그쪽을 따름)
 *  - 식별 가능한 ASCII User-Agent (헤더는 ByteString 이라 비-ASCII 는 요청 자체가 실패)
 *  - 타임아웃, 제한된 재시도, Retry-After 존중(상한 있음)
 *  - 응답 크기 상한 (스트림을 읽으며 적용)
 */

export interface PoliteFetcherOptions {
  userAgent: string;
  /** 같은 호스트에 대한 최소 요청 간격(ms) */
  requestIntervalMs: number;
  timeoutMs: number;
  /** 응답 본문 최대 바이트 (기본 2MB) */
  maxBytes?: number;
  /** 네트워크 오류 시 재시도 횟수 (기본 2) */
  maxRetries?: number;
  /** Retry-After 를 존중할 최대 대기(ms). 기본 30초 */
  maxRetryAfterMs?: number;
  /** 따라갈 최대 리다이렉트 홉 수 (기본 5) */
  maxRedirects?: number;
  /** 테스트에서 사설 IP 차단을 끄기 위한 스위치 (기본 false) */
  allowPrivateHosts?: boolean;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
  log?: (message: string) => void;
}

export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt 가 수집을 허용하지 않습니다: ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

export class BlockedHostError extends Error {
  constructor(url: string, reason: string) {
    super(`차단된 대상입니다 (${reason}): ${url}`);
    this.name = 'BlockedHostError';
  }
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** HTTP 헤더 값으로 쓸 수 있는지 (RFC 9110 field-value: VCHAR + SP/HTAB) */
export function isValidHeaderValue(value: string): boolean {
  return /^[\x20-\x7e\t]+$/.test(value);
}

/**
 * 사설·루프백·링크로컬 대상인지 판단합니다.
 * 호스트명이 IP 가 아니면 DNS 를 조회하지 않고 통과시킵니다.
 * (DNS 리바인딩까지 막으려면 별도 해석이 필요하지만, 여기서는 명시적 내부 주소 접근만 차단합니다.)
 */
export function isBlockedHost(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return 'localhost';
  }

  // IPv6 루프백/링크로컬/유니크로컬
  if (host === '::1') return 'IPv6 루프백';
  if (host.startsWith('fe80:')) return 'IPv6 링크로컬';
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return 'IPv6 유니크로컬';

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return null;

  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];

  if (a === 127) return '루프백';
  if (a === 10) return '사설 대역';
  if (a === 192 && b === 168) return '사설 대역';
  if (a === 172 && b >= 16 && b <= 31) return '사설 대역';
  if (a === 169 && b === 254) return '링크로컬(클라우드 메타데이터)';
  if (a === 0) return '예약 대역';
  if (a >= 224) return '멀티캐스트/예약 대역';

  return null;
}

export class PoliteFetcher {
  private readonly robotsCache = new Map<string, RobotsTxt | 'deny' | null>();
  private readonly lastRequestAt = new Map<string, number>();

  private readonly userAgent: string;
  private readonly requestIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly maxRedirects: number;
  private readonly allowPrivateHosts: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(options: PoliteFetcherOptions) {
    // 비-ASCII User-Agent 는 요청을 만드는 순간 TypeError 를 냅니다.
    // 설정 실수를 요청 시점이 아니라 여기서 즉시 드러냅니다.
    if (!isValidHeaderValue(options.userAgent)) {
      const bad = [...options.userAgent].find((char) => !isValidHeaderValue(char));
      throw new Error(
        `User-Agent 는 ASCII 만 사용할 수 있습니다 (HTTP 헤더 값은 ByteString). ` +
          `문제 문자: ${JSON.stringify(bad)}`,
      );
    }

    this.userAgent = options.userAgent;
    this.requestIntervalMs = options.requestIntervalMs;
    this.timeoutMs = options.timeoutMs;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.allowPrivateHosts = options.allowPrivateHosts ?? false;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.nowImpl ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  /**
   * robots.txt 를 확인하고 허용된 경우에만 본문을 가져옵니다.
   * 리다이렉트는 홉마다 같은 검사를 다시 통과해야 따라갑니다.
   */
  async fetchText(url: string): Promise<string> {
    let current = url;

    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      const parsed = this.assertFetchable(current);

      await this.guardRobots(parsed, current);

      const response = await this.request(current);

      if (REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`리다이렉트에 Location 이 없습니다: ${current}`);

        let next: string;
        try {
          next = new URL(location, current).href;
        } catch {
          throw new Error(`리다이렉트 Location 을 해석할 수 없습니다: ${location}`);
        }

        this.log(`리다이렉트 ${response.status}: ${current} -> ${next}`);
        current = next;
        continue;
      }

      if (response.status === 404) throw new Error(`HTTP 404 — ${current}`);
      if (!response.ok) throw new Error(`HTTP ${response.status} — ${current}`);

      return this.readBody(response, current);
    }

    throw new Error(`리다이렉트가 ${this.maxRedirects}회를 넘었습니다: ${url}`);
  }

  /** 프로토콜·호스트 검사. 통과하면 파싱된 URL 을 돌려줍니다. */
  private assertFetchable(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`URL 을 해석할 수 없습니다: ${url}`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`지원하지 않는 프로토콜입니다: ${parsed.protocol}`);
    }

    if (!this.allowPrivateHosts) {
      const blocked = isBlockedHost(parsed.hostname);
      if (blocked) throw new BlockedHostError(url, blocked);
    }

    return parsed;
  }

  private async guardRobots(parsed: URL, url: string): Promise<void> {
    const robots = await this.loadRobots(parsed.origin);

    // RFC 9309: robots.txt 가 5xx 면 전체 금지로 간주합니다.
    if (robots === 'deny') {
      throw new RobotsDisallowedError(`${url} (robots.txt 를 확인할 수 없어 전체 금지로 간주)`);
    }

    if (!isAllowed(robots, this.userAgent, url)) throw new RobotsDisallowedError(url);

    const crawlDelay = getCrawlDelayMs(robots, this.userAgent);
    await this.throttle(parsed.host, Math.max(this.requestIntervalMs, crawlDelay ?? 0));
  }

  /** 호스트별 robots.txt 를 한 번만 읽어 캐시합니다. */
  private async loadRobots(origin: string): Promise<RobotsTxt | 'deny' | null> {
    const cached = this.robotsCache.get(origin);
    if (cached !== undefined) return cached;

    let result: RobotsTxt | 'deny' | null;

    try {
      await this.throttle(new URL(origin).host, this.requestIntervalMs);
      const response = await this.request(`${origin}/robots.txt`);

      if (response.status >= 500) {
        // 서버가 아파서 못 주는 경우와 "금지"를 구분할 수 없으므로 보수적으로 봅니다.
        this.log(`robots.txt 가 ${response.status} — 전체 금지로 간주: ${origin}`);
        result = 'deny';
      } else if (response.ok) {
        result = parseRobotsTxt(await this.readBody(response, `${origin}/robots.txt`));
      } else {
        // 404 등 "없음"은 표준상 전체 허용입니다.
        result = null;
      }
    } catch (error) {
      // 네트워크 오류로 못 읽은 경우도 허용으로 봅니다(오탐이 더 큰 피해).
      this.log(`robots.txt 읽기 실패(허용으로 간주): ${origin} — ${describeError(error)}`);
      result = null;
    }

    this.robotsCache.set(origin, result);
    return result;
  }

  private async throttle(host: string, intervalMs: number): Promise<void> {
    const last = this.lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = last + intervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequestAt.set(host, this.now());
  }

  /** 단일 요청. 리다이렉트를 따라가지 않고 응답을 그대로 돌려줍니다. */
  private async request(url: string): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const backoff = Math.max(this.requestIntervalMs, 500) * 2 ** attempt;
        this.log(`재시도 ${attempt}/${this.maxRetries} (${backoff}ms 후): ${url}`);
        await this.sleep(backoff);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(url, {
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9',
          },
          // 리다이렉트를 직접 처리해야 홉마다 robots·호스트 검사를 걸 수 있습니다.
          redirect: 'manual',
          signal: controller.signal,
        });

        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.now());
          if (retryAfter !== null) {
            // 상한이 없으면 사이트 한 곳이 실행 전체를 몇 시간 붙잡을 수 있습니다.
            await this.sleep(Math.min(retryAfter, this.maxRetryAfterMs));
          }
          lastError = new Error(`HTTP ${response.status}`);
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === this.maxRetries) break;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(`요청 실패: ${url} — ${describeError(lastError)}`);
  }

  /** 상한을 넘기면 더 읽지 않고 중단합니다(전체 버퍼링 방지). */
  private async readBody(response: Response, url: string): Promise<string> {
    const body = response.body;
    if (!body) return '';

    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    const chunks: string[] = [];
    let total = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        total += value.byteLength;

        if (total > this.maxBytes) {
          const keep = value.byteLength - (total - this.maxBytes);
          chunks.push(decoder.decode(value.subarray(0, Math.max(0, keep))));
          this.log(`응답이 상한(${this.maxBytes}B)을 넘어 중단합니다: ${url}`);
          await reader.cancel();
          break;
        }

        chunks.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock?.();
    }

    return chunks.join('');
  }
}

/**
 * 재시도할 가치가 있는 오류인지.
 *
 * undici 의 진짜 네트워크 실패는 TypeError 에 `cause` 가 붙습니다.
 * 헤더 인코딩 오류 같은 영구적 설정 오류는 `cause` 가 없으므로 재시도하면
 * 같은 실패를 반복하며 백오프 시간만 태웁니다.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (error instanceof TypeError) return (error as { cause?: unknown }).cause !== undefined;
  return error instanceof Error && error.name === 'FetchError';
}

/** Retry-After 헤더를 ms 로 변환합니다 (초 또는 HTTP-date). */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && String(seconds) === value.trim()) {
    return Math.max(0, seconds * 1000);
  }

  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, at - now);

  return null;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
