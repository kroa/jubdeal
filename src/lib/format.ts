import type { DealStatus, DecoratedDeal } from '@/types/deal';

/**
 * 표시용 포맷터 (순수 함수)
 * 모든 출력은 한국어 · KST 기준입니다.
 */

/** 1900 → "1,900원", 0 → "무료" */
export function formatPrice(won: number): string {
  if (won === 0) return '무료';
  return `${won.toLocaleString('ko-KR')}원`;
}

/**
 * 가격 블록을 표시할 가치가 있는지 판단합니다.
 *
 * 캐시백·포인트 적립 혜택은 지불액이 0이지만 "무료로 무언가를 받는" 것이 아닙니다.
 * 그런 혜택에 "무료" 라고 크게 띄우면 성격을 오해하게 만들므로,
 * 정가가 있거나 실제 지불액이 있거나 무료·100원딜인 경우에만 가격을 노출합니다.
 */
export function hasMeaningfulPrice(deal: Pick<DecoratedDeal, 'price' | 'dealType'>): boolean {
  if (typeof deal.price.original === 'number') return true;
  if (deal.price.final > 0) return true;

  return deal.dealType === 'free' || deal.dealType === 'penny';
}

/** 45 → "45%", null → "" */
export function formatDiscountRate(rate: number | null): string {
  if (rate === null || rate <= 0) return '';
  return `${rate}%`;
}

/** ISO 문자열 → "8월 20일 (목)" (KST 기준) */
export function formatKstDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(date);
}

/** ISO 문자열 → "8월 25일" (KST 기준, 뱃지처럼 짧은 자리용) */
export function formatKstMonthDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

/** ISO 문자열 → "8월 20일 23:59" (KST 기준) */
export function formatKstDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * 마감 문구를 만듭니다.
 *   종료        → "종료됨"
 *   소진        → "소진됨"
 *   오픈 예정   → "8월 25일 오픈" (시작일을 모르면 "오픈 예정")
 *   상시 진행   → "상시 진행"
 *   오늘 마감   → "오늘 마감"
 *   내일 마감   → "내일 마감"
 *   그 외       → "D-5"
 *
 * `upcoming` 을 마감 문구보다 먼저 처리합니다. 그러지 않으면 아직 시작도 안 한
 * 혜택에 "오늘 마감"/"D-14" 가 붙어 사용자를 오도합니다.
 */
export function formatDeadline(
  deal: Pick<DecoratedDeal, 'daysLeft' | 'status'> & { period?: { startAt: string } },
): string {
  if (deal.status === 'ended') return '종료됨';
  if (deal.status === 'sold_out') return '소진됨';

  if (deal.status === 'upcoming') {
    const openDay = deal.period ? formatKstMonthDay(deal.period.startAt) : '';
    return openDay ? `${openDay} 오픈` : '오픈 예정';
  }

  if (deal.daysLeft === null) return '상시 진행';
  if (deal.daysLeft <= 0) return '오늘 마감';
  if (deal.daysLeft === 1) return '내일 마감';

  return `D-${deal.daysLeft}`;
}

/** 상태 뱃지에 사용할 CSS 클래스 접미사 */
export function statusVariant(status: DealStatus): string {
  switch (status) {
    case 'ending_today':
      return 'danger';
    case 'ongoing':
      return 'success';
    case 'upcoming':
      return 'info';
    case 'sold_out':
    case 'ended':
    default:
      return 'muted';
  }
}

/** "3,120" 처럼 천 단위 구분 */
export function formatCount(value: number): string {
  return value.toLocaleString('ko-KR');
}
