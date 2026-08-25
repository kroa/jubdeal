import type { Deal } from '@/types/deal';

/**
 * 크롤러 → LLM 정규화 파이프라인 타입
 * ---------------------------------------------------------------------------
 * 흐름:
 *   1. 수집(collect)   : 소스에서 원문 조각을 긁어 RawItem[] 으로
 *   2. 추출(extract)   : LLM 이 RawItem → ExtractedDeal (스키마 강제)
 *   3. 조립(assemble)  : 파이프라인이 id/slug/타임스탬프를 붙여 Deal 완성
 *   4. 병합(merge)     : 기존 deals.json 과 합치고, 저신뢰 건은 검수 큐로
 *
 * LLM 이 만드는 것과 파이프라인이 만드는 것을 분리한 이유:
 * id·slug·수집시각·검수여부는 모델이 알 수 없는 값입니다.
 * 모델에게 맡기면 매 실행마다 id 가 바뀌어 중복이 쌓입니다.
 */

/** 소스에서 긁어온 원문 한 조각 (LLM 입력) */
export interface RawItem {
  /** 이 조각을 만들어 낸 소스 ID (sources 설정의 키) */
  sourceId: string;
  /** 소스 표시명 */
  sourceName: string;
  /** 원문 URL */
  url: string;
  /** 목록에서 뽑은 제목 (있으면 LLM 에 힌트로 제공) */
  title?: string;
  /** 본문 텍스트 (HTML 태그 제거 후) */
  text: string;
  /** 수집 시각 (ISO 8601, 오프셋 포함) */
  collectedAt: string;
}

/** 소스 어댑터가 구현해야 하는 인터페이스 */
export interface SourceAdapter {
  /** 어댑터 종류 식별자 */
  readonly kind: string;
  /** 소스 설정을 받아 RawItem 목록을 만듭니다. */
  collect(source: SourceConfig, ctx: CollectContext): Promise<RawItem[]>;
}

export interface CollectContext {
  /** 예의 있는 fetch (robots.txt·레이트리밋·타임아웃 적용) */
  fetchText: (url: string) => Promise<string>;
  /** 기준 시각 (테스트 결정성을 위해 주입) */
  now: Date;
  log: (message: string) => void;
}

/** sources 설정 파일의 항목 하나 */
export interface SourceConfig {
  /** 고유 ID (id 생성에 쓰이므로 바꾸지 마세요) */
  id: string;
  /** 표시명 — Deal.source.name 이 됩니다 */
  name: string;
  /** 어댑터 종류: html | rss | fixture */
  kind: string;
  /** 목록 페이지 URL (fixture 는 로컬 경로) */
  url: string;
  /** 이 소스를 수집할지 여부 */
  enabled: boolean;
  /**
   * 한 번 실행에서 이 소스로부터 가져올 최대 항목 수.
   * 예의 있는 수집과 비용 통제를 위해 반드시 상한을 둡니다.
   */
  maxItems: number;
  /** html 어댑터용 CSS 선택자 */
  selectors?: {
    /** 목록에서 각 항목을 고르는 선택자 */
    item: string;
    /** 항목 안에서 상세 링크를 고르는 선택자 (생략 시 item 자체가 <a>) */
    link?: string;
    /** 항목 안에서 제목을 고르는 선택자 */
    title?: string;
    /** 상세 페이지에서 본문을 고르는 선택자 (생략 시 <body> 전체) */
    detail?: string;
  };
  /** 이 소스가 주로 다루는 카테고리 힌트 (LLM 에 전달) */
  categoryHint?: string;
}

export interface SourcesFile {
  /** 수집 시 사용할 User-Agent. 연락처를 포함하는 것이 관례입니다. */
  userAgent: string;
  /** 같은 호스트에 대한 요청 간 최소 간격(ms) */
  requestIntervalMs: number;
  /** 요청 타임아웃(ms) */
  timeoutMs: number;
  sources: SourceConfig[];
}

/** LLM 추출 실패 사유 */
export type ExtractionFailureReason =
  | 'not_a_deal' // 혜택 정보가 아님
  | 'schema_invalid' // 스키마 위반
  | 'api_error' // API 호출 실패
  | 'low_confidence'; // 신뢰도 미달

/** 추출 결과 (성공/실패 판별 유니온) */
export type ExtractionResult =
  | { ok: true; deal: Deal; confidence: number; raw: RawItem }
  | { ok: false; reason: ExtractionFailureReason; detail: string; raw: RawItem };

/** 사람 검수가 필요한 항목 */
export interface ReviewItem {
  reason: ExtractionFailureReason;
  detail: string;
  sourceId: string;
  url: string;
  title?: string;
  /** 스키마를 통과하지 못했더라도 모델이 만든 결과를 남겨 검수를 돕습니다. */
  candidate?: unknown;
  collectedAt: string;
}

/** 한 번의 파이프라인 실행 결과 요약 */
export interface PipelineReport {
  startedAt: string;
  finishedAt: string;
  /** 실제로 수집을 시도한 소스 수 */
  sourcesRun: number;
  collected: number;
  extracted: number;
  rejected: number;
  /** 기존 목록에 새로 추가된 건수 */
  added: number;
  /** 기존 항목이 갱신된 건수 */
  updated: number;
  /** 변화 없이 유지된 건수 */
  unchanged: number;
  reviewQueued: number;
  /** 추정 토큰 사용량 */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    /**
     * 프로바이더가 알려준 실제 비용 합계(USD).
     * 무료 모델이면 0 입니다. 아무도 알려주지 않았으면 null.
     */
    costUsd: number | null;
  };
  /** 소스별 오류 (수집 자체가 실패한 경우) */
  errors: Array<{ sourceId: string; message: string }>;
}
