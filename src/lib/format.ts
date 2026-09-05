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
  deal: Pick<DecoratedDeal, 'daysLeft' | 'status'> & {
    period?: { startAt: string; deadlineUnknown?: boolean };
  },
): string {
  if (deal.status === 'ended') return '종료됨';
  if (deal.status === 'sold_out') return '소진됨';

  if (deal.status === 'upcoming') {
    const openDay = deal.period ? formatKstMonthDay(deal.period.startAt) : '';
    return openDay ? `${openDay} 오픈` : '오픈 예정';
  }

  // 상시 진행과 "마감일을 모름"은 다릅니다. 모르는 것을 상시라고 하면 거짓말이 됩니다.
  if (deal.period?.deadlineUnknown) return '마감일 미상';
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

/**
 * 혜택 금액을 한국식으로 짧게 적습니다.
 *
 * 870000 을 "870,000원"으로 쓰면 카드에서 자리를 많이 먹고 한눈에 안 들어옵니다.
 * "87만원"이 한국어 사용자에게 훨씬 빠르게 읽힙니다.
 */
export function formatBenefitAmount(amount: number): string {
  if (amount >= 100_000_000) {
    const eok = amount / 100_000_000;
    return `${floorToTenth(eok)}억원`;
  }
  if (amount >= 10_000) {
    const man = amount / 10_000;
    return `${floorToTenth(man)}만원`;
  }
  return `${amount.toLocaleString('ko-KR')}원`;
}

/**
 * 소수점 첫째 자리에서 **내립니다**. 1.0 → "1", 1.97 → "1.9"
 *
 * 반올림하면 안 됩니다. 19,790원이 "2만원"이 되어 실제보다 크게 보입니다.
 * 혜택 금액은 사용자가 받을 것을 약속하는 값이라, 어긋난다면
 * 적게 적힌 쪽이어야 합니다.
 */
function floorToTenth(value: number): string {
  return (Math.floor(value * 10) / 10).toLocaleString('ko-KR');
}

/**
 * "18만원" / "최대 87만원" / "3만원"
 *
 * 기본 금액을 아는 상한이면 **기본을 앞세웁니다.**
 * "최대 85만원"만 보여주면 카드 5종을 전부 발급해야 나오는 숫자를
 * 손에 들어올 값처럼 약속하게 됩니다. 상한은 부연으로 밀어 둡니다.
 */
export function formatBenefit(benefit: {
  amount: number;
  isMax: boolean;
  baseAmount?: number;
}): string {
  if (benefit.isMax && benefit.baseAmount !== undefined) {
    return formatBenefitAmount(benefit.baseAmount);
  }

  const amount = formatBenefitAmount(benefit.amount);
  // "최대"를 빠뜨리면 조건부 상한을 확정 금액처럼 약속하게 됩니다.
  return benefit.isMax ? `최대 ${amount}` : amount;
}

/** 기본 금액을 앞세운 경우의 부연. 없으면 빈 문자열. */
export function formatBenefitCeiling(benefit: {
  amount: number;
  isMax: boolean;
  baseAmount?: number;
}): string {
  if (!benefit.isMax || benefit.baseAmount === undefined) return '';
  return `조건 다 채우면 최대 ${formatBenefitAmount(benefit.amount)}`;
}
