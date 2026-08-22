// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  DealDetailBadges,
  DealDetailCta,
  toBadgeInfo,
  toCtaInfo,
} from '@/components/DealDetailStatus';
import { NOW, makeDeal } from './fixtures';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** 8/14에 빌드됐고, 실제 현재 시각은 8/20 12:00 (NOW) 인 상황 */
const STALE_BUILD_TIME = '2026-08-14T12:00:00+09:00';

describe('DealDetailBadges', () => {
  it('빌드 시각이 아니라 현재 시각으로 상태를 다시 계산한다', () => {
    // 8/14 기준으로는 '진행중'이지만, 실제로는 8/20 에 이미 끝난 혜택.
    const ended = makeDeal({
      period: { startAt: '2026-08-01T00:00:00+09:00', endAt: '2026-08-18T23:59:59+09:00' },
    });

    render(<DealDetailBadges info={toBadgeInfo(ended)} buildTime={STALE_BUILD_TIME} />);

    const badges = within(screen.getByTestId('detail-badges'));
    expect(badges.getByText('종료')).toBeInTheDocument();
    expect(badges.queryByText('진행중')).not.toBeInTheDocument();
  });

  it('오늘 마감이면 마감 뱃지를 보여준다', () => {
    const today = makeDeal({ period: { endAt: '2026-08-20T23:59:59+09:00' } });

    render(<DealDetailBadges info={toBadgeInfo(today)} buildTime={STALE_BUILD_TIME} />);

    const badges = within(screen.getByTestId('detail-badges'));
    expect(badges.getByText('오늘마감')).toBeInTheDocument();
    expect(badges.getByText('오늘 마감')).toBeInTheDocument();
  });

  it('선착순 혜택에 선착순 뱃지를 붙인다', () => {
    const deal = makeDeal({ limit: { firstComeFirstServed: true, quantity: 100, remaining: 5 } });

    render(<DealDetailBadges info={toBadgeInfo(deal)} buildTime={STALE_BUILD_TIME} />);

    expect(within(screen.getByTestId('detail-badges')).getByText('선착순')).toBeInTheDocument();
  });

  it('오픈 예정 혜택에는 마감이 아니라 오픈일을 보여준다', () => {
    const upcoming = makeDeal({
      period: { startAt: '2026-08-25T10:00:00+09:00', endAt: '2026-09-05T23:59:59+09:00' },
    });

    render(<DealDetailBadges info={toBadgeInfo(upcoming)} buildTime={STALE_BUILD_TIME} />);

    const badges = within(screen.getByTestId('detail-badges'));
    expect(badges.getByText('오픈예정')).toBeInTheDocument();
    expect(badges.getByText('8월 25일 오픈')).toBeInTheDocument();
  });
});

describe('DealDetailCta', () => {
  it('빌드 시점엔 살아있었어도 지금 끝났으면 CTA 를 비활성화한다', () => {
    // 이 회귀가 바로 "목록은 종료라는데 상세는 참여하라고 하는" 모순의 원인이었습니다.
    const ended = makeDeal({
      period: { startAt: '2026-08-01T00:00:00+09:00', endAt: '2026-08-18T23:59:59+09:00' },
      link: { url: 'https://example.com/go' },
    });

    render(<DealDetailCta info={toCtaInfo(ended)} buildTime={STALE_BUILD_TIME} />);

    const cta = screen.getByTestId('detail-cta');
    expect(cta.tagName).toBe('BUTTON');
    expect(cta).toBeDisabled();
    expect(cta).toHaveTextContent('종료된 혜택이에요');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('진행 중이면 안전한 rel 을 가진 외부 링크를 노출한다', () => {
    const ongoing = makeDeal({ link: { url: 'https://example.com/go', label: '쿠폰 받기' } });

    render(<DealDetailCta info={toCtaInfo(ongoing)} buildTime={STALE_BUILD_TIME} />);

    const cta = screen.getByTestId('detail-cta');
    expect(cta.tagName).toBe('A');
    expect(cta).toHaveAttribute('href', 'https://example.com/go');
    expect(cta).toHaveAttribute('target', '_blank');
    expect(cta.getAttribute('rel')).toContain('noopener');
    expect(cta.getAttribute('rel')).toContain('noreferrer');
    expect(cta).toHaveTextContent('쿠폰 받기');
  });

  it('오픈 전이면 오픈 전 문구를 보여준다', () => {
    const upcoming = makeDeal({
      period: { startAt: '2026-08-25T10:00:00+09:00', endAt: '2026-09-05T23:59:59+09:00' },
    });

    render(<DealDetailCta info={toCtaInfo(upcoming)} buildTime={STALE_BUILD_TIME} />);

    const cta = screen.getByTestId('detail-cta');
    expect(cta).toBeDisabled();
    expect(cta).toHaveTextContent('아직 오픈 전이에요');
  });

  it('소진된 혜택도 참여를 막는다', () => {
    const soldOut = makeDeal({
      limit: { firstComeFirstServed: true, quantity: 100, remaining: 0 },
    });

    render(<DealDetailCta info={toCtaInfo(soldOut)} buildTime={STALE_BUILD_TIME} />);

    expect(screen.getByTestId('detail-cta')).toBeDisabled();
  });
});
