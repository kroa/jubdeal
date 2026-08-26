import {
  EMPTY_USAGE,
  LlmRequestError,
  ProviderUnavailableError,
  looksLikeAuthError,
  looksLikeQuotaError,
  looksLikeTransientError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
} from '@pipeline/extract/providers/types';
import { parseJsonLoosely, jsonOnlyInstruction } from '@pipeline/extract/providers/openrouter';

/**
 * Google Gemini 프로바이더
 * ---------------------------------------------------------------------------
 * 프로바이더 순서에서 OpenRouter 보다 앞에 옵니다.
 *   claude-cli → gemini → openrouter
 *
 * Gemini 는 구조화 출력 스키마가 OpenAPI 서브셋이라 JSON Schema 를 그대로 못 씁니다.
 *   - `additionalProperties` 를 이해하지 못합니다.
 *   - null 을 `anyOf: [T, {type:'null'}]` 이 아니라 `nullable: true` 로 표현합니다.
 *   - `$schema`, `maxLength` 등 일부 키워드를 거부합니다.
 * 그래서 보내기 전에 변환하고, 그래도 거부하면 프롬프트 방식으로 물러섭니다.
 *
 * 무료 등급이 있지만 분당·일일 요청 수가 제한됩니다.
 * 429 는 대개 일시적이므로 OpenRouter 와 같은 방식으로 다룹니다.
 */

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_DISCOVERED = 6;

