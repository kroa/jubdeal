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
 * VSCode 에 연결된 Claude Code(구독 인증)를 쓰고, 막히면 OpenRouter 로 넘어갑니다.
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
        user: buildExtractionUserMessage(item, toReferenceDate(now)),
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
        return `${error.message}\n  → .env 의 OPENROUTER_API_KEY 를 설정하거나 VSCode 에서 Claude 에 로그인하세요.`;
      case 'quota':
        return `${error.message}\n  → 요금제 한도입니다. OPENROUTER_API_KEY 를 설정하면 자동으로 폴백합니다.`;
      case 'auth':
        return `${error.message}\n  → 인증을 확인하세요.`;
      default:
        return error.message;
    }
  }

  return error instanceof Error ? error.message : String(error);
}
