// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DealCard } from '@/components/DealCard';
import { makeDecoratedDeal } from './fixtures';

describe('DealCard', () => {
  it('제목과 요약을 보여준다', () => {
    render(
      <DealCard
        deal={makeDecoratedDeal({ title: '아메리카노 무료 쿠폰', summary: '가입만 하면 끝' })}
      />,
    );

    expect(screen.getByRole('heading', { name: '아메리카노 무료 쿠폰' })).toBeInTheDocument();
    expect(screen.getByText('가입만 하면 끝')).toBeInTheDocument();
  });

  it('무료 혜택은 가격을 "무료"로 표시한다', () => {
    render(
      <DealCard
        deal={makeDecoratedDeal({ price: { original: 4500, final: 0, currency: 'KRW' } })}
      />,
    );

    const price = within(screen.getByTestId('deal-price'));
    expect(price.getByText('무료')).toBeInTheDocument();
    expect(price.getByText('100%')).toBeInTheDocument();
    expect(price.getByText('4,500원')).toBeInTheDocument();
  });

  it('100원 딜의 할인율과 정가를 함께 보여준다', () => {
    render(
      <DealCard
        deal={makeDecoratedDeal({
          dealType: 'penny',
          price: { original: 18900, final: 100, currency: 'KRW' },
        })}
      />,
    );

    expect(screen.getByText('100원')).toBeInTheDocument();
    expect(screen.getByText('99%')).toBeInTheDocument();
    expect(screen.getByText('100원딜')).toBeInTheDocument();
  });

  it('오늘 마감이면 마감 뱃지를 노출한다', () => {
    render(
      <DealCard deal={makeDecoratedDeal({ period: { endAt: '2026-08-20T23:59:59+09:00' } })} />,
    );

    expect(screen.getByText('오늘마감')).toBeInTheDocument();
    expect(screen.getByText('오늘 마감')).toBeInTheDocument();
  });

  it('진행중이면 진행 상태 뱃지를 노출한다', () => {
    render(<DealCard deal={makeDecoratedDeal()} />);
    expect(screen.getByText('진행중')).toBeInTheDocument();
  });

  it('상시 혜택은 "상시 진행"으로 표시한다', () => {
    render(<DealCard deal={makeDecoratedDeal({ period: { endAt: null } })} />);
    expect(screen.getByText('상시 진행')).toBeInTheDocument();
  });

  it('참여 가능하면 외부 링크 CTA 를 안전한 rel 속성과 함께 렌더한다', () => {
    render(
      <DealCard
        deal={makeDecoratedDeal({ link: { url: 'https://example.com/go', label: '쿠폰 받기' } })}
      />,
    );

    const cta = screen.getByRole('link', { name: /쿠폰 받기/ });
    expect(cta).toHaveAttribute('href', 'https://example.com/go');
    expect(cta).toHaveAttribute('target', '_blank');
    expect(cta.getAttribute('rel')).toContain('noopener');
    expect(cta.getAttribute('rel')).toContain('noreferrer');
  });

  it('종료된 혜택은 CTA 를 비활성화한다', () => {
    render(
      <DealCard deal={makeDecoratedDeal({ period: { endAt: '2026-08-01T00:00:00+09:00' } })} />,
    );

    const button = screen.getByRole('button', { name: '참여 마감' });
    expect(button).toBeDisabled();
    expect(screen.queryByRole('link', { name: /혜택 받으러 가기/ })).not.toBeInTheDocument();
  });

  it('오픈 예정이면 "오픈 예정" 버튼을 비활성 상태로 보여준다', () => {
    render(
      <DealCard
        deal={makeDecoratedDeal({
          period: { startAt: '2026-08-25T10:00:00+09:00', endAt: '2026-09-05T23:59:59+09:00' },
        })}
      />,
    );

    expect(screen.getByRole('button', { name: '오픈 예정' })).toBeDisabled();
  });

  it('선착순 수량이 있으면 남은 수량과 진행바를 보여준다', () => {
    render(
      <DealCard
        deal={makeDecoratedDeal({
          limit: { firstComeFirstServed: true, quantity: 5000, remaining: 320 },
        })}
      />,
    );

    expect(screen.getByText('320개 남음')).toBeInTheDocument();
    expect(screen.getByText('선착순')).toBeInTheDocument();

    const bar = screen.getByRole('progressbar', { name: '남은 수량 비율' });
    expect(bar).toHaveAttribute('aria-valuenow', '6');
  });

  it('수량 정보가 없으면 진행바를 렌더하지 않는다', () => {
    render(<DealCard deal={makeDecoratedDeal()} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('브랜드명과 카테고리 라벨을 보여준다', () => {
    render(
      <DealCard deal={makeDecoratedDeal({ brand: { name: '온더카페' }, category: 'cafe' })} />,
    );

    expect(screen.getByText('온더카페')).toBeInTheDocument();
    expect(screen.getByTestId('deal-category')).toHaveTextContent('카페');
  });

  it('난이도 라벨을 보여준다', () => {
    render(<DealCard deal={makeDecoratedDeal({ difficulty: 'hard' })} />);
    expect(screen.getByText('고수용')).toBeInTheDocument();
  });

  it('상세 페이지로 가는 링크를 slug 기준으로 만든다', () => {
    render(<DealCard deal={makeDecoratedDeal({ slug: 'my-deal', title: '내 혜택' })} />);

    expect(screen.getByRole('link', { name: '내 혜택' })).toHaveAttribute('href', '/deals/my-deal');
  });

  it('상태를 data 속성으로 노출한다', () => {
    render(<DealCard deal={makeDecoratedDeal({ period: { endAt: null } })} />);
    expect(screen.getByTestId('deal-card')).toHaveAttribute('data-status', 'ongoing');
  });
});
