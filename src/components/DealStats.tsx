import { useMemo } from 'react';
import type { DealPulse } from '@/lib/deal-status';
import { summarizeDeals } from '@/lib/deal-status';
import { useLiveNow } from '@/hooks/use-live-now';

interface DealStatsProps {
  /**
   * 통계 계산에 필요한 최소 필드만 받습니다.
   * 혜택 전체를 넘기면 목록 아일랜드와 데이터가 중복 직렬화되어 페이지 용량이 두 배가 됩니다.
   * (`deal-status.ts` 의 `toPulse()` 로 만듭니다.)
   */
  pulses: DealPulse[];
  /** 빌드 시각 ISO 문자열 (서버 렌더 결과와 첫 렌더를 맞추기 위한 시드) */
  buildTime: string;
}

/**
 * 히어로 통계 (React 아일랜드)
 *
 * 이 값들을 Astro 에서 빌드 타임에 계산하면, 바로 아래 목록(DealBoard)은
 * 현재 시각으로 재계산되는데 통계만 옛 숫자로 남아 같은 화면에서 서로 모순됩니다.
 * `useLiveNow` 를 DealBoard 와 공유해 두 영역이 같은 시계를 보게 합니다.
 */
export function DealStats({ pulses, buildTime }: DealStatsProps) {
  const now = useLiveNow(buildTime);
  const summary = useMemo(() => summarizeDeals(pulses, now), [pulses, now]);

  return (
    <div className="hero__stats" data-testid="hero-stats">
      <Stat value={summary.live} label="지금 참여 가능" testId="stat-live" />
      <Stat value={summary.urgent} label="마감 임박" testId="stat-urgent" />
      <Stat value={summary.free} label="완전 무료" testId="stat-free" />
    </div>
  );
}

function Stat({ value, label, testId }: { value: number; label: string; testId: string }) {
  return (
    <div className="stat" data-testid={testId}>
      <p className="stat__value">{value}</p>
      <p className="stat__label">{label}</p>
    </div>
  );
}

export default DealStats;
