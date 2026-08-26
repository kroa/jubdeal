import type { ReactNode } from 'react';
import type { DealDifficulty, DealStatus, DealType, DecoratedDeal } from '@/types/deal';
import { DEAL_TYPE_LABELS, DIFFICULTY_LABELS, STATUS_LABELS } from '@/types/deal';
import { formatDeadline, statusVariant } from '@/lib/format';

export type BadgeVariant =
  'danger' | 'success' | 'warning' | 'info' | 'muted' | 'brand' | 'outline';

interface BadgeProps {
  variant?: BadgeVariant;
  /** 좌측에 깜박이는 점 표시 (실시간 진행중 표현) */
  pulse?: boolean;
  children: ReactNode;
  /**
   * 스크린리더 전용 **접두** 설명. 보이는 문구 앞에 읽힙니다.
   * (뒤에 전체 문장을 덧붙이면 "쉬움 참여 난이도 쉬움" 처럼 중복 낭독됩니다.)
   */
  srPrefix?: string;
}

/** 뱃지 기본 요소 */
export function Badge({ variant = 'muted', pulse = false, children, srPrefix }: BadgeProps) {
  return (
    <span className={`badge badge--${variant}`}>
      {pulse && <span className="badge__dot" aria-hidden="true" />}
      {srPrefix && <span className="sr-only">{srPrefix} </span>}
      {children}
    </span>
  );
}

/** 진행 상태 뱃지 — 진행중 / 오늘마감 / 오픈예정 / 소진 / 종료 */
export function DealStatusBadge({ status }: { status: DealStatus }) {
  const isLive = status === 'ongoing' || status === 'ending_today';

  return (
    <Badge variant={statusVariant(status) as BadgeVariant} pulse={isLive} srPrefix="진행 상태">
      {STATUS_LABELS[status]}
    </Badge>
  );
}

/** 마감 임박 뱃지 — "오늘 마감", "D-2", "8월 25일 오픈" 등 */
/**
 * 마감 배지가 상태 배지와 같은 말을 하는 상태들.
 *
 * 상태 배지는 이미 "오늘마감 / 종료 / 소진"을 보여줍니다.
 * 그 옆에 마감 배지가 "오늘 마감 / 종료됨 / 소진됨"을 또 붙이면
 * 같은 사실이 두 번 적힌 카드가 됩니다.
 * 남은 일수나 마감일 미상처럼 **상태 배지가 말해 주지 않는 것**이 있을 때만 붙입니다.
 */
const DEADLINE_SAID_BY_STATUS: ReadonlySet<DealStatus> = new Set([
  'ending_today',
  'ended',
  'sold_out',
]);

export function DeadlineBadge({
  deal,
}: {
  deal: Pick<DecoratedDeal, 'daysLeft' | 'status' | 'isUrgent' | 'period'>;
}) {
  if (DEADLINE_SAID_BY_STATUS.has(deal.status)) return null;

  const text = formatDeadline(deal);

  return (
    <Badge variant={deal.isUrgent ? 'danger' : 'outline'} srPrefix="마감">
      {deal.isUrgent && <span aria-hidden="true">🔥</span>}
      {text}
    </Badge>
  );
}

/** 혜택 유형 뱃지 — 무료 / 100원딜 / 할인 ... */
export function DealTypeBadge({ dealType }: { dealType: DealType }) {
  const highlight = dealType === 'free' || dealType === 'penny';

  return (
    <Badge variant={highlight ? 'brand' : 'outline'} srPrefix="혜택 유형">
      {DEAL_TYPE_LABELS[dealType]}
    </Badge>
  );
}

const DIFFICULTY_VARIANT: Record<DealDifficulty, BadgeVariant> = {
  easy: 'success',
  normal: 'info',
  hard: 'warning',
};

/** 참여 난이도 뱃지 */
export function DifficultyBadge({ difficulty }: { difficulty: DealDifficulty }) {
  return (
    <Badge variant={DIFFICULTY_VARIANT[difficulty]} srPrefix="참여 난이도">
      {DIFFICULTY_LABELS[difficulty]}
    </Badge>
  );
}

/** 선착순 뱃지 */
export function FirstComeBadge() {
  return <Badge variant="warning">선착순</Badge>;
}
