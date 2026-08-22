import { describe, expect, it } from 'vitest';
import {
  formatCount,
  formatDeadline,
  formatDiscountRate,
  formatKstDate,
  formatKstDateTime,
  formatKstMonthDay,
  formatPrice,
  hasMeaningfulPrice,
  statusVariant,
} from '@/lib/format';

describe('formatPrice', () => {
  it('0원은 "무료"로 표시한다', () => {
    expect(formatPrice(0)).toBe('무료');
  });

  it('천 단위 구분 기호를 넣는다', () => {
    expect(formatPrice(18900)).toBe('18,900원');
  });

  it('100원 딜을 그대로 표시한다', () => {
    expect(formatPrice(100)).toBe('100원');
  });
});

describe('formatDiscountRate', () => {
  it('퍼센트 기호를 붙인다', () => {
    expect(formatDiscountRate(70)).toBe('70%');
  });

  it('null 이면 빈 문자열', () => {
    expect(formatDiscountRate(null)).toBe('');
  });

  it('0 이하면 빈 문자열', () => {
    expect(formatDiscountRate(0)).toBe('');
    expect(formatDiscountRate(-5)).toBe('');
  });
});

describe('formatDeadline', () => {
  it('상시 혜택', () => {
    expect(formatDeadline({ daysLeft: null, status: 'ongoing' })).toBe('상시 진행');
  });

  it('오늘 마감', () => {
    expect(formatDeadline({ daysLeft: 0, status: 'ending_today' })).toBe('오늘 마감');
  });

  it('내일 마감', () => {
    expect(formatDeadline({ daysLeft: 1, status: 'ongoing' })).toBe('내일 마감');
  });

  it('그 외에는 D-n 형식', () => {
    expect(formatDeadline({ daysLeft: 5, status: 'ongoing' })).toBe('D-5');
  });

  it('종료된 혜택', () => {
    expect(formatDeadline({ daysLeft: -3, status: 'ended' })).toBe('종료됨');
  });

  it('소진된 혜택', () => {
    expect(formatDeadline({ daysLeft: 4, status: 'sold_out' })).toBe('소진됨');
  });

  it('오픈 예정 혜택에는 마감 문구 대신 오픈일을 보여준다', () => {
    // upcoming 을 마감 분기보다 먼저 처리하지 않으면
    // 아직 시작도 안 한 혜택에 "오늘 마감"/"D-14" 가 붙습니다.
    expect(
      formatDeadline({
        daysLeft: 14,
        status: 'upcoming',
        period: { startAt: '2026-08-25T10:00:00+09:00' },
      }),
    ).toBe('8월 25일 오픈');
  });

  it('같은 날 시작·마감이어도 오픈 전이면 "오늘 마감"이라 하지 않는다', () => {
    expect(formatDeadline({ daysLeft: 0, status: 'upcoming' })).toBe('오픈 예정');
  });
});

describe('formatKstDate / formatKstDateTime', () => {
  it('KST 기준 날짜를 한국어로 표기한다', () => {
    // 2026-08-20T15:00:00Z = 2026-08-21 00:00 KST
    expect(formatKstDate('2026-08-20T15:00:00Z')).toContain('8월 21일');
  });

  it('시각까지 표기한다', () => {
    const result = formatKstDateTime('2026-08-20T00:00:00+09:00');
    expect(result).toContain('8월 20일');
    expect(result).toContain('00:00');
  });

  it('잘못된 날짜는 빈 문자열을 반환한다', () => {
    expect(formatKstDate('어제')).toBe('');
    expect(formatKstDateTime('')).toBe('');
  });
});

describe('statusVariant', () => {
  it('오늘 마감은 danger', () => {
    expect(statusVariant('ending_today')).toBe('danger');
  });

  it('진행중은 success', () => {
    expect(statusVariant('ongoing')).toBe('success');
  });

  it('오픈예정은 info', () => {
    expect(statusVariant('upcoming')).toBe('info');
  });

  it('종료/소진은 muted', () => {
    expect(statusVariant('ended')).toBe('muted');
    expect(statusVariant('sold_out')).toBe('muted');
  });
});

describe('formatCount', () => {
  it('천 단위 구분 기호를 넣는다', () => {
    expect(formatCount(3120)).toBe('3,120');
  });
});

describe('formatKstMonthDay', () => {
  it('KST 기준 월·일만 표기한다', () => {
    expect(formatKstMonthDay('2026-08-25T10:00:00+09:00')).toBe('8월 25일');
  });

  it('UTC 늦은 밤은 KST 다음 날로 넘어간다', () => {
    expect(formatKstMonthDay('2026-08-24T15:00:00Z')).toBe('8월 25일');
  });

  it('잘못된 값은 빈 문자열', () => {
    expect(formatKstMonthDay('없는날짜')).toBe('');
  });
});

describe('hasMeaningfulPrice', () => {
  it('정가가 있으면 가격을 보여준다', () => {
    expect(
      hasMeaningfulPrice({
        price: { original: 4500, final: 0, currency: 'KRW' },
        dealType: 'free',
      }),
    ).toBe(true);
  });

  it('실제 지불액이 있으면 보여준다', () => {
    expect(hasMeaningfulPrice({ price: { final: 100, currency: 'KRW' }, dealType: 'penny' })).toBe(
      true,
    );
  });

  it('캐시백·포인트는 지불액 0원이어도 가격을 숨긴다', () => {
    // "무료" 라고 크게 띄우면 혜택 성격을 오해하게 만듭니다.
    expect(hasMeaningfulPrice({ price: { final: 0, currency: 'KRW' }, dealType: 'cashback' })).toBe(
      false,
    );
    expect(hasMeaningfulPrice({ price: { final: 0, currency: 'KRW' }, dealType: 'point' })).toBe(
      false,
    );
  });

  it('정가 없는 무료 증정은 여전히 "무료"를 보여준다', () => {
    expect(hasMeaningfulPrice({ price: { final: 0, currency: 'KRW' }, dealType: 'free' })).toBe(
      true,
    );
  });
});
