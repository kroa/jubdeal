import { describe, expect, it } from 'vitest';
import { formatBenefit, formatBenefitAmount, formatBenefitCeiling } from '@/lib/format';
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

  it('기본을 모르는 상한은 4분의 1로 본다', () => {
    /*
      처음에는 절반으로 뒀는데 실측해 보니 너무 후했습니다.
      기본 금액을 아는 카드 이벤트들의 기본/최대 비율은 21~27% 입니다.
      50% 로 보면 카드고릴라의 "최대 87만원"이 43.5만원으로 계산되어
      아정당의 확정 18만원짜리를 2.4배 차이로 눌렀습니다.
      이것이 "모든 카드를 다 신청해야 나오는 혜택만 보인다"는 인상의 원인이었습니다.
    */
    const sorted = applySort(
      [
        deal('기본모름_최대87만', { amount: 870_000, isMax: true }),
        deal('확정18만', { amount: 180_000, isMax: false }),
      ],
      'benefit',
    );

    // 87만 * 0.25 = 21.75만 > 18만. 아직은 상한이 앞섭니다.
    expect(sorted.map((d) => d.id)).toEqual(['기본모름_최대87만', '확정18만']);

    const sorted2 = applySort(
      [
        deal('기본모름_최대87만', { amount: 870_000, isMax: true }),
        deal('확정25만', { amount: 250_000, isMax: false }),
      ],
      'benefit',
    );

    // 확정 25만이 상한 87만을 이깁니다. 절반(43.5만)으로 봤다면 졌습니다.
    expect(sorted2.map((d) => d.id)).toEqual(['확정25만', '기본모름_최대87만']);
  });

  it('기본 금액을 알면 그 값으로 줄 세운다', () => {
    function withBase(
      id: string,
      amount: number,
      isMax: boolean,
      baseAmount?: number,
    ): DecoratedDeal {
      return {
        id,
        meta: { verified: false, updatedAt: '2026-09-02T00:00:00.000Z' },
        benefit: { amount, isMax, ...(baseAmount === undefined ? {} : { baseAmount }) },
      } as unknown as DecoratedDeal;
    }

    // 실제 값입니다. KB 85만(기본 21만) vs 삼성 60.2만(기본 16만).
    const sorted = applySort(
      [
        withBase('삼성_기본16만', 602_000, true, 160_000),
        withBase('KB_기본21만', 850_000, true, 210_000),
      ],
      'benefit',
    );

    expect(sorted.map((d) => d.id)).toEqual(['KB_기본21만', '삼성_기본16만']);
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

describe('도달 불가능한 상한이 확정 금액을 이기지 않는다', () => {
  /*
    사용자 지적: "아정당 보니까 모든 카드를 다 신청해야만 나오는거라서.. 좀 그렇네"

    KB국민카드 "최대 85만원"의 실체는 카드 5종을 전부 발급하고 모든 조건을
    채웠을 때의 합산입니다. 카드 한 장으로 받는 기본은 18만원입니다.
    상한으로 줄 세우면 도달 불가능한 숫자가 목록 위를 차지하고,
    확정 16만원짜리가 그 아래로 밀립니다.
  */
  function deal(id: string, benefit?: { amount: number; isMax: boolean; baseAmount?: number }) {
    return {
      id,
      meta: { verified: false, updatedAt: '2026-09-05T00:00:00.000Z' },
      ...(benefit ? { benefit } : {}),
    } as unknown as DecoratedDeal;
  }

  it('기본 금액이 있으면 그걸로 줄 세운다', () => {
    const sorted = applySort(
      [
        deal('카드최대85만', { amount: 850_000, isMax: true, baseAmount: 180_000 }),
        deal('확정20만', { amount: 200_000, isMax: false }),
      ],
      'benefit',
    );

    // 18만원(실질) < 20만원(확정) 이므로 확정이 앞입니다.
    expect(sorted.map((d) => d.id)).toEqual(['확정20만', '카드최대85만']);
  });

  it('기본 금액을 모르는 상한은 절반으로 본다', () => {
    // 임의의 값이지만, 상한이 확정을 그대로 이기는 것보다는 실제에 가깝습니다.
    const sorted = applySort(
      [
        deal('최대100만', { amount: 1_000_000, isMax: true }),
        deal('확정60만', { amount: 600_000, isMax: false }),
      ],
      'benefit',
    );

    expect(sorted.map((d) => d.id)).toEqual(['확정60만', '최대100만']);
  });

  it('화면에는 기본 금액을 앞세우고 상한은 부연으로 둔다', () => {
    const benefit = { amount: 850_000, isMax: true, baseAmount: 180_000 };

    expect(formatBenefit(benefit)).toBe('18만원');
    expect(formatBenefitCeiling(benefit)).toContain('최대 85만원');
  });

  it('기본을 모르면 "최대"를 그대로 쓴다', () => {
    // 숨기면 거짓말이 됩니다. 아는 만큼만 말합니다.
    expect(formatBenefit({ amount: 850_000, isMax: true })).toBe('최대 85만원');
    expect(formatBenefitCeiling({ amount: 850_000, isMax: true })).toBe('');
  });

  it('확정 금액에는 부연을 붙이지 않는다', () => {
    expect(formatBenefitCeiling({ amount: 30_000, isMax: false })).toBe('');
  });
});

describe('benefit 스키마 — 기본 금액', () => {
  it('기본이 상한보다 크면 거절한다', () => {
    // 둘 중 하나를 잘못 읽은 것입니다.
    const parsed = dealBenefitSchema.safeParse({
      amount: 100_000,
      isMax: true,
      baseAmount: 200_000,
    });
    expect(parsed.success).toBe(false);
  });

  it('확정 금액에 기본값을 또 두면 거절한다', () => {
    const parsed = dealBenefitSchema.safeParse({
      amount: 100_000,
      isMax: false,
      baseAmount: 50_000,
    });
    expect(parsed.success).toBe(false);
  });

  it('상한 + 기본 조합은 받는다', () => {
    const parsed = dealBenefitSchema.safeParse({
      amount: 850_000,
      isMax: true,
      baseAmount: 180_000,
    });
    expect(parsed.success).toBe(true);
  });
});
