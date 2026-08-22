/**
 * 줍딜(JubDeal) 핵심 도메인 타입
 * ---------------------------------------------------------------------------
 * 이 파일은 "혜택 1건"을 표현하는 단일 진실 공급원(Single Source of Truth)입니다.
 *
 * 확장 설계 의도:
 *  - 현재는 `src/data/deals.json` 을 수동 큐레이션하지만,
 *    추후 자동 크롤러 → LLM 정규화 파이프라인이 생성하는 JSON도
 *    동일한 `Deal` 형태를 따르도록 강제합니다.
 *  - 런타임 검증은 `src/lib/deal-schema.ts` 의 zod 스키마가 담당하며,
 *    이 파일의 타입과 항상 1:1로 대응합니다.
 *  - `source` 필드에 수집 출처/방식/신뢰도를 기록해, 사람이 넣은 데이터와
 *    자동 수집 데이터를 구분하고 검수 워크플로를 붙일 수 있게 했습니다.
 */

/** 스키마 버전. 파이프라인이 하위호환을 판단하는 데 사용합니다. */
export const DEAL_SCHEMA_VERSION = 1 as const;

/* -------------------------------------------------------------------------- */
/* 열거형(Enum) — 값과 라벨을 한곳에서 관리                                     */
/* -------------------------------------------------------------------------- */

