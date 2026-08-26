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

/**
 * OpenRouter 프로바이더 (무료 티어 사용 전제)
 * ---------------------------------------------------------------------------
 * Claude Code CLI 가 요금제 한도로 막혔을 때 대신 씁니다.
 * OpenAI 호환 엔드포인트라 raw HTTP 로 호출합니다.
 *
 * 무료 모델은 유료 모델과 성질이 달라 세 가지를 따로 다룹니다.
 *
 * 1. **대부분 구조화 출력을 지원하지 않습니다.**
 *    실측 기준 `:free` 모델 18개 중 5개만 `structured_outputs` 를 지원합니다.
 *    지원 모델은 `response_format` 으로 스키마를 강제하고,
 *    미지원 모델은 프롬프트로 JSON 을 요구한 뒤 본문에서 JSON 을 추출합니다.
 *
 * 2. **레이트 리밋이 빡빡합니다.**
 *    한 모델이 429 를 내면 그 모델만 이번 실행에서 배제하고 다음 모델로 넘어갑니다.
 *    프로바이더 전체를 포기하지 않습니다.
 *
 * 3. **모델 목록이 자주 바뀝니다.**
 *    목록을 비워 두면 `/models` 를 조회해 무료 모델을 자동으로 찾습니다.
 *    구조화 출력을 지원하는 모델을 먼저, 그다음 컨텍스트가 큰 순서로 씁니다.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 120_000;
/** 자동 탐색으로 가져올 최대 모델 수 */
const MAX_DISCOVERED = 8;
/** 일시적 붐빔일 때 같은 모델을 다시 시도하는 횟수 */
const TRANSIENT_RETRIES = 2;
/** 일시적 붐빔 후 그 모델을 쉬게 하는 시간(ms) */
const TRANSIENT_COOLDOWN_MS = 20_000;

