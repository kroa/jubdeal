import { createHash } from 'node:crypto';
import type { Deal } from '@/types/deal';
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

  // 종료일을 못 찾은 것과 "상시 진행"은 다릅니다.
  // 구분 없이 null 로 두면 이미 끝난 혜택이 목록에 영원히 남습니다.
  if (extracted.endDateKind === 'unknown') {
    return {
      ok: false,
      detail: '종료일을 확인할 수 없습니다. 상시 진행인지 특정 마감일이 있는지 확인해 주세요.',
      candidate: extracted,
    };
  }

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

  // always 면 상시 진행(null), dated 면 그 날짜의 끝.
  const endAt = extracted.endDateKind === 'always' ? null : toKstIso(extracted.endDate, true);

  const linkUrl = pickLinkUrl(extracted.linkUrl, raw.url);

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
    period: { startAt, endAt },
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

/** 모델이 준 링크가 쓸 만하면 그것을, 아니면 원문 URL 을 씁니다. */
function pickLinkUrl(fromModel: string | null, fallback: string): string {
  if (!fromModel) return fallback;

  try {
    const { protocol } = new URL(fromModel);
    if (protocol === 'http:' || protocol === 'https:') return fromModel;
  } catch {
    /* 무시하고 폴백 */
  }
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
