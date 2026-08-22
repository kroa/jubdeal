import { useEffect, useState } from 'react';

/** 시각 갱신 주기 (밀리초). 자정을 넘겨 "오늘 마감"이 바뀌는 것을 1분 내에 반영합니다. */
export const LIVE_NOW_INTERVAL_MS = 60_000;

/**
 * "지금 시각"을 살아있는 값으로 제공하는 훅.
 *
 * 정적 사이트라 HTML은 빌드 시각에 굳습니다. 그대로 두면 배포가 하루만 지나도
 * 마감 상태가 틀어지므로, 마운트 직후 실제 현재 시각으로 교체하고 주기적으로 갱신합니다.
 *
 * 첫 렌더를 반드시 `buildTime` 으로 시드하는 것이 핵심입니다.
 * 곧바로 `new Date()` 를 쓰면 서버가 만든 HTML과 클라이언트 첫 렌더가 달라져
 * React 하이드레이션 불일치가 발생합니다.
 *
 * 이 훅을 쓰는 아일랜드들은 모두 같은 시드·같은 주기를 공유하므로,
 * 히어로 통계와 목록처럼 화면에 함께 보이는 수치가 서로 어긋나지 않습니다.
 *
 * @param buildTime 빌드 시각 ISO 문자열 (서버 렌더 결과와 맞추기 위한 시드)
 */
export function useLiveNow(buildTime: string): Date {
  const [now, setNow] = useState<Date>(() => new Date(buildTime));

  useEffect(() => {
    setNow(new Date());

    const timer = setInterval(() => setNow(new Date()), LIVE_NOW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return now;
}