export interface OpenRouterOptions {
  apiKey?: string;
  baseUrl?: string;
  /** 우선 사용할 모델 목록. 비우면 자동 탐색 */
  freeModels?: string[];
  /** 위 목록이 모두 실패했을 때 순서대로 시도할 예비 모델 */
  fallbackModels?: string[];
  /**
   * 유료 모델 호출을 허용할지. 기본은 **false** — 무료가 아니면 아예 부르지 않습니다.
   * (env: OPENROUTER_ALLOW_PAID=true)
   */
  allowPaid?: boolean;
  timeoutMs?: number;
  siteUrl?: string;
  appName?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

/** "a, b , c" → ['a','b','c'] */
export function parseModelList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export class OpenRouterProvider implements LlmProvider {
  readonly name = 'openrouter';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly configuredModels: string[];
  private readonly fallbackModels: string[];
  private readonly timeoutMs: number;
  private readonly siteUrl?: string;
  private readonly appName?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;

  /** 이번 실행에서 확정적으로 못 쓰게 된 모델 (다시 시도하지 않음) */
  private readonly exhausted = new Set<string>();
  /** 일시적으로 붐벼서 잠깐 쉬는 모델 → 재시도 가능 시각(ms) */
  private readonly cooldownUntil = new Map<string, number>();
  /** 설정이 잘못됐다고 이미 알린 모델 (같은 경고를 반복하지 않으려고) */
  private readonly warned = new Set<string>();
  /** 구조화 출력을 거부한 모델 (다음부터는 프롬프트 방식으로) */
  private readonly noStructuredOutput = new Set<string>();
  /** 마지막으로 성공한 모델 — 다음 요청에서 먼저 시도합니다 */
  private preferred: string | null = null;
  private discovered: string[] | null = null;
  /** /models 응답 캐시. 탐색과 유료 차단이 함께 씁니다. */
  private catalogue: Map<string, ModelInfo> | null | undefined;
  private readonly allowPaid: boolean;

  constructor(options: OpenRouterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.configuredModels =
      options.freeModels ?? parseModelList(process.env.OPENROUTER_FREE_MODELS);
    this.fallbackModels =
      options.fallbackModels ?? parseModelList(process.env.OPENROUTER_FALLBACK_MODELS);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.siteUrl = options.siteUrl ?? process.env.OPENROUTER_SITE_URL;
    this.appName = options.appName ?? process.env.OPENROUTER_APP_NAME;
    this.allowPaid = options.allowPaid ?? process.env.OPENROUTER_ALLOW_PAID === 'true';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.log = options.log ?? (() => {});
  }

  async isConfigured(): Promise<boolean> {
    return this.apiKey.trim() !== '';
  }

  /**
   * 무료가 아닌 모델을 호출하기 전에 막습니다.
   *
   * 설정 파일에 유료 모델을 적으면 그대로 과금됩니다.
   * 오타 하나로 요금이 나가는 상황을 코드에서 차단합니다.
   * 카탈로그를 못 읽었을 때는 확인할 방법이 없으므로 `:free` 접미사만 허용합니다.
   *
   * @returns 막아야 하면 이유, 통과면 null
   */
  private async blockIfPaid(model: string): Promise<string | null> {
    if (this.allowPaid) return null;

    const catalogue = await this.loadCatalogue();

    // 목록을 못 읽었거나 비어 있으면 검증할 방법이 없습니다.
    // (비어 있다는 건 모델이 사라진 게 아니라 조회가 잘못됐다는 뜻입니다.)
    // 이럴 때는 보수적으로 `:free` 접미사만 허용합니다.
    if (!catalogue || catalogue.size === 0) {
      return model.endsWith(':free')
        ? null
        : '모델 목록을 확인할 수 없어 무료 여부를 검증하지 못했습니다 (:free 모델만 허용).';
    }

    const info = catalogue.get(model);
    if (!info) {
      // 목록은 읽었는데 그 안에 없음 → 오타이거나 사라진 모델입니다.
      return ':free 접미사라도 목록에 없으면 호출해도 실패합니다. 이름을 확인하세요.';
    }

    if (!isFreeModel(info)) {
      const prompt = info.pricing?.prompt ?? '?';
      const completion = info.pricing?.completion ?? '?';
      return (
        `유료 모델입니다 (prompt ${prompt} / completion ${completion}). ` +
        '무료만 쓰려면 설정에서 빼세요. 의도한 것이라면 OPENROUTER_ALLOW_PAID=true 를 설정하세요.'
      );
    }

    return null;
  }

  /** /models 를 한 번만 읽어 캐시합니다. 실패하면 null. */
  private async loadCatalogue(): Promise<Map<string, ModelInfo> | null> {
    if (this.catalogue !== undefined) return this.catalogue;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = (await response.json()) as { data?: ModelInfo[] };
      this.catalogue = new Map((payload.data ?? []).map((model) => [model.id, model]));
    } catch (error) {
      this.log(`모델 목록 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
      this.catalogue = null;
    }

    return this.catalogue;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!(await this.isConfigured())) {
      throw new ProviderUnavailableError(
        this.name,
        'not_configured',
        'OPENROUTER_API_KEY 가 설정되지 않았습니다. (.env 참고)',
      );
    }

    const models = await this.modelsToTry();
    if (models.length === 0) {
      throw new ProviderUnavailableError(
        this.name,
        'not_configured',
        '사용할 모델이 없습니다. OPENROUTER_FREE_MODELS 를 지정하거나 무료 모델 자동 탐색이 되는지 확인하세요.',
      );
    }

    const failures: string[] = [];

    const now = Date.now();

    for (const model of models) {
      if (this.exhausted.has(model)) continue;

      const cooldown = this.cooldownUntil.get(model);
      if (cooldown !== undefined && cooldown > now) continue;

      // 무료가 아니면 호출 자체를 하지 않습니다.
      const blocked = await this.blockIfPaid(model);
      if (blocked) {
        this.exhausted.add(model);
        failures.push(`${model}: ${blocked}`);
        if (!this.warned.has(model)) {
          this.warned.add(model);
          this.log(`${model} 건너뜀 — ${blocked}`);
        }
        continue;
      }

      try {
        const response = await this.withTransientRetry(model, request);
        this.preferred = model;
        return response;
      } catch (error) {
        if (error instanceof ProviderUnavailableError) {
          // 인증 문제는 모델을 바꿔도 똑같습니다. 즉시 포기합니다.
          if (error.reason === 'auth') throw error;

          if (error.reason === 'busy') {
            // 공용 풀이 붐비는 것뿐이라 잠시 뒤엔 다시 쓸 수 있습니다.
            // 영구 배제하면 쓸 수 있는 모델을 통째로 버리게 됩니다.
            this.cooldownUntil.set(model, Date.now() + TRANSIENT_COOLDOWN_MS);
            this.log(`${model} 이 붐빕니다 — 잠시 쉬고 다음 모델로 넘어갑니다.`);
          } else {
            this.exhausted.add(model);
            this.log(`${model} 사용 불가 (${error.reason}) — 다음 모델로 넘어갑니다.`);
          }

          failures.push(`${model}: ${error.message}`);
          continue;
        }

        // 모델이 스키마를 못 지키거나 이상한 응답을 준 경우.
        // 무료 모델은 품질 편차가 커서 다른 모델이면 될 수 있으므로 넘어갑니다.
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

  /** 시도 순서: 마지막 성공 모델 → 설정 목록 → 예비 목록 → 자동 탐색 */
  private async modelsToTry(): Promise<string[]> {
    const configured = [...this.configuredModels, ...this.fallbackModels];

    /*
      설정한 모델은 "선호"이지 상한이 아닙니다.

      무료 공용 풀은 특정 모델이 며칠씩 붐비는 일이 흔합니다.
      (사용자가 지정한 gemma 두 모델이 실제로 계속 429 를 돌려줬습니다.)
      그때 목록에 없다는 이유로 통째로 실패하면, 쓸 수 있는 무료 모델이
      여덟 개나 남아 있는데도 수집이 0건으로 끝납니다.

      그래서 설정 목록을 앞에 두되, 뒤에 탐색 결과를 붙여 둡니다.
      탐색은 유료 모델을 걸러내므로 요금이 새어 나갈 여지는 없습니다.
    */
    const discovered = await this.discoverFreeModels();
    const ordered = configured.length > 0 ? [...configured, ...discovered] : discovered;

    if (this.preferred) {
      return dedupe([this.preferred, ...ordered.filter((model) => model !== this.preferred)]);
    }
    return dedupe(ordered);
  }

  /**
   * `/models` 에서 무료 모델을 찾습니다.
   * 구조화 출력을 지원하는 모델을 먼저 두고, 그다음 컨텍스트가 큰 순서입니다.
   * 실패하면 빈 배열을 돌려 예비 목록으로 넘어가게 합니다.
   */
  private async discoverFreeModels(): Promise<string[]> {
    if (this.discovered) return this.discovered;

    const catalogue = await this.loadCatalogue();
    if (!catalogue) {
      this.discovered = [];
      return this.discovered;
    }

    {
      const free = [...catalogue.values()].filter(
        (model) => isFreeModel(model) && isTextOnlyModel(model),
      );

      const ranked = free
        .map((model) => ({
          id: model.id,
          structured: (model.supported_parameters ?? []).includes('structured_outputs'),
          context: model.context_length ?? 0,
        }))
        .sort((a, b) => {
          // 스키마를 강제할 수 있는 모델이 훨씬 안정적입니다.
          if (a.structured !== b.structured) return a.structured ? -1 : 1;
          return b.context - a.context;
        })
        .slice(0, MAX_DISCOVERED);

      this.discovered = ranked.map((model) => model.id);

      const structuredCount = ranked.filter((model) => model.structured).length;
      this.log(
        `무료 모델 ${this.discovered.length}개 탐색 (구조화 출력 지원 ${structuredCount}개): ` +
          this.discovered.join(', '),
      );
    }

    return this.discovered;
  }

  /** 일시적 붐빔이면 짧게 기다렸다가 같은 모델을 다시 시도합니다. */
  private async withTransientRetry(model: string, request: LlmRequest): Promise<LlmResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.callModel(model, request);
      } catch (error) {
        const busy = error instanceof ProviderUnavailableError && error.reason === 'busy';
        if (!busy || attempt >= TRANSIENT_RETRIES) throw error;

        const wait = 1500 * (attempt + 1);
        this.log(`${model} 붐빔 — ${wait}ms 후 재시도 (${attempt + 1}/${TRANSIENT_RETRIES})`);
        await sleep(wait);
      }
    }
  }

  private async callModel(model: string, request: LlmRequest): Promise<LlmResponse> {
    const useSchema = !this.noStructuredOutput.has(model);

    try {
      return await this.request(model, request, useSchema);
    } catch (error) {
      // 구조화 출력을 지원하지 않는 모델이면 프롬프트 방식으로 한 번 더 시도합니다.
      if (useSchema && error instanceof UnsupportedStructuredOutputError) {
        this.noStructuredOutput.add(model);
        this.log(`${model} 은 구조화 출력을 지원하지 않아 프롬프트 방식으로 재시도합니다.`);
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
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.siteUrl) headers['HTTP-Referer'] = this.siteUrl;
    if (this.appName) headers['X-Title'] = this.appName;

    const body: Record<string, unknown> = {
      model,
      messages: [
        {
          role: 'system',
          content: useSchema
            ? request.system
            : `${request.system}\n\n${jsonOnlyInstruction(request.jsonSchema)}`,
        },
        { role: 'user', content: request.user },
      ],
      temperature: 0,
    };

    if (useSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: request.schemaName, strict: true, schema: request.jsonSchema },
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderUnavailableError(this.name, 'unavailable', `요청 실패: ${message}`);
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await response.text();

    if (!response.ok) {
      if (looksLikeUnsupportedSchema(bodyText)) throw new UnsupportedStructuredOutputError(model);

      if (response.status === 401 || response.status === 403 || looksLikeAuthError(bodyText)) {
        throw new ProviderUnavailableError(this.name, 'auth', `인증 실패 (${response.status})`);
      }
      if (response.status === 402 || response.status === 429 || looksLikeQuotaError(bodyText)) {
        // 무료 모델의 429 는 대개 "공용 풀이 잠깐 붐빔"입니다.
        // 사용자 한도와 구분해야 잠시 뒤면 쓸 수 있는 모델을 버리지 않습니다.
        const transient = response.status === 429 && looksLikeTransientError(bodyText);

        throw new ProviderUnavailableError(
          this.name,
          transient ? 'busy' : 'quota',
          transient
            ? `일시적으로 붐빕니다 (${response.status})`
            : `한도/크레딧 문제 (${response.status})`,
        );
      }
      if (response.status >= 500) {
        throw new ProviderUnavailableError(
          this.name,
          'unavailable',
          `서버 오류 ${response.status}`,
        );
      }
      if (response.status === 404 && /unavailable for free|no endpoints/i.test(bodyText)) {
        // 설정에 적힌 모델이 더 이상 무료로 제공되지 않는 경우입니다.
        // 목록을 고치지 않으면 매 실행마다 같은 자리에서 낭비합니다.
        if (!this.warned.has(model)) {
          this.warned.add(model);
          this.log(
            `${model} 은 더 이상 무료로 제공되지 않습니다. ` +
              'OPENROUTER_FREE_MODELS 에서 빼거나, 비워 두고 자동 탐색을 쓰세요.',
          );
        }
        throw new ProviderUnavailableError(
          this.name,
          'unavailable',
          `${model} 은 무료로 제공되지 않습니다 (설정을 확인하세요).`,
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
      if (looksLikeUnsupportedSchema(message)) throw new UnsupportedStructuredOutputError(model);
      if (looksLikeQuotaError(message)) {
        throw new ProviderUnavailableError(this.name, 'quota', message);
      }
      throw new LlmRequestError(this.name, message);
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new LlmRequestError(this.name, `${model}: 응답 본문이 비어 있습니다.`);
    }

    const data = parseJsonLoosely(content);
    if (data === undefined) {
      throw new LlmRequestError(this.name, `${model}: 응답에서 JSON 을 찾지 못했습니다.`);
    }

    this.log(`openrouter 응답: ${model}${useSchema ? '' : ' (프롬프트 방식)'}`);
    return { data, usage: toUsage(payload), provider: `${this.name}:${model}` };
  }
}

/** 구조화 출력을 지원하지 않는 모델을 만났다는 내부 신호 */
class UnsupportedStructuredOutputError extends Error {
  constructor(model: string) {
    super(`${model} 은 구조화 출력을 지원하지 않습니다.`);
    this.name = 'UnsupportedStructuredOutputError';
  }
}

export function looksLikeUnsupportedSchema(text: string): boolean {
  return (
    /response_format|structured[_ ]?output|json[_ ]?schema/i.test(text) &&
    /not support|unsupported|invalid|unrecognized|no endpoints/i.test(text)
  );
}

/** 구조화 출력을 못 쓰는 모델에게 JSON 만 내도록 지시합니다. */
export function jsonOnlyInstruction(schema: Record<string, unknown>): string {
  return [
    '## 출력 형식 (반드시 지킬 것)',
    '',
    '아래 JSON Schema 를 만족하는 **JSON 객체 하나만** 출력하세요.',
    '설명, 인사말, 마크다운 코드펜스를 붙이지 마세요. 첫 글자는 { 여야 합니다.',
    '',
    '```',
    JSON.stringify(schema),
    '```',
  ].join('\n');
}

/**
 * 본문에서 JSON 객체를 꺼냅니다.
 * 구조화 출력을 못 쓰는 모델은 코드펜스나 설명을 덧붙이는 일이 흔해,
 * 그대로 JSON.parse 하면 멀쩡한 응답을 버리게 됩니다.
 */
export function parseJsonLoosely(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    /* 아래에서 재시도 */
  }

  // ```json ... ``` 코드펜스 안쪽
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* 계속 */
    }
  }

  // 첫 { 부터 마지막 } 까지
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* 계속 */
    }
  }

  return undefined;
}

