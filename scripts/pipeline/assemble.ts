import { createHash } from 'node:crypto';
import type { Deal, DealBenefit } from '@/types/deal';
import { safeParseDeal } from '@/lib/deal-schema';
import type { ExtractedDeal } from '@pipeline/extract/schema';
import type { RawItem } from '@pipeline/types';

/**
 * 조립: ExtractedDeal + 수집 메타 → 완전한 Deal
 * ---------------------------------------------------------------------------
 * 모델이 만들 수 없는 값을 여기서 채웁니다.
 * 핵심은 **id 와 slug 의 안정성**입니다.
 * 같은 원문을 다시 수집했을 때 반드시 같은 id 가 나와야 중복이 쌓이지 않습니다.
 * 그래서 id 는 모델 출력이 아니라 (소스 ID + 정규화된 URL) 만으로 만듭니다.
 */

/** KST 고정 오프셋 */
const KST_OFFSET = '+09:00';

/**
 * URL 을 정규화합니다.
 * 추적 파라미터나 프래그먼트 때문에 같은 페이지가 다른 id 를 갖지 않도록 합니다.
 */
export function canonicalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = '';

    // 추적/세션 파라미터. 세션 ID 는 매 방문마다 달라져서,
    // 제거하지 않으면 같은 혜택이 매일 새 id 로 중복 등록됩니다.
    const TRACKING =
      /^(utm_|fbclid$|gclid$|igshid$|spm$|ref$|from$|jsessionid$|phpsessid$|sid$|sessionid$|session_id$|_ga$|_gl$|mc_cid$|mc_eid$|yclid$|msclkid$)/i;
    const keys = [...url.searchParams.keys()];
    for (const key of keys) {
      if (TRACKING.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();

    // 끝의 슬래시 하나는 무시 (루트 제외)
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.href;
  } catch {
    return rawUrl;
  }
}

/** 소스 + 정규화 URL 로부터 안정적인 ID 를 만듭니다. */
export function makeStableId(sourceId: string, url: string): string {
  const digest = createHash('sha256')
    .update(`${sourceId} ${canonicalizeUrl(url)}`)
    .digest('hex')
    .slice(0, 16);

  return `dl_${sourceId}_${digest}`;
}

/**
 * 슬러그를 만듭니다.
 * 스키마가 영소문자·숫자·하이픈만 허용하는데 원문 제목은 한글이라,
 * URL 경로에서 쓸 만한 토큰을 뽑고 부족하면 해시로 채웁니다.
 */
export function makeSlug(sourceId: string, url: string, seed: string): string {
  const fromUrl = slugTokensFromUrl(url);
  const base = [sourceId, ...fromUrl].filter(Boolean).join('-');
  const normalized = normalizeSlug(base);

  // 해시는 고유성의 유일한 보증이므로 **절대 잘리면 안 됩니다.**
  // 앞부분을 먼저 줄이고 해시를 뒤에 온전히 붙입니다.
  // (잘리면 서로 다른 혜택이 같은 slug 를 갖게 되고,
  //  parseDealsFile 의 중복 검사에 걸려 파이프라인 전체가 매일 중단됩니다.)
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 8);
  const suffix = `-${digest}`;
  const maxPrefix = 80 - suffix.length;

  const prefix = (normalized || 'deal').slice(0, maxPrefix).replace(/-+$/, '');

  return `${prefix || 'deal'}${suffix}`;
}

function slugTokensFromUrl(url: string): string[] {
  try {
    const { pathname } = new URL(url);
    return pathname
      .split('/')
      .map((segment) => normalizeSlug(decodeURIComponent(segment)))
      .filter((segment) => segment.length >= 2 && !/^\d+$/.test(segment))
      .slice(-2);
  } catch {
    return [];
  }
}

function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "2026-08-25" 또는 "2026-08-25T10:00" → KST 오프셋이 붙은 ISO 문자열 */
export function toKstIso(local: string | null, endOfDay = false): string | null {
  if (local === null) return null;

  const hasTime = local.includes('T');
  if (hasTime) return `${local}:00${KST_OFFSET}`;

  return `${local}T${endOfDay ? '23:59:59' : '00:00:00'}${KST_OFFSET}`;
}

