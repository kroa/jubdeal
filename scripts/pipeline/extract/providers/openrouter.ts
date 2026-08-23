import {
  EMPTY_USAGE,
  LlmRequestError,
  ProviderUnavailableError,
  looksLikeAuthError,
  looksLikeQuotaError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from '@pipeline/extract/providers/types';

/**
 * OpenRouter 프로바이더 (폴백)
 * ---------------------------------------------------------------------------
 * Claude Code CLI 가 요금제 한도 등으로 막혔을 때 대신 씁니다.
 * OpenRouter 는 OpenAI 호환 엔드포인트라 raw HTTP 로 호출합니다.
 * (Anthropic SDK 는 이 경로에 쓰지 않습니다 — 다른 제공자입니다.)
 *
 * 키는 환경변수에서만 읽습니다. 소스에 하드코딩하지 않습니다.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';
const DEFAULT_TIMEOUT_MS = 120_000;

export interface OpenRouterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** OpenRouter 순위 페이지에 표시될 사이트 정보 (선택) */
  siteUrl?: string;
  appName?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export class OpenRouterProvider implements LlmProvider {
  readonly name = 'openrouter';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly siteUrl?: string;
  private readonly appName?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;

  constructor(options: OpenRouterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.model = options.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.siteUrl = options.siteUrl ?? process.env.OPENROUTER_SITE_URL;
    this.appName = options.appName ?? process.env.OPENROUTER_APP_NAME;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.log = options.log ?? (() => {});
  }

  async isConfigured(): Promise<boolean> {
    return this.apiKey.trim() !== '';
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!(await this.isConfigured())) {
      throw new ProviderUnavailableError(
        this.name,
        'not_configured',
        'OPENROUTER_API_KEY 가 설정되지 않았습니다. (.env 참고)',
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.siteUrl) headers['HTTP-Referer'] = this.siteUrl;
    if (this.appName) headers['X-Title'] = this.appName;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          // OpenAI 호환 구조화 출력. 스키마를 벗어난 응답을 서버가 막아 줍니다.
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: request.schemaName,
              strict: true,
              schema: request.jsonSchema,
            },
          },
          temperature: 0,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderUnavailableError(this.name, 'unavailable', `요청 실패: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await response.text();

    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || looksLikeAuthError(bodyText)) {
        throw new ProviderUnavailableError(this.name, 'auth', `인증 실패 (${response.status})`);
      }
      if (response.status === 402 || response.status === 429 || looksLikeQuotaError(bodyText)) {
        throw new ProviderUnavailableError(
          this.name,
          'quota',
          `한도/크레딧 문제 (${response.status})`,
        );
      }
      if (response.status >= 500) {
        throw new ProviderUnavailableError(
          this.name,
          'unavailable',
          `서버 오류 ${response.status}`,
        );
      }
      throw new LlmRequestError(this.name, `HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
    }

    let payload: OpenRouterResponse;
    try {
      payload = JSON.parse(bodyText) as OpenRouterResponse;
    } catch {
      throw new LlmRequestError(
        this.name,
        `응답을 JSON 으로 읽지 못했습니다: ${bodyText.slice(0, 200)}`,
      );
    }

    // OpenRouter 는 200 으로도 오류 객체를 돌려줄 수 있습니다.
    if (payload.error) {
      const message = payload.error.message ?? '알 수 없는 오류';
      if (looksLikeQuotaError(message)) {
        throw new ProviderUnavailableError(this.name, 'quota', message);
      }
      throw new LlmRequestError(this.name, message);
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new LlmRequestError(this.name, '응답 본문이 비어 있습니다.');
    }

    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      throw new LlmRequestError(this.name, `응답이 JSON 이 아닙니다: ${content.slice(0, 200)}`);
    }

    this.log(`openrouter 응답 (${this.model})`);
    return { data, usage: toUsage(payload), provider: this.name };
  }
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cost?: number;
  };
  error?: { message?: string; code?: number };
}

function toUsage(payload: OpenRouterResponse): LlmUsage {
  const usage = payload.usage;
  if (!usage) return EMPTY_USAGE;

  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    costUsd: usage.cost ?? null,
  };
}
