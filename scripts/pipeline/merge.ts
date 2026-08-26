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
    deals = deals.filter((deal) => {
      // 사람이 검수한 항목은 자동으로 지우지 않습니다.
      // 큐레이션한 데이터가 소리 없이 사라지면 복구할 방법이 없습니다.
      if (deal.meta.verified) return true;
      if (deal.period.endAt === null) return true;
      const ended = Date.parse(deal.period.endAt);
      if (Number.isNaN(ended) || ended >= cutoff) return true;
      pruned.push(deal);
      return false;
    });
  }

  // 출력 순서를 안정적으로 유지해 diff 가 읽기 쉽게 합니다.
  deals.sort((a, b) => a.id.localeCompare(b.id));

  // 바뀐 게 없으면 generatedAt 도 그대로 둡니다.
  // 무조건 갱신하면 "변경 여부" 게이트가 항상 참이 되어 매일 빈 PR 이 생깁니다.
  const changed = added.length > 0 || updated.length > 0 || pruned.length > 0;

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