export interface AssembleOptions {
  /** 실행 시각 */
  now: Date;
  /** 이미 있는 항목이면 그 id/slug 를 물려받아 링크가 깨지지 않게 합니다. */
  existing?: Pick<Deal, 'id' | 'slug'>;
}

export type AssembleResult =
  { ok: true; deal: Deal } | { ok: false; detail: string; candidate: unknown };

/** ExtractedDeal 을 Deal 로 조립하고 정식 스키마로 검증합니다. */
export function assembleDeal(
  extracted: ExtractedDeal,
  raw: RawItem,
  options: AssembleOptions,
): AssembleResult {
  const nowIso = options.now.toISOString();

  // 모델이 "모른다"고 답한 값은 지어내지 않고 사람 검수로 보냅니다.
  // 가격을 추측해 넣으면 카드에 잘못된 금액이 그대로 노출됩니다.
  if (extracted.finalPrice === null) {
    return {
      ok: false,
      detail: '실제 지불 금액을 확인할 수 없습니다. 원문에서 가격을 확인해 주세요.',
      candidate: extracted,
    };
  }

  /*
    종료일을 못 찾은 것과 "상시 진행"은 다릅니다.
    구분 없이 null 로 두면 언제 끝날지 모르는 특가를 "상시 진행"이라 단언하게 되고,
    이미 끝난 혜택이 목록에 영원히 남습니다.

    그렇다고 통째로 버리면 실제 수집원(커뮤니티 핫딜 글)은 마감일을 적지 않는 것이
    보통이라 거의 아무것도 남지 않습니다. 날짜를 지어내지 않으면서 모른다고
    표시하고, 오래된 항목은 `--prune-after` 가 정리하도록 맡깁니다.
  */
  const deadlineUnknown = extracted.endDateKind === 'unknown';

  if (extracted.endDateKind === 'dated' && extracted.endDate === null) {
    return {
      ok: false,
      detail: 'endDateKind 가 dated 인데 endDate 가 비어 있습니다.',
      candidate: extracted,
    };
  }

  const startAt =
    toKstIso(extracted.startDate) ??
    // 시작일이 없으면 "이미 진행 중"으로 봅니다. 수집 시각을 쓰면
    // 실행할 때마다 값이 바뀌므로, 기존 항목의 시작일을 유지할 수 있게 날짜만 씁니다.
    `${toKstDay(options.now)}T00:00:00${KST_OFFSET}`;

  // always 면 상시 진행(null), unknown 이면 미상(null), dated 면 그 날짜의 끝.
  const endAt =
    extracted.endDateKind === 'always' || deadlineUnknown
      ? null
      : toKstIso(extracted.endDate, true);

  const benefit = pickBenefit(extracted);

  const linkUrl = pickLinkUrl(extracted.linkUrl, raw.url, raw.text);

  const candidate: Deal = {
    id: options.existing?.id ?? makeStableId(raw.sourceId, raw.url),
    slug: options.existing?.slug ?? makeSlug(raw.sourceId, raw.url, `${raw.sourceId}:${raw.url}`),
    title: extracted.title.trim(),
    summary: extracted.summary.trim(),
    ...(extracted.description.trim() ? { description: extracted.description.trim() } : {}),
    brand: { name: extracted.brandName.trim() },
    category: extracted.category,
    dealType: extracted.dealType,
    difficulty: extracted.difficulty,
    price: {
      ...(extracted.originalPrice !== null ? { original: extracted.originalPrice } : {}),
      final: extracted.finalPrice,
      currency: 'KRW',
    },
    limit: {
      firstComeFirstServed: extracted.firstComeFirstServed,
      ...(extracted.quantity !== null ? { quantity: extracted.quantity } : {}),
      ...(extracted.perPersonLimit !== null ? { perPersonLimit: extracted.perPersonLimit } : {}),
    },
    period: { startAt, endAt, ...(deadlineUnknown ? { deadlineUnknown: true } : {}) },
    ...(benefit ? { benefit } : {}),
    link: {
      url: linkUrl,
      ...(extracted.linkLabel?.trim() ? { label: extracted.linkLabel.trim() } : {}),
    },
    ...(extracted.howTo.length > 0 ? { howTo: extracted.howTo } : {}),
    ...(extracted.caution.length > 0 ? { caution: extracted.caution } : {}),
    tags: dedupeTags(extracted.tags),
    source: {
      name: raw.sourceName,
      url: raw.url,
      collectedAt: raw.collectedAt,
      method: 'llm',
      confidence: extracted.confidence,
    },
    meta: {
      // 자동 수집분은 사람이 확인하기 전까지 verified 가 아닙니다.
      verified: false,
      updatedAt: nowIso,
    },
  };

  const result = safeParseDeal(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, detail: issues, candidate };
  }

  return { ok: true, deal: candidate };
}

