import { useMemo } from 'react';
import type { Deal, DealLink, DealStatus, DealType } from '@/types/deal';
import type { DealTiming } from '@/lib/deal-status';
import {
  URGENT_THRESHOLD_DAYS,
  getDaysLeft,
  getDealStatus,
  isActionableStatus,
} from '@/lib/deal-status';
import { useLiveNow } from '@/hooks/use-live-now';
import { DeadlineBadge, DealStatusBadge, DealTypeBadge } from '@/components/Badge';

/**
 * 상세 페이지의 시간 의존 영역 (React 아일랜드)
 * ---------------------------------------------------------------------------
 * 상세 페이지는 `getStaticPaths()` 가 빌드 시각으로 상태를 계산해 HTML 에 굳힙니다.
 * 그대로 두면 재빌드 전까지 이미 끝난 혜택에 '진행중' 뱃지와 살아있는 CTA 가 남아,
 * 목록 화면과 정반대 상태를 말하게 됩니다.
 *
 * 뱃지와 CTA 는 페이지에서 서로 떨어진 위치에 있어 하나의 아일랜드로 묶을 수 없으므로
 * 각각 독립 아일랜드로 만듭니다. 둘 다 `useLiveNow(buildTime)` 를 쓰므로
 * 같은 시드·같은 주기를 공유해 서로 어긋나지 않습니다.
 *
 * 각 아일랜드에는 **필요한 최소 필드만** 넘깁니다.
 * 혜택 전체를 넘기면 같은 JSON 이 한 페이지에 두 번 직렬화됩니다.
 */

/** 뱃지 묶음이 필요로 하는 최소 정보 */
export interface DealBadgeInfo extends DealTiming {
  dealType: DealType;
  firstComeFirstServed: boolean;
}

/** CTA 가 필요로 하는 최소 정보 */
export interface DealCtaInfo extends DealTiming {
  link: DealLink;
}

/** 혜택에서 뱃지용 정보만 추려냅니다. */
export function toBadgeInfo(deal: Deal): DealBadgeInfo {
  return {
    dealType: deal.dealType,
    period: deal.period,
    limit: { remaining: deal.limit.remaining },
    firstComeFirstServed: deal.limit.firstComeFirstServed,
  };
}

/** 혜택에서 CTA용 정보만 추려냅니다. */
export function toCtaInfo(deal: Deal): DealCtaInfo {
  return {
    period: deal.period,
    limit: { remaining: deal.limit.remaining },
    link: deal.link,
  };
}

interface LiveStatus {
  status: DealStatus;
  daysLeft: number | null;
  isUrgent: boolean;
  isActionable: boolean;
}

function useLiveStatus(timing: DealTiming, buildTime: string): LiveStatus {
  const now = useLiveNow(buildTime);

  return useMemo(() => {
    const status = getDealStatus(timing, now);
    const daysLeft = getDaysLeft(timing, now);
    const isActionable = isActionableStatus(status);

    return {
      status,
      daysLeft,
      isActionable,
      isUrgent: isActionable && daysLeft !== null && daysLeft <= URGENT_THRESHOLD_DAYS,
    };
  }, [timing, now]);
}

/** 상세 페이지 상단의 상태·마감·유형 뱃지 묶음 */
export function DealDetailBadges({ info, buildTime }: { info: DealBadgeInfo; buildTime: string }) {
  const live = useLiveStatus(info, buildTime);

  return (
    <div className="detail__badges" data-testid="detail-badges">
      <DealStatusBadge status={live.status} />
      <DeadlineBadge deal={{ ...live, period: info.period }} />
      <DealTypeBadge dealType={info.dealType} />
      {info.firstComeFirstServed && <span className="badge badge--warning">선착순</span>}
    </div>
  );
}

/** 상세 페이지 하단의 참여 CTA */
export function DealDetailCta({ info, buildTime }: { info: DealCtaInfo; buildTime: string }) {
  const live = useLiveStatus(info, buildTime);

  if (!live.isActionable) {
    return (
      <button type="button" className="btn btn--block" disabled data-testid="detail-cta">
        {live.status === 'upcoming' ? '아직 오픈 전이에요' : '종료된 혜택이에요'}
      </button>
    );
  }

  return (
    <a
      className="btn btn--primary btn--block"
      href={info.link.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      data-testid="detail-cta"
    >
      {info.link.label ?? '혜택 받으러 가기'}
      <span className="sr-only">(새 창에서 열림)</span>
    </a>
  );
}
