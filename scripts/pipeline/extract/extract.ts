import { z } from 'zod';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  extractedDealSchema,
  type ExtractedDeal,
} from '@pipeline/extract/schema';
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserMessage,
  toReferenceDate,
} from '@pipeline/extract/prompt';
import {
  ProviderUnavailableError,
  createProvider,
  type LlmProvider,
  type LlmUsage,
} from '@pipeline/extract/providers/index';
import type { RawItem } from '@pipeline/types';

/**
 * LLM 추출기
 * ---------------------------------------------------------------------------
 * 이 프로젝트는 Anthropic API 를 **직접 호출하지 않습니다.**
 * VSCode 에 연결된 Claude Code(구독 인증)를 먼저 쓰고,
 * 막히면 Gemini → OpenRouter 순으로 넘어갑니다.
 *
 * 스키마를 두 번 거는 이유:
 *   프로바이더의 구조화 출력은 "형태"만 보장합니다.
 *   신뢰도 범위(0~1)나 날짜 형식 같은 의미 규칙은 zod 가 잡아야 합니다.
 */

export interface ExtractorOptions {
  provider?: LlmProvider;
  /** 이 값 미만이면 사람 검수 큐로 보냅니다. */
  confidenceThreshold?: number;
  log?: (message: string) => void;
}

export type ExtractionUsage = LlmUsage;

export type ExtractOutcome =
  | { ok: true; value: ExtractedDeal; usage: ExtractionUsage }
  | {
      ok: false;
      reason: 'not_a_deal' | 'schema_invalid' | 'api_error' | 'low_confidence';
      detail: string;
      candidate?: unknown;
      usage: ExtractionUsage;
    };

const EMPTY_USAGE: ExtractionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  costUsd: null,
};

/**
 * zod 스키마를 프로바이더에 넘길 JSON Schema 로 변환합니다 (모듈 로드 시 1회).
 *
 * `$schema` 키는 반드시 빼야 합니다.
 * Claude Code CLI 의 `--json-schema` 검증기가 draft-2020-12 메타스키마 참조를
 * 해석하지 못해 "no schema with key or ref" 로 요청 자체를 거부합니다.
 * (OpenRouter 도 이 키를 필요로 하지 않습니다.)
 */
export const EXTRACTION_JSON_SCHEMA = stripSchemaKeyword(
  z.toJSONSchema(extractedDealSchema, { target: 'draft-2020-12' }) as Record<string, unknown>,
);

function stripSchemaKeyword(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dropped, ...rest } = schema;
  return rest;
}

/**
 * 한국어 결과에 한자(CJK 통합 한자)가 섞였는지 검사합니다.
 *
 * 무료 다국어 모델은 한국어 문장에 중국어 단어를 섞는 일이 있습니다.
 * 실제로 관찰된 예: "아메리카노 톨 사이즈 1잔免费 쿠폰" (免费 = 무료)
 *
 * 스키마도 통과하고 신뢰도도 0.95 로 높게 나오기 때문에 기존 방어선으로는
 * 걸러지지 않습니다. 사용자에게 그대로 노출되므로 검수 큐로 보냅니다.
 *
 * 요즘 한국어 프로모션 문구는 한자를 거의 쓰지 않아 오탐 위험이 낮습니다.
 * 버리지 않고 검수로 넘기므로, 오탐이어도 사람이 확인해 살릴 수 있습니다.
 */
export function findCjkIdeographs(text: string): string[] {
  return [...new Set(text.match(/[一-鿿]/g) ?? [])];
}

/**
 * 브랜드명 근거 검사에서 인정하는 최소 접두사 길이.
 *
 * 3 으로 뒀더니 "신한카드"가 원문 "신한 Discount Plan+" 를 못 찾았습니다.
 * 접두사가 "신한카"까지밖에 안 줄어들기 때문입니다. 브랜드 뒤에 "카드"·"몰"
 * 같은 말을 붙이는 것은 매우 흔해서, 이대로면 멀쩡한 카드 이벤트가 전부
 * 걸립니다. 목적은 "코웨이"처럼 **원문에 흔적조차 없는** 것을 잡는 것이지
 * 표기를 엄밀히 대조하는 것이 아닙니다.
 */
const BRAND_PREFIX_MIN = 2;

/**
 * 모델이 말한 브랜드가 **원문에 실제로 나오는지** 봅니다.
 *
 * 문화포털의 전시 안내(645자, 코웨이라는 말이 한 번도 없음)를 읽히자
 * 모델이 "코웨이 렌탈료 자동이체 시 포인트 적립"을 내놨습니다. 스키마도
 * 통과하고 신뢰도 0.95 였습니다. 직전 요청의 내용이 샌 것으로 보입니다.
 *
 * 링크는 이미 `pickLinkUrl` 이 원문 대조로 막고 있었지만, 제목·브랜드는
 * 아무도 보지 않았습니다. 링크가 멀쩡해도 **엉뚱한 혜택 설명이 그대로
 * 노출**됩니다. 한자 혼용보다 나쁩니다 — 틀린 글자가 아니라 없는 사실입니다.
 *
 * 표기가 조금씩 다른 것은 정상이라("KB국민카드" ↔ 원문 "KB국민"),
 * 전체가 아니라 **앞에서부터 줄여 본 접두사**가 걸리면 통과시킵니다.
 */
