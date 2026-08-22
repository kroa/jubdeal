import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
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
import type { RawItem } from '@pipeline/types';

/**
 * LLM 추출기
 * ---------------------------------------------------------------------------
 * `client.messages.parse()` + `zodOutputFormat()` 으로 스키마를 강제합니다.
 * 자유 텍스트를 받아 정규식으로 JSON 을 긁어내는 방식보다 훨씬 안정적이고,
 * 스키마 위반이 조용히 통과하지 않습니다.
 *
 * 시스템 프롬프트는 요청마다 동일하므로 캐시 대상으로 표시합니다.
 * 페이지 수가 늘수록 절감 폭이 커집니다(캐시 읽기는 약 1/10 비용).
 */

/** 기본 모델. 추출 품질이 곧 서비스 신뢰도라 최상위 모델을 씁니다. */
export const DEFAULT_MODEL = 'claude-opus-5';

export interface ExtractorOptions {
  client?: Anthropic;
  model?: string;
  /** 이 값 미만이면 사람 검수 큐로 보냅니다. */
  confidenceThreshold?: number;
  /** 추론 강도. 대량 처리 시 'medium' 으로 낮춰 비용을 줄일 수 있습니다. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  log?: (message: string) => void;
}

export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export type ExtractOutcome =
  | { ok: true; value: ExtractedDeal; usage: ExtractionUsage }
  | {
      ok: false;
      reason: 'not_a_deal' | 'schema_invalid' | 'api_error' | 'low_confidence';
      detail: string;
      candidate?: unknown;
      usage: ExtractionUsage;
    };

const EMPTY_USAGE: ExtractionUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

export class DealExtractor {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly threshold: number;
  private readonly effort: NonNullable<ExtractorOptions['effort']>;
  private readonly log: (message: string) => void;

  constructor(options: ExtractorOptions = {}) {
    // 키는 환경변수에서만 읽습니다. 소스에 하드코딩하지 않습니다.
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? DEFAULT_MODEL;
    this.threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.effort = options.effort ?? 'high';
    this.log = options.log ?? (() => {});
  }

  async extract(item: RawItem, now: Date): Promise<ExtractOutcome> {
    let response;

    try {
      response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        // 시스템 프롬프트는 매 요청 동일 → 캐시 히트
        system: [
          {
            type: 'text',
            text: EXTRACTION_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        // 애매한 한국어 프로모션 문구에서 조건·기간을 읽어내는 일은 단순 분류가 아닙니다.
        thinking: { type: 'adaptive' },
        output_config: {
          effort: this.effort,
          format: zodOutputFormat(extractedDealSchema),
        },
        messages: [
          {
            role: 'user',
            content: buildExtractionUserMessage(item, toReferenceDate(now)),
          },
        ],
      });
    } catch (error) {
      // zodOutputFormat 의 클라이언트 측 제약 위반도 여기로 옵니다.
      // 던지게 두면 한 건의 문제로 실행 전체가 죽고 사용량 집계도 사라집니다.
      return {
        ok: false,
        reason: 'api_error',
        detail: describeApiError(error),
        usage: EMPTY_USAGE,
      };
    }

    const usage: ExtractionUsage = {
      // 응답 형태가 예상과 달라도 사용량 집계는 잃지 않습니다.
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cachedInputTokens: response.usage?.cache_read_input_tokens ?? 0,
    };

    // 안전 분류기가 거절한 경우 content 를 읽기 전에 걸러야 합니다.
    if (response.stop_reason === 'refusal') {
      return {
        ok: false,
        reason: 'api_error',
        detail: `모델이 응답을 거절했습니다 (${response.stop_details?.category ?? 'unknown'})`,
        usage,
      };
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      return {
        ok: false,
        reason: 'schema_invalid',
        detail: '스키마에 맞는 결과를 얻지 못했습니다.',
        usage,
      };
    }

    if (!parsed.isDeal) {
      return {
        ok: false,
        reason: 'not_a_deal',
        detail: parsed.notes || '혜택 정보가 아니라고 판단했습니다.',
        candidate: parsed,
        usage,
      };
    }

    if (parsed.confidence < this.threshold) {
      return {
        ok: false,
        reason: 'low_confidence',
        detail: `신뢰도 ${parsed.confidence.toFixed(2)} < 임계값 ${this.threshold}: ${parsed.notes}`,
        candidate: parsed,
        usage,
      };
    }

    this.log(`추출 성공 (신뢰도 ${parsed.confidence.toFixed(2)}): ${parsed.title}`);
    return { ok: true, value: parsed, usage };
  }
}

/** SDK 예외를 사람이 읽을 수 있는 문자열로. 좁은 것부터 확인합니다. */
export function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'ANTHROPIC_API_KEY 가 없거나 유효하지 않습니다.';
  }
  if (error instanceof Anthropic.RateLimitError) {
    return '요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.';
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `요청이 거부되었습니다: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return `API 연결 실패: ${error.message}`;
  }
  if (error instanceof Anthropic.APIError) {
    return `API 오류 ${error.status}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
