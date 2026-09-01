import type { DecoratedDeal } from '@/types/deal';
import { CATEGORY_EMOJI, CATEGORY_LABELS } from '@/types/deal';
import {
  formatBenefit,
  formatCount,
  formatDiscountRate,
  formatPrice,
  hasMeaningfulPrice,
} from '@/lib/format';
import { getRemainingRatio } from '@/lib/deal-status';
import {
  DeadlineBadge,
  DealStatusBadge,
  DealTypeBadge,
  DifficultyBadge,
  FirstComeBadge,
} from '@/components/Badge';

interface DealCardProps {
  deal: DecoratedDeal;
  /** 상세 페이지 경로. 생략하면 /deals/{slug} */
  href?: string;
}

/**
 * 혜택 카드
 * - 모바일 우선 반응형. 그리드 안에서 높이를 꽉 채웁니다.
 * - 종료/소진된 혜택은 시각적으로 흐리게 처리하고 CTA를 비활성화합니다.
 */
export function DealCard({ deal, href }: DealCardProps) {
  const detailHref = href ?? `/deals/${deal.slug}`;
  const discount = formatDiscountRate(deal.discountRate);
  const remainingRatio = getRemainingRatio(deal);
  // 캐시백·포인트처럼 "지불액 0원"이지만 무료 증정이 아닌 혜택은 가격을 숨깁니다.
  const showPrice = hasMeaningfulPrice(deal);

  return (
    <article
      className={`deal-card${deal.isActionable ? '' : ' deal-card--closed'}`}
      data-status={deal.status}
      data-testid="deal-card"
    >
      <div className="deal-card__badges">
        <DealStatusBadge status={deal.status} />
        <DeadlineBadge deal={deal} />
        <DealTypeBadge dealType={deal.dealType} />
      </div>

      <h3 className="deal-card__title">
        <a href={detailHref} className="deal-card__link">
          {deal.title}
        </a>
      </h3>

      <p className="deal-card__summary">{deal.summary}</p>

      {/*
        혜택의 크기를 가격보다 먼저, 크게 보여줍니다.
        캐시백·포인트·증정은 price 로 표현되지 않아 예전에는 제목 안에만 있었고,
        그래서 87만원짜리가 8,300원짜리와 똑같아 보였습니다.
      */}
      {deal.benefit && (
        <p className="deal-card__benefit" data-testid="deal-benefit">
          <span className="deal-card__benefit-amount">{formatBenefit(deal.benefit)}</span>
          <span className="deal-card__benefit-label"> 상당</span>
        </p>
      )}

      {showPrice && (
        <div className="deal-card__price" data-testid="deal-price">
          {discount && <span className="deal-card__discount">{discount}</span>}
          <strong className="deal-card__final">{formatPrice(deal.price.final)}</strong>
          {typeof deal.price.original === 'number' && deal.price.original > deal.price.final && (
            <span className="deal-card__original">{formatPrice(deal.price.original)}</span>
          )}
        </div>
      )}

      {remainingRatio !== null && (
        <div className="deal-card__stock">
          <div
            className="deal-card__stock-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(remainingRatio * 100)}
            aria-label="남은 수량 비율"
          >
            <span
              className="deal-card__stock-fill"
              style={{ width: `${Math.round(remainingRatio * 100)}%` }}
            />
          </div>
          <span className="deal-card__stock-text">
            {deal.limit.remaining === 0
              ? '수량 소진'
              : `${formatCount(deal.limit.remaining ?? 0)}개 남음`}
          </span>
        </div>
      )}

      <div className="deal-card__meta">
        <span className="deal-card__brand">{deal.brand.name}</span>
        <span className="deal-card__category" data-testid="deal-category">
          <span aria-hidden="true">{CATEGORY_EMOJI[deal.category]}</span>{' '}
          {CATEGORY_LABELS[deal.category]}
        </span>
      </div>

      <div className="deal-card__footer">
        <div className="deal-card__badges deal-card__badges--sm">
          <DifficultyBadge difficulty={deal.difficulty} />
          {deal.limit.firstComeFirstServed && <FirstComeBadge />}
        </div>

        {deal.isActionable ? (
          <a
            className="btn btn--primary deal-card__cta"
            href={deal.link.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
          >
            {deal.link.label ?? '혜택 받으러 가기'}
            <span className="sr-only">(새 창에서 열림)</span>
          </a>
        ) : (
          <button type="button" className="btn deal-card__cta" disabled>
            {deal.status === 'upcoming' ? '오픈 예정' : '참여 마감'}
          </button>
        )}
      </div>
    </article>
  );
}

export default DealCard;
