import { describe, expect, it } from 'vitest';
import { formatBenefit, formatBenefitAmount } from '@/lib/format';
import { applySort } from '@/lib/deal-filter';
import { dealBenefitSchema } from '@/lib/deal-schema';
import type { DecoratedDeal } from '@/types/deal';

/**
 * 혜택의 크기
 * ---------------------------------------------------------------------------
 * price 로는 캐시백·포인트·증정의 값어치를 표현할 수 없습니다.
 * price 는 "상품을 살 때 내는 돈"이라 받는 혜택에는 정가라는 개념이 없습니다.
 *
 * 그래서 카드 캐시백 87만원짜리가 `original: null, final: 0` 으로 들어와
 * 절약액 0원으로 계산됐습니다. 값이 제목 문자열에만 남아
 * 정렬·필터·강조 어디에도 쓰이지 못했고, 화면에서는 8,300원짜리 할인과
 * 똑같아 보였습니다. "줍딜할 만한 게 없다"는 인상의 실제 원인입니다.
 */

describe('금액 표기', () => {
  it('만·억 단위로 짧게 적는다', () => {
    // "870,000원"은 카드에서 자리를 먹고 한눈에 안 들어옵니다.
    expect(formatBenefitAmount(870_000)).toBe('87만원');
    expect(formatBenefitAmount(900_000)).toBe('90만원');
    expect(formatBenefitAmount(15_000)).toBe('1.5만원');
    expect(formatBenefitAmount(100_000_000)).toBe('1억원');
  });

  it('반올림으로 부풀리지 않는다', () => {
    /*
      혜택 금액은 사용자가 받을 것을 약속하는 값입니다.
      반올림하면 19,790원이 "2만원"이 되어 실제보다 크게 보입니다.
      어긋난다면 적게 적힌 쪽이어야 합니다.
    */
    expect(formatBenefitAmount(19_790)).toBe('1.9만원');
    expect(formatBenefitAmount(19_999)).toBe('1.9만원');
    expect(formatBenefitAmount(123_456_789)).toBe('1.2억원');
  });

  it('1만원 미만은 원 단위 그대로 쓴다', () => {
    expect(formatBenefitAmount(8_300)).toBe('8,300원');
    expect(formatBenefitAmount(10)).toBe('10원');
  });

  it('조건부 상한에는 "최대"를 붙인다', () => {
    /*
      "최대 90만원"은 카드 종류·실적에 따라 실제로는 훨씬 적을 수 있습니다.
      이 말을 빠뜨리면 화면이 사용자에게 확정 금액을 약속하게 됩니다.
    */
    expect(formatBenefit({ amount: 900_000, isMax: true })).toBe('최대 90만원');
    expect(formatBenefit({ amount: 30_000, isMax: false })).toBe('3만원');
  });
});

describe('스키마', () => {
  it('금액과 상한 여부를 받는다', () => {
    expect(dealBenefitSchema.safeParse({ amount: 870_000, isMax: true }).success).toBe(true);
  });

  it('0원짜리 혜택은 거절한다', () => {
    // 값이 없으면 필드를 생략해야 합니다. 0 을 넣으면 "혜택 0원"이 표시됩니다.
    expect(dealBenefitSchema.safeParse({ amount: 0, isMax: false }).success).toBe(false);
    expect(dealBenefitSchema.safeParse({ amount: -1, isMax: false }).success).toBe(false);
  });
});

describe('혜택 큰 순 정렬', () => {
  function deal(id: string, benefit?: { amount: number; isMax: boolean }): DecoratedDeal {
    return {
      id,
      meta: { verified: false, updatedAt: '2026-09-02T00:00:00.000Z' },
      ...(benefit ? { benefit } : {}),
    } as unknown as DecoratedDeal;
  }

  it('종류가 달라도 하나의 축으로 줄 세운다', () => {
    // 캐시백 87만원과 할인 8,300원을 나란히 놓을 수 있어야 합니다.
    const sorted = applySort(
      [
        deal('할인', { amount: 8_300, isMax: false }),
        deal('캐시백', { amount: 870_000, isMax: true }),
        deal('포인트', { amount: 30_000, isMax: false }),
      ],
      'benefit',
    );

    expect(sorted.map((d) => d.id)).toEqual(['캐시백', '포인트', '할인']);
  });

  it('값어치를 모르는 항목은 뒤로 보낸다', () => {
    const sorted = applySort(
      [deal('모름'), deal('있음', { amount: 1_000, isMax: false })],
      'benefit',
    );

    expect(sorted.map((d) => d.id)).toEqual(['있음', '모름']);
  });

  it('금액이 같으면 확정 금액을 앞에 둔다', () => {
    // "최대 90만원"보다 "90만원"이 사용자에게 더 확실한 값입니다.
    const sorted = applySort(
      [
        deal('상한', { amount: 900_000, isMax: true }),
        deal('확정', { amount: 900_000, isMax: false }),
      ],
      'benefit',
    );

    expect(sorted.map((d) => d.id)).toEqual(['확정', '상한']);
  });
});
