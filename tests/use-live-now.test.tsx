// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { LIVE_NOW_INTERVAL_MS, useLiveNow } from '@/hooks/use-live-now';

const BUILD_TIME = '2026-08-14T12:00:00+09:00';
const REAL_NOW = new Date('2026-08-22T12:00:00+09:00');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(REAL_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLiveNow', () => {
  it('마운트 후에는 실제 현재 시각을 돌려준다', () => {
    const { result } = renderHook(() => useLiveNow(BUILD_TIME));

    // 첫 렌더는 buildTime 으로 시드되지만(하이드레이션 일치용),
    // 마운트 effect 가 즉시 현재 시각으로 교체합니다.
    expect(result.current.getTime()).toBe(REAL_NOW.getTime());
  });

  it('주기가 지나면 시각을 갱신한다', () => {
    const { result } = renderHook(() => useLiveNow(BUILD_TIME));
    const first = result.current.getTime();

    act(() => {
      vi.advanceTimersByTime(LIVE_NOW_INTERVAL_MS);
    });

    expect(result.current.getTime()).toBe(first + LIVE_NOW_INTERVAL_MS);
  });

  it('주기 이전에는 갱신하지 않는다', () => {
    const { result } = renderHook(() => useLiveNow(BUILD_TIME));
    const first = result.current.getTime();

    act(() => {
      vi.advanceTimersByTime(LIVE_NOW_INTERVAL_MS - 1);
    });

    expect(result.current.getTime()).toBe(first);
  });

  it('언마운트하면 인터벌을 정리한다', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderHook(() => useLiveNow(BUILD_TIME));

    unmount();

    expect(clearSpy).toHaveBeenCalled();
  });

  it('첫 렌더는 buildTime 으로 시드된다 (하이드레이션 일치 계약)', () => {
    // 서버 HTML 은 빌드 시각 기준으로 만들어집니다.
    // 훅이 처음부터 new Date() 를 쓰면 클라이언트 첫 렌더가 달라져 하이드레이션이 깨집니다.
    // 이 계약은 effect 가 돌기 전 값이라 renderHook 으로는 관측할 수 없으므로
    // 서버 렌더(renderToString)로 확인합니다 — 서버에서는 effect 가 실행되지 않습니다.
    function Probe() {
      return <span>{useLiveNow(BUILD_TIME).toISOString()}</span>;
    }

    const html = renderToString(<Probe />);

    expect(html).toContain(new Date(BUILD_TIME).toISOString());
    expect(html).not.toContain(REAL_NOW.toISOString());
  });

  it('아일랜드마다 새 시계를 만들지 않고 같은 벽시계를 읽는다', () => {
    // 마운트 시점이 다른 두 아일랜드(예: 히어로 통계와 목록)가
    // 각자 다른 기준으로 시각을 계산하면 화면에서 숫자가 어긋납니다.
    const first = renderHook(() => useLiveNow(BUILD_TIME));

    // 두 번째 아일랜드는 30초 늦게 마운트된 상황
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    const second = renderHook(() => useLiveNow('2026-01-01T00:00:00+09:00'));

    // 시드가 서로 달라도 마운트 후에는 둘 다 실제 현재 시각을 본다
    expect(second.result.current.getTime()).toBe(REAL_NOW.getTime() + 30_000);
    expect(Math.abs(first.result.current.getTime() - second.result.current.getTime())).toBeLessThan(
      LIVE_NOW_INTERVAL_MS,
    );
  });
});