interface ModelInfo {
  id: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

/** `:free` 접미사이거나 입력·출력 단가가 0인 모델 */
export function isFreeModel(model: ModelInfo): boolean {
  if (String(model.id).endsWith(':free')) return true;

  const prompt = Number.parseFloat(model.pricing?.prompt ?? 'NaN');
  const completion = Number.parseFloat(model.pricing?.completion ?? 'NaN');
  return prompt === 0 && completion === 0;
}

/**
 * 텍스트를 넣어 텍스트만 받는 모델인지.
 *
 * 무료 목록에는 음악·이미지 생성 모델도 섞여 있습니다.
 * (예: `google/lyria-3-pro-preview` 는 출력이 text+audio 인 음악 생성 모델)
 * 이런 모델에 프로모션 본문을 보내면 슬롯만 낭비하고 쓸모없는 응답을 받습니다.
 * 출력이 text 하나뿐인 모델만 씁니다.
 */
export function isTextOnlyModel(model: ModelInfo): boolean {
  const input = model.architecture?.input_modalities;
  const output = model.architecture?.output_modalities;

  // 정보가 없으면 배제하지 않습니다(구형 항목일 수 있음).
  if (!Array.isArray(input) || !Array.isArray(output)) return true;

  return input.includes('text') && output.length === 1 && output[0] === 'text';
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
    // 무료 모델은 0 입니다. 값이 없으면 null 로 두어 "모름"과 구분합니다.
    costUsd: usage.cost ?? null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupe(models: string[]): string[] {
  return [...new Set(models)];
}