/**
 * 이 혜택의 값어치를 정합니다.
 *
 * 종류가 달라도 **하나의 축으로 비교**할 수 있어야 "큰 혜택"을 골라낼 수 있습니다.
 * 그래서 두 경로를 하나로 모읍니다.
 *
 *   - 캐시백·포인트·증정: 모델이 원문에서 읽은 금액 (price 로는 표현 불가)
 *   - 할인: 정가 − 실지불액 (모델이 굳이 다시 적을 필요 없음)
 *
 * 이걸 두기 전에는 카드 캐시백 87만원짜리가 `original: null, final: 0` 이라
 * 절약액 0원으로 계산됐습니다. 값이 제목 문자열에만 남아
 * 정렬에도 필터에도 쓰이지 못했습니다.
 */
function pickBenefit(extracted: ExtractedDeal): DealBenefit | null {
  if (extracted.benefitAmount !== null && extracted.benefitAmount > 0) {
    const base = extracted.benefitBaseAmount;
    // 기본이 상한보다 크면 둘 중 하나를 잘못 읽은 것이니 버립니다.
    const usableBase =
      extracted.benefitIsMax && base !== null && base > 0 && base <= extracted.benefitAmount
        ? base
        : undefined;

    return {
      amount: extracted.benefitAmount,
      isMax: extracted.benefitIsMax,
      ...(usableBase !== undefined ? { baseAmount: usableBase } : {}),
    };
  }

  // 할인은 가격에서 계산합니다. 모델이 적지 않아도 값이 나옵니다.
  const original = extracted.originalPrice;
  const final = extracted.finalPrice;
  if (original !== null && final !== null && original > final) {
    // 계산으로 나온 값은 조건부가 아니라 확정입니다.
    return { amount: original - final, isMax: false };
  }

  return null;
}

/**
 * CTA 가 가리킬 주소를 정합니다.
 *
 * 모델이 준 URL 은 **원문에 실제로 등장할 때만** 씁니다.
 * 링크는 사용자가 직접 눌러 다른 사이트로 이동하는 값이라, 지어낸 주소가 끼면
 * 죽은 링크나 엉뚱한 페이지로 보내게 됩니다. 스키마 검증으로는 잡히지 않습니다
 * (형식이 유효한 URL 이면 통과하니까요).
 *
 * 근거를 못 찾으면 원문 글 주소로 돌아갑니다. 정보가 조금 줄 뿐 항상 유효합니다.
 */
function pickLinkUrl(fromModel: string | null, fallback: string, sourceText: string): string {
  if (!fromModel) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(fromModel);
  } catch {
    return fallback;
  }

  /*
    https 만 받습니다. 우리가 원문에서 직접 얻은 주소는 이미 https 라
    http 가 나왔다는 것은 모델이 손댔다는 뜻입니다. 화면에 그대로 나가면
    "외부 링크는 모두 https" 규칙도 깨집니다.
  */
  if (parsed.protocol !== 'https:') return fallback;

  /*
    경로 없는 루트 주소는 근거가 될 수 없습니다.
    호스트만 대조하게 되어 본문에 사이트 이름이 한 번 스치기만 해도 통과합니다.
    실제로 서울문화포털 행사 글이 본문에 예약 사이트를 언급했다는 이유로
    링크가 `http://yeyak.seoul.go.kr/` 로 바뀌어 나갔습니다.
  */
  const path = parsed.pathname.replace(/\/$/, '');
  if (path === '') return fallback;

  // 원문이 같은 주소를 담고 있는지 확인합니다.
  // 프로토콜·트래킹 파라미터가 다를 수 있어 호스트+경로로 대조합니다.
  if (sourceText.includes(`${parsed.host}${path}`)) return fromModel;

  return fallback;
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= 12) break;
  }

  return result;
}

function toKstDay(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