export interface GeminiOptions {
  apiKey?: string;
  baseUrl?: string;
  /** 우선 사용할 모델 목록. 비우면 자동 탐색 */
  models?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

/** "a, b" → ['a','b'] */
export function parseGeminiModels(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().replace(/^models\//, ''))
    .filter((entry) => entry !== '');
}

/**
 * JSON Schema → Gemini responseSchema (OpenAPI 서브셋)
 *
 * 그대로 보내면 400 이 납니다. 이해하지 못하는 키워드를 걷어내고
 * nullable 표현을 Gemini 방식으로 바꿉니다.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const source = schema as Record<string, unknown>;

  // anyOf: [T, {type:'null'}] → {...T, nullable: true}
  const anyOf = source.anyOf;
  if (Array.isArray(anyOf)) {
    const nonNull = anyOf.filter(
      (entry) =>
        !(entry && typeof entry === 'object' && (entry as { type?: string }).type === 'null'),
    );
    const hasNull = nonNull.length !== anyOf.length;

    if (hasNull && nonNull.length === 1) {
      const converted = toGeminiSchema(nonNull[0]) as Record<string, unknown>;
      const { description } = source;
      return { ...converted, nullable: true, ...(description ? { description } : {}) };
    }
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    // Gemini 가 이해하지 못하는 키워드는 버립니다.
    if (
      key === '$schema' ||
      key === 'additionalProperties' ||
      key === 'exclusiveMinimum' ||
      key === 'exclusiveMaximum' ||
      key === 'maxLength' ||
      key === 'minLength' ||
      key === 'maxItems' ||
      key === 'minItems' ||
      key === 'pattern'
    ) {
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        properties[name] = toGeminiSchema(child);
      }
      result.properties = properties;
      continue;
    }

    result[key] = toGeminiSchema(value);
  }

  return result;
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly configuredModels: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;

  private readonly exhausted = new Set<string>();
  private readonly noSchema = new Set<string>();
  private preferred: string | null = null;
  private discovered: string[] | null = null;

  constructor(options: GeminiOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.GEMINI_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.configuredModels = options.models ?? parseGeminiModels(process.env.GEMINI_MODELS);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
        'GEMINI_API_KEY 가 설정되지 않았습니다. (.env 참고)',
      );
    }

    const models = await this.modelsToTry();
    if (models.length === 0) {
      throw new ProviderUnavailableError(
        this.name,
        'not_configured',
        '사용할 모델이 없습니다. GEMINI_MODELS 를 지정하거나 모델 목록 조회가 되는지 확인하세요.',
      );
    }

    const failures: string[] = [];

    for (const model of models) {
      if (this.exhausted.has(model)) continue;

      try {
        const response = await this.callModel(model, request);
        this.preferred = model;
        return response;
      } catch (error) {
        if (error instanceof ProviderUnavailableError) {
          if (error.reason === 'auth') throw error;

          // 붐빔은 영구 배제하지 않습니다. 다음 모델로만 넘어갑니다.
          if (error.reason !== 'busy') this.exhausted.add(model);

          failures.push(`${model}: ${error.message}`);
          this.log(`${model} 사용 불가 (${error.reason}) — 다음 모델로 넘어갑니다.`);
          continue;
        }

        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
        this.log(`${model} 응답 실패 — 다음 모델로 넘어갑니다.`);
      }
    }

    throw new ProviderUnavailableError(
      this.name,
      'quota',
      `시도한 모델이 모두 실패했습니다.\n${failures.map((f) => `    - ${f}`).join('\n')}`,
    );
  }

  private async modelsToTry(): Promise<string[]> {
    const primary =
      this.configuredModels.length > 0 ? this.configuredModels : await this.discoverModels();

    if (this.preferred) {
      return [this.preferred, ...primary.filter((model) => model !== this.preferred)];
    }
    return [...new Set(primary)];
  }

  /**
   * 사용 가능한 모델을 조회합니다.
   * 모델 이름은 자주 바뀌므로 하드코딩하지 않습니다.
   * 가볍고 무료 등급이 있는 flash 계열을 먼저 씁니다.
   */
  private async discoverModels(): Promise<string[]> {
    if (this.discovered) return this.discovered;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { 'x-goog-api-key': this.apiKey },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = (await response.json()) as { models?: GeminiModelInfo[] };

      const usable = (payload.models ?? [])
        .filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((model) => String(model.name).replace(/^models\//, ''))
        // 이미지·음성 전용이나 임베딩 모델은 제외합니다.
        .filter((id) => !/embedding|aqa|imagen|veo|tts|image|audio|live/i.test(id))
        // 실험·프리뷰 채널은 불안정해 뒤로 미룹니다.
        .sort((a, b) => rankGeminiModel(a) - rankGeminiModel(b))
        .slice(0, MAX_DISCOVERED);

      this.discovered = usable;
      this.log(`Gemini 모델 ${usable.length}개 탐색: ${usable.join(', ')}`);
    } catch (error) {
      this.log(`Gemini 모델 탐색 실패: ${error instanceof Error ? error.message : String(error)}`);
      this.discovered = [];
    }

    return this.discovered;
  }

  private async callModel(model: string, request: LlmRequest): Promise<LlmResponse> {
    const useSchema = !this.noSchema.has(model);

    try {
      return await this.request(model, request, useSchema);
    } catch (error) {
      if (useSchema && error instanceof UnsupportedSchemaError) {
        this.noSchema.add(model);
        this.log(`${model} 이 스키마를 거부해 프롬프트 방식으로 재시도합니다.`);
        return this.request(model, request, false);
      }
      throw error;
    }
  }

  private async request(
    model: string,
    request: LlmRequest,
    useSchema: boolean,
  ): Promise<LlmResponse> {
    const generationConfig: Record<string, unknown> = {
      temperature: 0,
      responseMimeType: 'application/json',
    };

    if (useSchema) {
      generationConfig.responseSchema = toGeminiSchema(request.jsonSchema);
    }

    const system = useSchema
      ? request.system
      : `${request.system}\n\n${jsonOnlyInstruction(request.jsonSchema)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          generationConfig,
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
      if (response.status === 400 && looksLikeSchemaRejection(bodyText)) {
        throw new UnsupportedSchemaError(model);
      }
      if (response.status === 401 || response.status === 403 || looksLikeAuthError(bodyText)) {
        throw new ProviderUnavailableError(this.name, 'auth', `인증 실패 (${response.status})`);
      }
      if (response.status === 429 || looksLikeQuotaError(bodyText)) {
        const transient = looksLikeTransientError(bodyText) || response.status === 429;
        throw new ProviderUnavailableError(
          this.name,
          transient ? 'busy' : 'quota',
          transient
            ? `요청 한도에 걸렸습니다 (${response.status})`
            : `한도 문제 (${response.status})`,
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

    let payload: GeminiResponse;
    try {
      payload = JSON.parse(bodyText) as GeminiResponse;
    } catch {
      throw new LlmRequestError(this.name, `응답을 JSON 으로 읽지 못했습니다.`);
    }

    const candidate = payload.candidates?.[0];

    // 안전 필터에 걸리면 본문이 비어 옵니다. 내용을 읽기 전에 확인합니다.
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      throw new LlmRequestError(
        this.name,
        `${model}: 생성이 중단되었습니다 (${candidate.finishReason})`,
      );
    }

    const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    if (text.trim() === '') {
      throw new LlmRequestError(this.name, `${model}: 응답 본문이 비어 있습니다.`);
    }

    const data = parseJsonLoosely(text);
    if (data === undefined) {
      throw new LlmRequestError(this.name, `${model}: 응답에서 JSON 을 찾지 못했습니다.`);
    }

    this.log(`gemini 응답: ${model}${useSchema ? '' : ' (프롬프트 방식)'}`);
    return { data, usage: toUsage(payload), provider: `${this.name}:${model}` };
  }
}

class UnsupportedSchemaError extends Error {
  constructor(model: string) {
    super(`${model} 이 responseSchema 를 거부했습니다.`);
    this.name = 'UnsupportedSchemaError';
  }
}

export function looksLikeSchemaRejection(text: string): boolean {
  return /responseSchema|response_schema|schema|Invalid JSON payload|Unknown name/i.test(text);
}

/** flash·lite 계열을 먼저, 실험·프리뷰는 뒤로. */
export function rankGeminiModel(id: string): number {
  let score = 0;
  if (/flash/i.test(id)) score -= 10;
  if (/lite/i.test(id)) score -= 5;
  if (/pro/i.test(id)) score += 5;
  if (/exp|preview|thinking/i.test(id)) score += 20;
  return score;
}

interface GeminiModelInfo {
  name?: string;
  supportedGenerationMethods?: string[];
}

interface GeminiResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

function toUsage(payload: GeminiResponse): LlmUsage {
  const usage = payload.usageMetadata;
  if (!usage) return EMPTY_USAGE;

  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    cachedInputTokens: usage.cachedContentTokenCount ?? 0,
    // 무료 등급이면 0 입니다. Gemini 는 응답에 비용을 담지 않아 알 수 없습니다.
    costUsd: null,
  };
}
