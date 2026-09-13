import { DEAL_SCHEMA_VERSION, type Deal, type DealsFile } from '@/types/deal';
import { canonicalizeUrl } from '@pipeline/assemble';

/**
 * 병합
 * ---------------------------------------------------------------------------
 * 규칙 (우선순위 순):
 *
 * 1. **사람이 검수한 항목(meta.verified)은 자동 수집이 덮어쓰지 않는다.**
 *    큐레이터가 고쳐 놓은 값을 크롤러가 매일 되돌려 놓으면 아무도 손대지 않게 됩니다.
 *    단 "남은 수량"처럼 시간에 따라 변하고 사람이 관리하지 않는 값은 예외로 갱신합니다.
 *
 * 2. **id 가 같으면 같은 혜택이다.** id 는 (소스 + 정규화 URL) 해시라 안정적입니다.
 *
 * 3. **id 가 달라도 링크가 같으면 같은 혜택이다.** 서로 다른 소스가 같은 이벤트를
 *    소개하는 경우를 잡아냅니다. 먼저 등록된 쪽을 유지합니다.
 *
 * 4. **기존 항목의 id·slug 는 절대 바뀌지 않는다.** 이미 공유된 URL 이 깨집니다.
 */

export interface MergeOptions {
  now: Date;
  /** 종료 후 이 일수가 지나면 목록에서 제거합니다. 0이면 제거하지 않습니다. */
  pruneAfterDays?: number;
  /**
   * 지금 켜져 있는 소스 ID 목록.
   *
   * 주면 **여기 없는 소스에서 온 항목을 제거합니다.** 소스를 껐다는 것은
   * 더 이상 그 출처를 신뢰하지 않는다는 뜻인데, 이 정리가 없으면 그 항목이
   * 갱신도 안 되고 사라지지도 않은 채 목록에 남습니다.
   *
   * 실제로 카드고릴라를 끈 뒤에도 "최대 87/90/74만원"짜리 4건이 그대로
   * 남아 있었습니다. 끄기로 한 이유가 바로 그 항목들이었는데 말입니다.
   *
   * 한 소스만 돌릴 때(`--source`)는 주지 마세요. 나머지가 통째로 지워집니다.
   */
  activeSourceIds?: readonly string[];
  /**
   * 이번 실행에서 **소스 목록에 여전히 올라와 있던** 항목.
   *
   * `incoming` 은 LLM 을 태운 것만 담습니다. 그런데 살아 있다는 증거는
   * "수집 목록에 보였다"는 사실에 있지 "우리가 LLM 을 썼다"에 있지 않습니다.
   *
   * CI 는 비용 때문에 `--max-items 20` 으로 돕니다. 124건을 수집하고 20건만
   * 처리하니, 나머지 104건은 소스에 멀쩡히 있는데도 보호를 못 받아 나이만으로
   * 잘려 나갔습니다. 실제로 한 번에 57건이 사라져 93건이 48건이 됐습니다
   * (56건이 "마감미상 + 수집 7일 초과").
   *
   * 그래서 LLM 처리 여부와 무관하게, 이번에 수집된 것 전부를 여기로 받습니다.
   */
  seenOnSourceIds?: readonly string[];
  /** 같은 목적. id 체계가 어긋난 예전 항목을 위해 원문 주소로도 봅니다. */
  seenOnSourceLinks?: readonly string[];
}

export interface MergeResult {
  file: DealsFile;
  added: Deal[];
  updated: Deal[];
  unchanged: Deal[];
  /** 오래되어 제거된 항목 */
  pruned: Deal[];
  /** verified 항목이라 갱신하지 않고 보존한 건 */
  protectedFromOverwrite: Deal[];
  /** 소스가 꺼져서 제거된 항목 */
  droppedFromDisabledSource: Deal[];
}

/**
 * id 에서 소스 ID 를 되읽습니다.
 *
 * id 형식은 `dl_<소스ID>_<16자리 해시>` 입니다(makeStableId).
 * `source.name` 은 사람이 읽는 이름이라 설정에서 이름을 바꾸면 어긋나므로
 * 안정적인 id 쪽을 씁니다.
 */