export function isBrandGrounded(brandName: string, sourceText: string): boolean {
  const brand = normalizeForMatch(brandName);
  if (brand.length < BRAND_PREFIX_MIN) return true; // 너무 짧으면 판단하지 않습니다.

  const haystack = normalizeForMatch(sourceText);

  for (let length = brand.length; length >= BRAND_PREFIX_MIN; length -= 1) {
    if (haystack.includes(brand.slice(0, length))) return true;
  }

  return false;
}

/**
 * 기호를 걷어내고 소문자로. 표기 흔들림 때문에 빗나가지 않게 합니다.
 *
 * **공백은 남깁니다.** 처음엔 함께 지웠는데, 그러면 단어 경계가 사라져
 * 없던 말이 생깁니다 — "코스트코 웨이브"가 "코스트코웨이브"가 되면서
 * 그 안에서 "코웨이"가 매칭됐습니다. 정확히 막으려던 그 브랜드입니다.
 */
function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[()[\]{}·,.'"“”‘’\-_/\\]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class DealExtractor {
  private readonly provider: LlmProvider;
  private readonly threshold: number;
  private readonly log: (message: string) => void;

  constructor(options: ExtractorOptions = {}) {
    this.log = options.log ?? (() => {});
    this.provider = options.provider ?? createProvider({ log: this.log });
    this.threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  }

  async extract(item: RawItem, now: Date): Promise<ExtractOutcome> {
    let response;

    try {
      response = await this.provider.complete({
        // 요청마다 완전히 동일해야 프롬프트 캐시가 걸립니다.
        system: EXTRACTION_SYSTEM_PROMPT,
        user: buildExtractionUserMessage(item, toReferenceDate(now), item.categoryHint),
        jsonSchema: EXTRACTION_JSON_SCHEMA,
        schemaName: 'extracted_deal',
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'api_error',
        detail: describeProviderError(error),
        usage: EMPTY_USAGE,
      };
    }

    const usage = response.usage;

    // 형태는 프로바이더가 강제했지만 의미 규칙은 여기서 봅니다.
    const parsed = extractedDealSchema.safeParse(response.data);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');

      return {
        ok: false,
        reason: 'schema_invalid',
        detail: issues,
        candidate: response.data,
        usage,
      };
    }

    const value = parsed.data;

    if (!value.isDeal) {
      return {
        ok: false,
        reason: 'not_a_deal',
        detail: value.notes || '혜택 정보가 아니라고 판단했습니다.',
        candidate: value,
        usage,
      };
    }

    // 사용자에게 그대로 노출되는 필드에 한자가 섞이지 않았는지 확인합니다.
    const foreign = findCjkIdeographs(`${value.title} ${value.summary}`);
    if (foreign.length > 0) {
      return {
        ok: false,
        reason: 'low_confidence',
        detail:
          `제목·요약에 한자가 섞였습니다 (${foreign.join('')}). ` +
          '모델이 다른 언어를 섞은 것으로 보입니다. 문구를 확인해 주세요.',
        candidate: value,
        usage,
      };
    }

    // 원문에 없는 브랜드를 말했다면 다른 문서의 내용이 섞인 것입니다.
    if (!isBrandGrounded(value.brandName, item.text)) {
      return {
        ok: false,
        reason: 'low_confidence',
        detail:
          `브랜드 "${value.brandName}" 가 원문에 없습니다. ` +
          '다른 문서의 내용이 섞였을 수 있으니 원문과 대조해 주세요.',
        candidate: value,
        usage,
      };
    }

    if (value.confidence < this.threshold) {
      return {
        ok: false,
        reason: 'low_confidence',
        detail: `신뢰도 ${value.confidence.toFixed(2)} < 임계값 ${this.threshold}: ${value.notes}`,
        candidate: value,
        usage,
      };
    }

    this.log(
      `추출 성공 (${response.provider}, 신뢰도 ${value.confidence.toFixed(2)}): ${value.title}`,
    );
    return { ok: true, value, usage };
  }
}

/** 오류를 사람이 읽을 수 있는 안내로 바꿉니다. */
export function describeProviderError(error: unknown): string {
  if (error instanceof ProviderUnavailableError) {
    switch (error.reason) {
      case 'not_configured':
        return `${error.message}\n  → .env 의 GEMINI_API_KEY(또는 OPENROUTER_API_KEY)를 설정하거나 VSCode 에서 Claude 에 로그인하세요.`;
      case 'quota':
        return `${error.message}\n  → 한도에 걸렸습니다. GEMINI_MODELS 나 OPENROUTER_FREE_MODELS 에 모델을 더 넣거나 잠시 뒤 다시 실행하세요.`;
      case 'busy':
        return `${error.message}\n  → 무료 공용 풀이 붐비는 중입니다. 잠시 뒤 다시 실행하면 대개 풀립니다.`;
      case 'auth':
        return `${error.message}\n  → API 키가 유효한지 확인하세요.`;
      case 'unavailable':
        return `${error.message}\n  → 모델 설정을 확인하세요. GEMINI_MODELS / OPENROUTER_FREE_MODELS 를 비우면 자동 탐색합니다.`;
      default:
        return error.message;
    }
  }

  return error instanceof Error ? error.message : String(error);
}
