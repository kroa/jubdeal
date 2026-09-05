import { z } from 'zod';
import {
  DEAL_CATEGORIES,
  DEAL_DIFFICULTIES,
  DEAL_TYPES,
  DEAL_SCHEMA_VERSION,
  SOURCE_METHODS,
  type Deal,
  type DealsFile,
} from '@/types/deal';

/**
 * Deal 런타임 검증 스키마 (zod)
 * ---------------------------------------------------------------------------
 * `src/types/deal.ts` 의 타입과 1:1 대응합니다.
 *
 * 사용처:
 *  1) 빌드 타임 — `src/lib/deals.ts` 가 deals.json 을 읽을 때 검증.
 *     깨진 데이터가 배포되는 것을 빌드 실패로 차단합니다.
 *  2) 추후 크롤러/LLM 파이프라인 — 자동 생성된 JSON이 스키마를 만족하는지
 *     `safeParseDeal()` 로 확인하고, 실패 건은 사람 검수 큐로 보냅니다.
 */

/**
 * 타임존 오프셋(또는 Z)이 반드시 포함된 완전한 ISO 8601 date-time 만 허용합니다.
 *
 * `Date.parse` 만으로 검사하면 `2026-08-31` 이나 `2026-08-31T23:59:59` 같은 값도
 * 통과하는데, 전자는 UTC 자정으로, 후자는 **빌드 머신의 로컬 타임존**으로 해석됩니다.
 * 그러면 KST 기준으로 계산하는 상태 로직이 러너 타임존에 따라 하루씩 어긋납니다.
 * 오프셋을 강제해 그 모호함을 원천 차단합니다.
 */
const ISO_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

const isoDateTime = z.string().refine(
  (value) => {
    const matched = ISO_OFFSET_RE.exec(value);
    if (!matched) return false;

    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return false;

    // V8은 '2026-02-30T00:00:00+09:00' 같은 값을 3월 2일로 롤오버시켜 파싱합니다.
    // 문자열이 가리키는 시각을 그대로 되돌려 비교해 존재하지 않는 날짜를 걸러냅니다.
    const [, year, month, day, hour, minute, second, zone] = matched;
    const offsetMs =
      zone === 'Z'
        ? 0
        : (zone!.startsWith('-') ? -1 : 1) *
          (Number(zone!.slice(1, 3)) * 60 + Number(zone!.slice(4, 6))) *
          60_000;
    const asWritten = new Date(ms + offsetMs);

    return (
      asWritten.getUTCFullYear() === Number(year) &&
      asWritten.getUTCMonth() + 1 === Number(month) &&
      asWritten.getUTCDate() === Number(day) &&
      asWritten.getUTCHours() === Number(hour) &&
      asWritten.getUTCMinutes() === Number(minute) &&
      asWritten.getUTCSeconds() === Number(second)
    );
  },
  {
    message:
      '타임존 오프셋을 포함한 ISO 8601 날짜/시간이어야 합니다. 예: 2026-08-20T09:00:00+09:00 ' +
      '(오프셋이 없거나 날짜만 있는 값은 빌드 머신 타임존에 따라 결과가 달라져 허용하지 않습니다.)',
  },
);

/** http/https 절대 URL인지 검사 */
const httpUrl = z.string().refine(
  (value) => {
    if (!URL.canParse(value)) return false;
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  },
  { message: 'http 또는 https 로 시작하는 절대 URL이어야 합니다.' },
);

export const dealBrandSchema = z.object({
  name: z.string().min(1),
  logoUrl: httpUrl.optional(),
});

export const dealPriceSchema = z
  .object({
    original: z.number().int().nonnegative().optional(),
    final: z.number().int().nonnegative(),
    currency: z.literal('KRW'),
    discountRate: z.number().min(0).max(100).optional(),
  })
  .refine((price) => price.original === undefined || price.original >= price.final, {
    message: '정가(original)는 실제 지불액(final)보다 작을 수 없습니다.',
    path: ['original'],
  })
  .refine(
    (price) => {
      // 명시된 discountRate 가 original/final 과 모순되지 않는지 확인합니다.
      // (반올림·표기 관행을 감안해 ±2%p 오차는 허용)
      if (price.discountRate === undefined) return true;
      if (price.original === undefined || price.original <= 0) return true;

      const computed = ((price.original - price.final) / price.original) * 100;
      return Math.abs(computed - price.discountRate) <= 2;
    },
    {
      message: '명시된 할인율(discountRate)이 정가·실지불액으로 계산한 값과 어긋납니다.',
      path: ['discountRate'],
    },
  );

export const dealLimitSchema = z
  .object({
    firstComeFirstServed: z.boolean(),
    quantity: z.number().int().positive().optional(),
    remaining: z.number().int().nonnegative().optional(),
    perPersonLimit: z.number().int().positive().optional(),
  })
  .refine(
    (limit) =>
      limit.quantity === undefined ||
      limit.remaining === undefined ||
      limit.remaining <= limit.quantity,
    {
      message: '남은 수량(remaining)이 총 수량(quantity)보다 클 수 없습니다.',
      path: ['remaining'],
    },
  );

