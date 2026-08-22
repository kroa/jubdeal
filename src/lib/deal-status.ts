import type {
  Deal,
  DealPeriod,
  DealPrice,
  DealStatus,
  DealType,
  DecoratedDeal,
} from '@/types/deal';

/**
 * 혜택 상태 계산 로직 (순수 함수)
 * ---------------------------------------------------------------------------
 * 모든 함수가 현재 시각 `now` 를 인자로 받습니다.
 * → 전역 Date에 의존하지 않으므로 테스트가 100% 결정적입니다.
 *
 * 기준 타임존은 한국 표준시(KST, UTC+9)입니다.
 * KST는 서머타임이 없어 고정 오프셋 계산이 항상 정확합니다.
 */

/** KST 고정 오프셋 (밀리초) */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 마감 임박으로 간주할 잔여 일수 (이하) */
export const URGENT_THRESHOLD_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 주어진 시각이 속한 KST 달력 날짜를 'YYYY-MM-DD' 로 반환합니다.
 * 예: 2026-08-20T23:30:00Z → KST로는 2026-08-21 → '2026-08-21'
 */
export function toKstDayKey(input: Date | string | number): string {
  const shifted = new Date(toTime(input) + KST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 두 시각 사이의 KST 달력 일수 차이(to - from)를 반환합니다.
 * 같은 날이면 0, 다음 날이면 1, 어제면 -1.
 */
export function kstDayDiff(from: Date | string | number, to: Date | string | number): number {
  const fromDay = Math.floor((toTime(from) + KST_OFFSET_MS) / MS_PER_DAY);
  const toDay = Math.floor((toTime(to) + KST_OFFSET_MS) / MS_PER_DAY);
  return toDay - fromDay;
}

/**
 * 상태 계산에 **실제로 필요한 최소 필드**.
 *
 * `Deal` 과 `DecoratedDeal` 모두 구조적으로 이 형태를 만족하므로 그대로 넘길 수 있고,
 * 아일랜드로 직렬화할 때는 이만큼만 보내 페이지 용량을 줄일 수 있습니다.
 */
export interface DealTiming {
  period: DealPeriod;
  limit: { remaining?: number };
}

/** 요약 통계 계산에 필요한 최소 필드 */
export interface DealPulse extends DealTiming {
  dealType: DealType;
}

/**
 * 혜택에서 통계 계산에 필요한 부분만 추려냅니다.
 *
 * 히어로 통계 아일랜드에 혜택 전체를 넘기면 목록 아일랜드와 데이터가 중복 직렬화되어
 * 페이지 용량이 두 배가 됩니다. 필요한 필드만 보냅니다.
 */
export function toPulse(deal: Pick<Deal, 'dealType' | 'period' | 'limit'>): DealPulse {
  return {
    dealType: deal.dealType,
    period: deal.period,
    limit: { remaining: deal.limit.remaining },
  };
}

/**
 * 혜택의 실시간 진행 상태를 계산합니다.
 *
 * 우선순위:
 *   1. 종료 시각이 지났으면            → ended
 *   2. 남은 수량이 0이면               → sold_out
 *   3. 아직 시작 전이면                → upcoming
 *   4. 종료일이 오늘(KST)이면          → ending_today
 *   5. 그 외                           → ongoing
 */
export function getDealStatus(timing: DealTiming, now: Date): DealStatus {
  const nowMs = now.getTime();
  const { startAt, endAt } = timing.period;

  if (endAt !== null && nowMs >= Date.parse(endAt)) return 'ended';
  if (timing.limit.remaining === 0) return 'sold_out';
  if (nowMs < Date.parse(startAt)) return 'upcoming';
  if (endAt !== null && toKstDayKey(endAt) === toKstDayKey(now)) return 'ending_today';

  return 'ongoing';
}

/**
 * 마감까지 남은 KST 달력 일수.
 * 오늘 마감이면 0, 내일 마감이면 1. 상시 혜택(endAt === null)이면 null.
 */
export function getDaysLeft(timing: Pick<DealTiming, 'period'>, now: Date): number | null {
  if (timing.period.endAt === null) return null;
  return kstDayDiff(now, timing.period.endAt);
}

/**
 * 할인율(0~100, 정수)을 계산합니다.
 * 명시된 discountRate 가 있으면 그 값을 우선하고,
 * 없으면 정가/실지불액으로 계산합니다. 산출 불가하면 null.
 */
export function getDiscountRate(price: DealPrice): number | null {
  if (typeof price.discountRate === 'number') return Math.round(price.discountRate);
  if (typeof price.original !== 'number' || price.original <= 0) return null;

  const rate = ((price.original - price.final) / price.original) * 100;
  return Math.round(rate);
}

/** 지금 참여할 수 있는 상태인지 */
export function isActionableStatus(status: DealStatus): boolean {
  return status === 'ongoing' || status === 'ending_today';
}

/** 선착순 잔여 비율(0~1). 수량 정보가 없으면 null. */
export function getRemainingRatio(deal: Deal): number | null {
  const { quantity, remaining } = deal.limit;
  if (typeof quantity !== 'number' || quantity <= 0 || typeof remaining !== 'number') return null;
  return Math.max(0, Math.min(1, remaining / quantity));
}

/** 원본 Deal에 화면용 파생 필드를 붙입니다. */
export function decorateDeal(deal: Deal, now: Date): DecoratedDeal {
  const status = getDealStatus(deal, now);
  const daysLeft = getDaysLeft(deal, now);

  return {
    ...deal,
    status,
    daysLeft,
    isUrgent: isActionableStatus(status) && daysLeft !== null && daysLeft <= URGENT_THRESHOLD_DAYS,
    discountRate: getDiscountRate(deal.price),
    isActionable: isActionableStatus(status),
  };
}

export function decorateDeals(deals: Deal[], now: Date): DecoratedDeal[] {
  return deals.map((deal) => decorateDeal(deal, now));
}

/** 히어로 통계 등에서 쓰는 요약 수치 */
export interface DealSummary {
  /** 지금 참여 가능한 건수 */
  live: number;
  /** 마감 임박 건수 */
  urgent: number;
  /** 완전 무료 건수 */
  free: number;
}

/**
 * 목록 요약 수치를 계산합니다.
 *
 * 히어로 통계와 목록이 서로 다른 조건식을 복붙해 쓰면 시간이 지나면서 갈라집니다.
 * 한 곳에서만 정의하고 양쪽이 같은 함수를 호출하도록 합니다.
 *
 * `free` 는 `price.final === 0` 이 아니라 `dealType === 'free'` 로 셉니다.
 * 캐시백·포인트·응모 혜택도 지불액이 0이라, 금액으로 세면 "완전 무료" 수치가 부풀려집니다.
 */
export function summarizeDeals(deals: DealPulse[], now: Date): DealSummary {
  let live = 0;
  let urgent = 0;
  let free = 0;

  for (const deal of deals) {
    const status = getDealStatus(deal, now);
    if (!isActionableStatus(status)) continue;

    const daysLeft = getDaysLeft(deal, now);

    live += 1;
    if (daysLeft !== null && daysLeft <= URGENT_THRESHOLD_DAYS) urgent += 1;
    if (deal.dealType === 'free') free += 1;
  }

  return { live, urgent, free };
}

/** 목록 정렬 시 상태별 우선순위 (작을수록 위) */
const STATUS_ORDER: Record<DealStatus, number> = {
  ending_today: 0,
  ongoing: 1,
  upcoming: 2,
  sold_out: 3,
  ended: 4,
};

/**
 * 기본 정렬:
 *   1. 참여 가능한 것 우선 (오늘마감 → 진행중 → 오픈예정 → 소진 → 종료)
 *   2. 같은 상태면 featured 우선
 *   3. 마감 임박 순 (남은 일수 적은 순, 상시는 뒤로)
 *   4. 최근 갱신 순
 *
 * 원본 배열을 변경하지 않습니다.
 */
export function sortDeals(deals: DecoratedDeal[]): DecoratedDeal[] {
  return [...deals].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;

    const byFeatured = Number(b.meta.featured ?? false) - Number(a.meta.featured ?? false);
    if (byFeatured !== 0) return byFeatured;

    const byDeadline =
      (a.daysLeft ?? Number.MAX_SAFE_INTEGER) - (b.daysLeft ?? Number.MAX_SAFE_INTEGER);
    if (byDeadline !== 0) return byDeadline;

    return Date.parse(b.meta.updatedAt) - Date.parse(a.meta.updatedAt);
  });
}

function toTime(input: Date | string | number): number {
  if (input instanceof Date) return input.getTime();
  if (typeof input === 'number') return input;
  return Date.parse(input);
}
