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
 * 제목의 낱말이 이만큼도 원문에 없으면 다른 문서를 읽은 것으로 봅니다.
 *
 * 모델은 제목을 그대로 베끼지 않고 다듬어 쓰므로 100% 를 요구할 수 없습니다.
 * 실측한 값들입니다.
 *
 *   "[카카오톡]질레트 프로쉴드 면도날8입+핸들+미니젤 (34,110원/무료)"   1.00
 *   "Warhammer 40,000: Space Marine 2"                              1.00
 *   "코웨이 렌탈료 자동이체 시 포인트 적립"  (문화포털 전시 안내)        0.00
 *
 * 진짜와 환각 사이가 넓게 벌어져 있어 경계를 낮게 잡아도 충분합니다.
 */
const TITLE_GROUNDING_MIN = 0.3;

/**
 * 모델이 붙인 제목이 **원문에서 나온 것인지** 봅니다.
 *
 * 문화포털의 전시 안내(645자, 코웨이라는 말이 한 번도 없음)를 읽히자
 * 모델이 "코웨이 렌탈료 자동이체 시 포인트 적립"을 내놨습니다. 스키마도
 * 통과하고 신뢰도 0.95 였습니다. 직전 요청의 내용이 샌 것으로 보입니다.
 *
 * 링크는 이미 `pickLinkUrl` 이 원문 대조로 막고 있었지만, 제목은 아무도
 * 보지 않았습니다. 링크가 멀쩡해도 **엉뚱한 혜택 설명이 그대로 노출**됩니다.
 * 한자 혼용보다 나쁩니다 — 틀린 글자가 아니라 없는 사실입니다.
 *
 * 처음에는 브랜드 한 단어만 대조했는데 표기 언어가 갈리면 그대로 오탐이
 * 났습니다 — 원문이 "질레트"인데 모델은 "Gillette", 스팀 상품 페이지는
 * 로고가 이미지라 본문에 "Steam" 이라는 글자가 없습니다. 한 단어에 걸면
 * 이런 게 전부 걸리므로, **제목 전체에서 원문과 겹치는 비율**을 봅니다.
 */
export function titleGroundingRatio(title: string, sourceText: string): number {
  const words = normalizeForMatch(title)
    .split(/[\s+/|]+/)
    .filter((word) => word.length >= 2);

  if (words.length === 0) return 1; // 판단할 근거가 없으면 통과시킵니다.

  const haystack = normalizeForMatch(sourceText);
  const hits = words.filter((word) => haystack.includes(word)).length;

  return hits / words.length;
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

/**
 * `"openrouter:dots-studio/dots-3-note-preview:free"` → 모델 이름만.
 *
 * 응답의 `provider` 는 `프로바이더:모델` 형태입니다. 모델 이름 자체에도
 * 콜론이 들어가므로(`:free` 접미사) **첫 번째 콜론에서만** 자릅니다.
 * 프로바이더 이름만 있고 모델이 없으면 null 입니다.
 */
export function modelFromProviderLabel(label: string): string | null {
  const at = label.indexOf(':');
  if (at < 0) return null;

  const model = label.slice(at + 1).trim();
  return model === '' ? null : model;
}

/**
 * 한 모델이 이만큼 스키마를 어기면 구조화 출력을 못 하는 것으로 봅니다.
 *
 * 한 번은 봐줍니다 — 긴 본문에서 필드 하나를 흘리는 일은 어느 모델에나 있습니다.
 * 두 번째부터는 우연이 아닙니다. 실제로 한 모델이 우리 스키마를 통째로
 * 무시하고 `price`·`shippingCost`·`benefitType` 처럼 그럴듯한 이름을
 * 지어내 다섯 건을 연달아 날렸습니다.
 */
const SCHEMA_FAILURES_BEFORE_BAN = 2;

export class DealExtractor {
  private readonly provider: LlmProvider;
  private readonly threshold: number;
  private readonly log: (message: string) => void;
  /** 모델별 스키마 위반 횟수 */
  private readonly schemaFailures = new Map<string, number>();

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

      this.noteSchemaFailure(response.provider);

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
      /*
        이 모델은 이번 실행에서 그만 씁니다.

        프롬프트에 "한국어로만 쓰세요"를 넣고 예시까지 들었는데도 같은 모델이
        계속 섞었습니다(`免费`, `参免费`, `生态公园入场`). 게다가 성공한 모델은
        "마지막 성공 모델"로 캐시되어 다음 항목에서도 다시 뽑힙니다 —
        한 소스에서 3건 중 2건이 이렇게 날아갔습니다.

        배제하지 않으면 남은 항목이 계속 같은 방식으로 버려집니다.
      */
      const model = modelFromProviderLabel(response.provider);
      if (model !== null) {
        this.provider.banModel?.(model);
        this.log(`${model} 이 한국어에 한자를 섞어 이번 실행에서 제외합니다.`);
      }

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

    /*
      제목이 원문에서 나온 것인지 봅니다.

      **목록 제목도 원문입니다.** 상세 본문만 봤더니 딜바다 핫딜이 전멸했습니다.
      그쪽은 상품명이 제목에만 있고("[지마켓라이브] 1++등급 한우 선물세트")
      본문은 84자짜리 한 줄입니다.
    */
    const grounding = titleGroundingRatio(value.title, `${item.title ?? ''}\n${item.text}`);
    if (grounding < TITLE_GROUNDING_MIN) {
      return {
        ok: false,
        reason: 'low_confidence',
        detail:
          `제목의 낱말 중 ${Math.round(grounding * 100)}% 만 원문에 있습니다 ("${value.title}"). ` +
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

  /** 스키마를 반복해서 어기는 모델은 이번 실행에서 내립니다. */
  private noteSchemaFailure(providerLabel: string): void {
    const model = modelFromProviderLabel(providerLabel);
    if (model === null) return;

    const count = (this.schemaFailures.get(model) ?? 0) + 1;
    this.schemaFailures.set(model, count);

    if (count === SCHEMA_FAILURES_BEFORE_BAN) {
      this.provider.banModel?.(model);
      this.log(`${model} 이 스키마를 ${count}번 어겨 이번 실행에서 제외합니다.`);
    }
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