export function sourceIdFromDealId(id: string): string | null {
  const match = /^dl_(.+)_[0-9a-f]{16}$/.exec(id);
  return match?.[1] ?? null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function mergeDeals(
  existingFile: DealsFile,
  incoming: Deal[],
  options: MergeOptions,
): MergeResult {
  const byId = new Map<string, Deal>();
  const byLink = new Map<string, string>(); // 정규화 링크 → id

  for (const deal of existingFile.deals) {
    byId.set(deal.id, deal);
    byLink.set(canonicalizeUrl(deal.link.url), deal.id);
  }

  const added: Deal[] = [];
  const updated: Deal[] = [];
  const unchanged: Deal[] = [];
  const protectedFromOverwrite: Deal[] = [];

  for (const candidate of incoming) {
    // id 가 같으면 같은 혜택입니다 (id = 소스 + 정규화 URL 해시).
    // 링크만 같은 경우는 **같은 소스에서 온 것일 때만** 동일하다고 봅니다.
    // 서로 다른 소스가 같은 랜딩 URL 을 쓰는 일은 흔한데(공식 페이지를 함께 소개),
    // 그걸 무조건 덮어쓰면 기존 항목의 id·slug 아래 전혀 다른 혜택이 들어앉습니다.
    const linkedId = byLink.get(canonicalizeUrl(candidate.link.url));
    const linkedDeal = linkedId === undefined ? undefined : byId.get(linkedId);
    const sameSource = linkedDeal?.source.name === candidate.source.name;

    const existingId = byId.has(candidate.id) ? candidate.id : sameSource ? linkedId : undefined;

    if (existingId === undefined) {
      byId.set(candidate.id, candidate);
      byLink.set(canonicalizeUrl(candidate.link.url), candidate.id);
      added.push(candidate);
      continue;
    }

    const existing = byId.get(existingId);
    if (!existing) continue;

    if (existing.meta.verified) {
      const refreshed = refreshVolatileFields(existing, candidate, options.now);
      if (refreshed) {
        byId.set(existingId, refreshed);
        updated.push(refreshed);
      } else {
        unchanged.push(existing);
      }
      protectedFromOverwrite.push(existing);
      continue;
    }

    // id·slug 는 기존 값을 유지하고 나머지를 갱신합니다.
    const merged: Deal = { ...candidate, id: existing.id, slug: existing.slug };

    if (isSameContent(existing, merged)) {
      unchanged.push(existing);
      continue;
    }

    byId.set(existingId, merged);
    // 링크가 바뀌었을 수 있으므로 색인을 갱신합니다.
    // 갱신하지 않으면 다음 항목이 옛 링크로 조회해 같은 혜택을 두 건으로 만듭니다.
    byLink.set(canonicalizeUrl(merged.link.url), existingId);
    updated.push(merged);
  }

  let deals = [...byId.values()];
  const pruned: Deal[] = [];

  const pruneAfterDays = options.pruneAfterDays ?? 0;
  if (pruneAfterDays > 0) {
    const cutoff = options.now.getTime() - pruneAfterDays * MS_PER_DAY;

    /*
      이번 실행에서 소스에 여전히 올라와 있던 항목입니다.
      아직 살아 있다는 가장 확실한 증거이므로 나이와 무관하게 남깁니다.

      이 보호가 없으면 `unchanged` 로 분류된 항목이 문제가 됩니다.
      내용이 같으면 기존 항목을 그대로 두는데(diff 를 깨끗하게 유지하려고),
      그러면 collectedAt 이 "처음 본 시각"에 멈춰 있어서
      소스에 멀쩡히 있는 혜택이 오래됐다는 이유로 지워집니다.
      다음 실행에서 다시 추가되고 또 지워지기를 반복하게 됩니다.

      **LLM 을 태운 것(`incoming`)만 보면 안 됩니다.** 비용 상한
      (`--max-items`) 때문에 수집분의 일부만 LLM 을 타는데, 나머지도 소스에는
      멀쩡히 올라와 있습니다. CI 에서 124건을 수집하고 20건만 처리한 실행이
      57건을 잘라 93건을 48건으로 만들었습니다. 그래서 처리 여부와 무관하게
      **수집 목록에 보인 것 전부**를 살아 있다고 봅니다.
    */
    const seenNow = new Set([
      ...incoming.map((deal) => deal.id),
      ...(options.seenOnSourceIds ?? []),
    ]);
    const seenLinks = new Set(
      (options.seenOnSourceLinks ?? []).map((link) => canonicalizeUrl(link)),
    );

    deals = deals.filter((deal) => {
      // 사람이 검수한 항목은 자동으로 지우지 않습니다.
      // 큐레이션한 데이터가 소리 없이 사라지면 복구할 방법이 없습니다.
      if (deal.meta.verified) return true;
      if (seenNow.has(deal.id)) return true;
      // 원문 주소는 선택 필드라 없을 수 있습니다.
      const sourceUrl = deal.source.url;
      if (sourceUrl !== undefined && seenLinks.has(canonicalizeUrl(sourceUrl))) return true;

      /*
        마감일이 없는 항목은 두 종류입니다.

        - 상시 진행: 정말로 끝나지 않으므로 남깁니다.
        - 마감일 미상: 커뮤니티 핫딜은 며칠이면 죽습니다.
          소스에서 사라진 뒤로도 계속 두면 "지금 참여 가능" 목록이
          죽은 혜택으로 채워집니다. 마지막 수집 시점을 기준으로 내립니다.

        둘을 구분하지 않아 `endAt === null` 을 전부 남기고 있었고,
        그래서 마감일 미상 항목이 영원히 쌓였습니다.
      */
      if (deal.period.endAt === null) {
        if (!deal.period.deadlineUnknown) return true;

        const collected = Date.parse(deal.source.collectedAt);
        if (Number.isNaN(collected) || collected >= cutoff) return true;
        pruned.push(deal);
        return false;
      }

      const ended = Date.parse(deal.period.endAt);
      if (Number.isNaN(ended) || ended >= cutoff) return true;
      pruned.push(deal);
      return false;
    });
  }

  const droppedFromDisabledSource: Deal[] = [];
  if (options.activeSourceIds) {
    const active = new Set(options.activeSourceIds);
    deals = deals.filter((deal) => {
      const sourceId = sourceIdFromDealId(deal.id);
      // 형식을 못 읽으면 건드리지 않습니다. 지우는 쪽이 되돌릴 수 없으니까요.
      if (sourceId === null || active.has(sourceId)) return true;
      droppedFromDisabledSource.push(deal);
      return false;
    });
  }

  // 출력 순서를 안정적으로 유지해 diff 가 읽기 쉽게 합니다.
  deals.sort((a, b) => a.id.localeCompare(b.id));

  // 바뀐 게 없으면 generatedAt 도 그대로 둡니다.
  // 무조건 갱신하면 "변경 여부" 게이트가 항상 참이 되어 매일 빈 PR 이 생깁니다.
  const changed =
    added.length > 0 ||
    updated.length > 0 ||
    pruned.length > 0 ||
    droppedFromDisabledSource.length > 0;

  return {
    file: {
      // 입력 파일은 parseDealsFile 을 통과했으므로 이미 현재 버전이지만,
      // 상수를 그대로 쓰는 편이 버전을 올렸을 때 옛 값이 남을 여지를 없앱니다.
      schemaVersion: DEAL_SCHEMA_VERSION,
      generatedAt: changed ? options.now.toISOString() : existingFile.generatedAt,
      deals,
    },
    added,
    updated,
    unchanged,
    pruned,
    droppedFromDisabledSource,
    protectedFromOverwrite,
  };
}

/**
 * verified 항목에서도 갱신해야 하는 값만 골라 반영합니다.
 * 사람이 관리하지 않는 시간 의존 값(남은 수량)만 대상입니다.
 * 바뀐 게 없으면 null 을 돌려줍니다.
 */
function refreshVolatileFields(existing: Deal, incoming: Deal, now: Date): Deal | null {
  const nextRemaining = incoming.limit.remaining;
  if (nextRemaining === undefined || nextRemaining === existing.limit.remaining) return null;

  return {
    ...existing,
    limit: { ...existing.limit, remaining: nextRemaining },
    meta: { ...existing.meta, updatedAt: now.toISOString() },
  };
}

/**
 * 실질적 내용이 같은지 비교합니다.
 * 매 실행마다 바뀌는 값(updatedAt, collectedAt, confidence)은 제외해야
 * 아무것도 안 바뀐 날에도 커밋이 생기는 일을 막을 수 있습니다.
 */
export function isSameContent(a: Deal, b: Deal): boolean {
  return stableKey(a) === stableKey(b);
}

function stableKey(deal: Deal): string {
  const { meta: _meta, source, ...rest } = deal;

  return JSON.stringify({
    ...rest,
    source: { name: source.name, url: source.url, method: source.method },
  });
}
