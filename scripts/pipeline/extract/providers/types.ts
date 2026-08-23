/**
 * LLM 프로바이더 추상화
 * ---------------------------------------------------------------------------
 * 이 프로젝트는 Anthropic API 를 **직접 호출하지 않습니다.**
 * 대신 두 경로를 씁니다:
 *
 *   1. claude-cli  — VSCode 에 연결된 Claude Code 바이너리 (구독 인증)
 *   2. openrouter  — 1번이 요금제 한도 등으로 막혔을 때의 폴백
 *
 * 두 경로 모두 "시스템 프롬프트 + 사용자 메시지 + JSON 스키마 → JSON" 이라는
 * 같은 계약만 지키면 되므로, 추출 로직은 어느 쪽을 쓰는지 몰라도 됩니다.
 */

export interface LlmRequest {
  /** 요청마다 동일해야 캐시가 걸립니다. */
  system: string;
  user: string;
  /** 응답을 강제할 JSON Schema */
  jsonSchema: Record<string, unknown>;
  /** 응답 스키마의 이름 (일부 프로바이더가 요구) */
  schemaName: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** 프로바이더가 알려주는 실제 비용(USD). 모르면 null */
  costUsd: number | null;
}

export interface LlmResponse {
  /** 스키마에 맞는 JSON (아직 zod 검증 전) */
  data: unknown;
  usage: LlmUsage;
  /** 실제로 응답한 프로바이더 이름 (보고용) */
  provider: string;
}

export interface LlmProvider {
  readonly name: string;
  /** 이 프로바이더를 쓸 수 있는 상태인지 (설정·바이너리 존재 등) */
  isConfigured(): Promise<boolean>;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/**
 * "이 프로바이더로는 못 한다"는 신호.
 * 요금제 한도, 인증 실패, 바이너리 없음 등 **다음 프로바이더로 넘어가야 하는** 경우에만 씁니다.
 *
 * 스키마 위반이나 잘못된 입력처럼 프로바이더를 바꿔도 똑같이 실패할 오류에는
 * 쓰지 않습니다. 그런 것까지 폴백하면 같은 실패를 두 번 하며 비용만 두 배가 됩니다.
 */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: string,
    readonly reason: 'not_configured' | 'quota' | 'auth' | 'unavailable',
    message: string,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderUnavailableError';
  }
}

/** 프로바이더는 살아 있는데 이번 요청이 실패한 경우 (폴백하지 않음) */
export class LlmRequestError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'LlmRequestError';
  }
}

/** 요금제·한도 관련 메시지인지 판단합니다 (프로바이더 공통 휴리스틱). */
export function looksLikeQuotaError(text: string): boolean {
  return /rate.?limit|usage limit|quota|too many requests|insufficient|credit|billing|upgrade your plan|out of (credits?|tokens?)|429/i.test(
    text,
  );
}

/** 인증 관련 메시지인지 */
export function looksLikeAuthError(text: string): boolean {
  return /unauthor|forbidden|invalid.{0,10}(api )?key|not logged in|authentication|401|403/i.test(
    text,
  );
}

export const EMPTY_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  costUsd: null,
};