export const dealPeriodSchema = z
  .object({
    startAt: isoDateTime,
    endAt: isoDateTime.nullable(),
    deadlineUnknown: z.boolean().optional(),
  })
  .refine(
    (period) => period.endAt === null || Date.parse(period.endAt) > Date.parse(period.startAt),
    {
      message: '종료 시각(endAt)은 시작 시각(startAt)보다 뒤여야 합니다.',
      path: ['endAt'],
    },
  )
  .refine((period) => !(period.deadlineUnknown && period.endAt !== null), {
    // 마감일을 안다면 미상이 아닙니다. 둘 다 참이면 UI 가 어느 쪽을 믿을지 알 수 없습니다.
    message: 'deadlineUnknown 이 true 면 endAt 은 null 이어야 합니다.',
    path: ['deadlineUnknown'],
  });

export const dealBenefitSchema = z
  .object({
    // 0원짜리 "혜택"은 혜택이 아닙니다. 값이 없으면 필드를 생략하세요.
    amount: z.number().int().positive(),
    isMax: z.boolean(),
    baseAmount: z.number().int().positive().optional(),
  })
  .refine((b) => b.baseAmount === undefined || b.baseAmount <= b.amount, {
    // 기본이 상한보다 크면 둘 중 하나를 잘못 읽은 것입니다.
    message: 'baseAmount 는 amount 보다 클 수 없습니다.',
    path: ['baseAmount'],
  })
  .refine((b) => b.baseAmount === undefined || b.isMax, {
    // 확정 금액에 "기본값"을 또 두면 의미가 없습니다.
    message: 'baseAmount 는 isMax 가 true 일 때만 씁니다.',
    path: ['baseAmount'],
  });

export const dealLinkSchema = z.object({
  url: httpUrl,
  label: z.string().min(1).optional(),
  affiliate: z.boolean().optional(),
});

export const dealSourceSchema = z.object({
  name: z.string().min(1),
  url: httpUrl.optional(),
  collectedAt: isoDateTime,
  method: z.enum(SOURCE_METHODS),
  confidence: z.number().min(0).max(1).optional(),
});

export const dealMetaSchema = z.object({
  featured: z.boolean().optional(),
  verified: z.boolean(),
  updatedAt: isoDateTime,
});

export const dealSchema = z.object({
  id: z.string().min(1),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '슬러그는 영소문자·숫자·하이픈만 사용할 수 있습니다.'),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(200),
  description: z.string().optional(),
  brand: dealBrandSchema,
  category: z.enum(DEAL_CATEGORIES),
  dealType: z.enum(DEAL_TYPES),
  difficulty: z.enum(DEAL_DIFFICULTIES),
  price: dealPriceSchema,
  limit: dealLimitSchema,
  period: dealPeriodSchema,
  benefit: dealBenefitSchema.optional(),
  link: dealLinkSchema,
  howTo: z.array(z.string().min(1)).optional(),
  caution: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).max(12),
  source: dealSourceSchema,
  meta: dealMetaSchema,
});

export const dealsFileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  generatedAt: isoDateTime,
  deals: z.array(dealSchema),
});

/* -------------------------------------------------------------------------- */
/* 헬퍼                                                                        */
/* -------------------------------------------------------------------------- */

/** 검증 실패 시 예외를 던집니다. 빌드 타임 게이트용. */
export function parseDeal(input: unknown): Deal {
  return dealSchema.parse(input) as Deal;
}

/** 검증 결과를 반환합니다. 크롤러/LLM 결과물 선별용. */
export function safeParseDeal(input: unknown) {
  return dealSchema.safeParse(input);
}

/**
 * deals.json 전체를 검증합니다.
 * - 스키마 위반
 * - id / slug 중복
 * - 스키마 버전 불일치
 * 위 세 가지를 모두 잡아 사람이 읽을 수 있는 메시지로 던집니다.
 */
export function parseDealsFile(input: unknown): DealsFile {
  const result = dealsFileSchema.safeParse(input);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`[줍딜] deals 데이터 검증 실패:\n${issues}`);
  }

  const file = result.data as DealsFile;

  if (file.schemaVersion !== DEAL_SCHEMA_VERSION) {
    throw new Error(
      `[줍딜] 스키마 버전 불일치: 데이터=${file.schemaVersion}, 코드=${DEAL_SCHEMA_VERSION}`,
    );
  }

  assertUnique(file.deals, (deal) => deal.id, 'id');
  assertUnique(file.deals, (deal) => deal.slug, 'slug');

  return file;
}

function assertUnique(deals: Deal[], pick: (deal: Deal) => string, field: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const deal of deals) {
    const key = pick(deal);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }

  if (duplicates.size > 0) {
    throw new Error(`[줍딜] 중복된 ${field} 값이 있습니다: ${[...duplicates].join(', ')}`);
  }
}