/** 혜택 카테고리 */
export const DEAL_CATEGORIES = [
  'food',
  'cafe',
  'convenience',
  'shopping',
  'beauty',
  'culture',
  'finance',
  'app',
  'etc',
] as const;
export type DealCategory = (typeof DEAL_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<DealCategory, string> = {
  food: '식음료',
  cafe: '카페',
  convenience: '편의점',
  shopping: '쇼핑',
  beauty: '뷰티',
  culture: '문화·여가',
  finance: '금융·포인트',
  app: '앱테크',
  etc: '기타',
};

export const CATEGORY_EMOJI: Record<DealCategory, string> = {
  food: '🍚',
  cafe: '☕',
  convenience: '🏪',
  shopping: '🛍️',
  beauty: '💄',
  culture: '🎬',
  finance: '💳',
  app: '📱',
  etc: '✨',
};

/** 혜택 유형 */
export const DEAL_TYPES = [
  'free', // 완전 무료 증정
  'penny', // 100원 딜 등 초저가
  'discount', // 할인
  'coupon', // 쿠폰
  'cashback', // 캐시백/페이백
  'point', // 포인트 적립
  'giveaway', // 응모/추첨 경품
] as const;
export type DealType = (typeof DEAL_TYPES)[number];

export const DEAL_TYPE_LABELS: Record<DealType, string> = {
  free: '무료',
  penny: '100원딜',
  discount: '할인',
  coupon: '쿠폰',
  cashback: '캐시백',
  point: '포인트',
  giveaway: '응모',
};

/** 참여 난이도 — "얼마나 귀찮은가" */
export const DEAL_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type DealDifficulty = (typeof DEAL_DIFFICULTIES)[number];

export const DIFFICULTY_LABELS: Record<DealDifficulty, string> = {
  easy: '쉬움',
  normal: '보통',
  hard: '고수용',
};

export const DIFFICULTY_DESCRIPTIONS: Record<DealDifficulty, string> = {
  easy: '클릭 몇 번이면 끝',
  normal: '앱 설치·간단 인증 필요',
  hard: '조건 달성·여러 단계 필요',
};

/** 계산으로 도출되는 실시간 진행 상태 (데이터에 저장하지 않음) */
export const DEAL_STATUSES = [
  'upcoming', // 시작 전
  'ongoing', // 진행중
  'ending_today', // 오늘 마감
  'ended', // 종료됨
  'sold_out', // 소진됨
] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const STATUS_LABELS: Record<DealStatus, string> = {
  upcoming: '오픈예정',
  ongoing: '진행중',
  ending_today: '오늘마감',
  ended: '종료',
  sold_out: '소진',
};

/** 데이터 수집 방식 */
export const SOURCE_METHODS = ['manual', 'crawler', 'llm'] as const;
export type SourceMethod = (typeof SOURCE_METHODS)[number];

/* -------------------------------------------------------------------------- */
/* 엔티티                                                                      */
/* -------------------------------------------------------------------------- */

/** 브랜드/제공처 */
export interface DealBrand {
  /** 표기명 (예: "스타벅스") */
  name: string;
  /** 로고 이미지 URL (선택) */
  logoUrl?: string;
}

/** 가격 정보. 통화는 현재 KRW만 사용합니다. */
export interface DealPrice {
  /** 정가 (없을 수 있음 — 예: 순수 응모 이벤트) */
  original?: number;
  /** 실제 지불 금액. 무료면 0 */
  final: number;
  currency: 'KRW';
  /**
   * 할인율(0~100). 생략 시 original/final 로부터 계산됩니다.
   * `src/lib/deal-status.ts` 의 `getDiscountRate()` 참고.
   */
  discountRate?: number;
}

/** 수량 제한 / 선착순 정보 */
export interface DealLimit {
  /** 선착순 여부 */
  firstComeFirstServed: boolean;
  /** 총 수량 (알 수 없으면 생략) */
  quantity?: number;
  /** 남은 수량 (알 수 없으면 생략, 0이면 소진) */
  remaining?: number;
  /** 1인당 참여 제한 횟수 */
  perPersonLimit?: number;
}

/** 진행 기간. ISO 8601 문자열(타임존 오프셋 포함 권장). */
export interface DealPeriod {
  /** 시작 시각 (ISO 8601) */
  startAt: string;
  /** 종료 시각 (ISO 8601). `null`이면 상시/무기한 */
  endAt: string | null;
}

/** 랜딩 링크 */
export interface DealLink {
  url: string;
  /** 버튼에 표시할 문구 (기본값: "혜택 받으러 가기") */
  label?: string;
  /** 제휴 링크 여부 — 표기 의무 대응 */
  affiliate?: boolean;
}

/** 수집 출처 메타데이터 (크롤러/LLM 파이프라인용) */
export interface DealSource {
  /** 출처명 (예: "브랜드 공식 앱", "커뮤니티 X") */
  name: string;
  /** 원문 URL */
  url?: string;
  /** 수집 시각 (ISO 8601) */
  collectedAt: string;
  /** 수집 방식 */
  method: SourceMethod;
  /**
   * LLM 추출 신뢰도 (0~1). `method: 'llm'` 일 때 채워지며,
   * 임계값 미만이면 사람 검수 큐로 보내는 용도로 사용합니다.
   */
  confidence?: number;
}

/** 운영 메타데이터 */
export interface DealMeta {
  /** 메인 상단 고정 노출 */
  featured?: boolean;
  /** 사람이 링크/조건을 실제 확인했는지 여부 */
  verified: boolean;
  /** 마지막 갱신 시각 (ISO 8601) */
  updatedAt: string;
}

/**
 * 혜택 1건.
 * 크롤러/LLM 파이프라인이 출력해야 하는 최종 정규화 형태입니다.
 */
export interface Deal {
  /** 안정적 고유 ID (재수집해도 유지) */
  id: string;
  /** URL 슬러그 (a-z, 0-9, - 만 허용) */
  slug: string;
  /** 제목 */
  title: string;
  /** 카드에 노출되는 한 줄 요약 */
  summary: string;
  /** 상세 설명 (선택) */
  description?: string;
  brand: DealBrand;
  category: DealCategory;
  dealType: DealType;
  difficulty: DealDifficulty;
  price: DealPrice;
  limit: DealLimit;
  period: DealPeriod;
  link: DealLink;
  /** 참여 방법 단계별 안내 */
  howTo?: string[];
  /** 주의사항 */
  caution?: string[];
  /** 검색/필터 보조용 태그 */
  tags: string[];
  source: DealSource;
  meta: DealMeta;
}

/**
 * 화면 렌더링용 파생 필드가 붙은 Deal.
 * `src/lib/deal-status.ts` 의 `decorateDeal()` 이 생성합니다.
 */
export interface DecoratedDeal extends Deal {
  status: DealStatus;
  /** 마감까지 남은 일수. 상시 혜택이면 null */
  daysLeft: number | null;
  /** 마감 임박(3일 이하) 여부 */
  isUrgent: boolean;
  /** 계산된 할인율(0~100). 산출 불가하면 null */
  discountRate: number | null;
  /** 현재 참여 가능한지 여부 */
  isActionable: boolean;
}

/** deals.json 파일의 최상위 형태 */
export interface DealsFile {
  schemaVersion: number;
  /** 데이터셋 갱신 시각 (ISO 8601) */
  generatedAt: string;
  deals: Deal[];
}
