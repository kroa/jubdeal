import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import type { CollectContext, RawItem, SourceAdapter, SourceConfig } from '@pipeline/types';

/**
 * 소스 어댑터
 * ---------------------------------------------------------------------------
 * 소스마다 페이지 구조가 달라, "어디서 목록을 찾고 어디서 본문을 읽을지"만
 * 설정으로 받고 나머지 절차는 공통으로 처리합니다.
 *
 * 새 소스를 붙일 때 코드를 고칠 필요 없이 sources 설정만 추가하면 됩니다.
 */

/** 본문 텍스트 상한 — LLM 입력 비용을 통제합니다. */
export const MAX_TEXT_LENGTH = 6000;

/** HTML 에서 사람이 읽는 텍스트만 남깁니다. */
export function htmlToText(html: string, selector?: string): string {
  const $ = cheerio.load(html);

  // 본문과 무관한 요소는 통째로 제거합니다.
  $('script, style, noscript, iframe, svg, template').remove();

  if (!selector) return normalizeWhitespace($('body').text());

  const matched = $(selector);
  if (matched.length === 0) return normalizeWhitespace($('body').text());

  /*
    매칭된 요소를 전부 합치면 안 됩니다.

    게시판 소프트웨어는 본문과 댓글에 **같은 클래스**를 붙이는 일이 흔합니다.
    (XE/라이믹스의 `.xe_content`, 뽐뿌의 `.board-contents` 모두 그렇습니다.)
    합쳐 버리면 댓글이 본문으로 흘러들어, 어미새에서 실제로 관측했듯
    "100원에 구매했습니다" 같은 댓글 한 줄이 100원딜로 둔갑합니다.
    사용자에게 그대로 노출되는 값이라 조용히 넘길 수 없습니다.

    문서 순서상 본문이 댓글보다 먼저 오므로 첫 매칭만 씁니다.
    본문이 여러 블록으로 나뉜 소스라면 그 블록들을 감싸는 상위 요소를
    선택자로 지정하세요.
  */
  return normalizeWhitespace(matched.first().text());
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}

/** LLM 입력 상한에 맞춰 자릅니다. 자른 사실을 표시해 모델이 알 수 있게 합니다. */
export function clampText(text: string, max: number = MAX_TEXT_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(이하 생략)`;
}

/**
 * 목록 페이지의 링크를 따라갈 수 있는지 판단합니다.
 *
 * 목록에 있는 링크를 무조건 따라가면, 소스가 광고나 외부 링크를 섞어 두었을 때
 * 전혀 다른 호스트(심지어 내부망)를 우리가 대신 요청하게 됩니다.
 * 기본은 소스와 같은 등록 도메인으로 제한합니다.
 */
export function isSameSite(sourceUrl: string, targetUrl: string): boolean {
  try {
    const source = new URL(sourceUrl);
    const target = new URL(targetUrl);

    if (source.host === target.host) return true;

    // 서브도메인 차이는 허용합니다 (example.com <-> news.example.com).
    const base = (host: string) => host.split('.').slice(-2).join('.');
    const sourceBase = base(source.hostname);
    return sourceBase.includes('.') && sourceBase === base(target.hostname);
  } catch {
    return false;
  }
}

/**
 * 링크에서 무의미한 쿼리 파라미터를 지웁니다.
 *
 * 게시판 목록은 정렬·페이지 상태를 링크에 실어 보냅니다.
 * 그대로 두면 같은 글이 서로 다른 URL 로 보여 중복 수집되고,
 * URL 로 만드는 안정 ID 까지 흔들려 목록 정렬이 바뀔 때마다
 * 같은 혜택이 새 항목으로 다시 쌓입니다.
 */
export function stripQueryParams(url: string, params: string[] | undefined): string {
  if (!params || params.length === 0) return url;

  try {
    const parsed = new URL(url);
    for (const name of params) parsed.searchParams.delete(name);
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * 링크를 소스와 같은 스킴으로 맞춥니다. **http → https 방향으로만** 올립니다.
 *
 * https 로 옮긴 사이트가 피드·목록에는 http 주소를 그대로 뱉는 일이 흔합니다.
 * 뽐뿌는 http 로 요청하면 3xx 가 아니라
 * `<script>document.location.href='https://...'</script>` 한 줄(104바이트)을 돌려줍니다.
 * 크롤러는 JS 를 실행하지 않으니 본문 대신 그 한 줄을 받고 끝나는데,
 * HTTP 상태는 200 이고 리다이렉트도 아니라 어디서 실패했는지 드러나지 않습니다.
 *
 * 반대 방향(https → http)은 절대 하지 않습니다. 암호화를 벗기는 쪽이니까요.
 */
export function alignScheme(sourceUrl: string, targetUrl: string): string {
  try {
    const source = new URL(sourceUrl);
    const target = new URL(targetUrl);

    if (
      source.protocol === 'https:' &&
      target.protocol === 'http:' &&
      isSameSite(sourceUrl, targetUrl)
    ) {
      target.protocol = 'https:';
      return target.href;
    }

    return targetUrl;
  } catch {
    return targetUrl;
  }
}

/**
 * 상세 페이지 요청을 계속 시도할 가치가 있는지 판단하는 차단기.
 *
 * 어떤 사이트는 데이터센터 IP 를 봇으로 보고 전부 거절합니다.
 * (뽐뿌는 GitHub Actions 에서 `ppck=1` 챌린지로 리다이렉트한 뒤 403 을 줍니다.
 *  같은 요청이 가정용 회선에서는 200 이라 로컬에서는 드러나지 않습니다.)
 *
 * 그때 목록에 있는 항목마다 계속 두드리면, 실패가 뻔한 요청에
 * 레이트리밋 대기 시간(항목당 3~5초)을 그대로 태웁니다.
 * 실제 실행에서 29번을 헛되이 두드리며 90초를 버렸습니다.
 *
 * 연속으로 이만큼 실패하면 그 소스의 남은 항목은 요약만 씁니다.
 * 한두 건의 일시적 오류로 성급히 포기하지 않을 만큼은 남겨 둡니다.
 */
export const DETAIL_FAILURE_LIMIT = 3;

/**
 * 한 소스가 한 번 실행에서 보낼 수 있는 요청 수 상한.
 * maxItems 는 "수집할 항목 수"라서, 링크가 많은 목록 페이지에서
 * 상세 요청이 무한정 늘어나는 것을 막지 못합니다.
 */
export function fetchBudgetFor(maxItems: number): number {
  return maxItems * 3 + 5;
}

/* -------------------------------------------------------------------------- */
/* HTML 목록 → 상세 어댑터                                                     */
/* -------------------------------------------------------------------------- */

export const htmlAdapter: SourceAdapter = {
  kind: 'html',

  async collect(source: SourceConfig, ctx: CollectContext): Promise<RawItem[]> {
    const selectors = source.selectors;
    if (!selectors?.item) {
      throw new Error(`[${source.id}] html 어댑터에는 selectors.item 이 필요합니다.`);
    }

    const listHtml = await ctx.fetchText(source.url);
    const $ = cheerio.load(listHtml);
    const items: RawItem[] = [];
    const seen = new Set<string>();

    // 상세 요청 횟수 상한. 실패가 반복돼도 목록 길이만큼 요청이 늘지 않게 합니다.
    let budget = fetchBudgetFor(source.maxItems);

    const elements = $(selectors.item).toArray();
    ctx.log(`[${source.id}] 목록에서 ${elements.length}개 항목 발견`);

    for (const element of elements) {
      if (items.length >= source.maxItems) break;
      if (budget <= 0) {
        ctx.log(`[${source.id}] 요청 예산을 모두 사용해 중단합니다.`);
        break;
      }

      const node = $(element);
      const anchor = selectors.link ? node.find(selectors.link).first() : node;
      const href = anchor.attr('href');
      if (!href) continue;

      let detailUrl: string;
      try {
        detailUrl = stripQueryParams(
          alignScheme(source.url, new URL(href, source.url).href),
          source.stripParams,
        );
      } catch {
        continue;
      }
      if (seen.has(detailUrl)) continue;
      seen.add(detailUrl);

      if (!isSameSite(source.url, detailUrl)) {
        ctx.log(`[${source.id}] 외부 호스트 링크를 건너뜁니다: ${detailUrl}`);
        continue;
      }

      const title = selectors.title
        ? normalizeWhitespace(node.find(selectors.title).first().text())
        : normalizeWhitespace(anchor.text());

      let text: string;
      budget -= 1;
      try {
        const detailHtml = await ctx.fetchText(detailUrl);
        text = htmlToText(detailHtml, selectors.detail);
      } catch (error) {
        ctx.log(`[${source.id}] 상세 페이지 실패, 건너뜁니다: ${detailUrl} — ${String(error)}`);
        continue;
      }

      if (text.length < 40) {
        ctx.log(`[${source.id}] 본문이 너무 짧아 건너뜁니다: ${detailUrl}`);
        continue;
      }

      items.push({
        sourceId: source.id,
        sourceName: source.name,
        url: detailUrl,
        title: title || undefined,
        text: clampText(text),
        collectedAt: ctx.now.toISOString(),
      });
    }

    return items;
  },
};

/* -------------------------------------------------------------------------- */
/* RSS / Atom 어댑터                                                           */
/* -------------------------------------------------------------------------- */

export const rssAdapter: SourceAdapter = {
  kind: 'rss',

  async collect(source: SourceConfig, ctx: CollectContext): Promise<RawItem[]> {
    const xml = await ctx.fetchText(source.url);
    const $ = cheerio.load(xml, { xmlMode: true });

    const entries = $('item, entry').toArray();
    ctx.log(`[${source.id}] 피드에서 ${entries.length}개 항목 발견`);

    const items: RawItem[] = [];
    const seen = new Set<string>();
    let budget = fetchBudgetFor(source.maxItems);
    let consecutiveDetailFailures = 0;

    for (const element of entries) {
      if (items.length >= source.maxItems) break;
      if (budget <= 0) {
        ctx.log(`[${source.id}] 요청 예산을 모두 사용해 중단합니다.`);
        break;
      }

      const node = $(element);
      const title = normalizeWhitespace(node.find('title').first().text());

      // RSS 는 <link>텍스트</link>, Atom 은 <link href="...">
      const linkNode = node.find('link').first();
      const href = linkNode.attr('href') ?? normalizeWhitespace(linkNode.text());
      if (!href) continue;

      let url: string;
      try {
        url = stripQueryParams(
          alignScheme(source.url, new URL(href, source.url).href),
          source.stripParams,
        );
      } catch {
        continue;
      }
      // 피드에도 같은 글이 두 번 실리는 일이 있어 정규화 후 다시 거릅니다.
      if (seen.has(url)) continue;
      seen.add(url);

      // 피드 요약이 충분하면 그대로 쓰고, 짧으면 상세 페이지를 가져옵니다.
      const summaryHtml =
        node.find('content\\:encoded').first().text() ||
        node.find('content').first().text() ||
        node.find('description').first().text() ||
        node.find('summary').first().text();

      let text = normalizeWhitespace(cheerio.load(summaryHtml || '').text());

      const detailWorthTrying =
        text.length < 200 &&
        isSameSite(source.url, url) &&
        consecutiveDetailFailures < DETAIL_FAILURE_LIMIT;

      if (detailWorthTrying) {
        budget -= 1;
        try {
          text = htmlToText(await ctx.fetchText(url), source.selectors?.detail);
          consecutiveDetailFailures = 0;
        } catch (error) {
          consecutiveDetailFailures += 1;
          ctx.log(`[${source.id}] 상세 페이지 실패, 요약만 사용: ${url} — ${String(error)}`);

          if (consecutiveDetailFailures === DETAIL_FAILURE_LIMIT) {
            ctx.log(
              `[${source.id}] 상세 페이지가 연속 ${DETAIL_FAILURE_LIMIT}회 실패했습니다. ` +
                '이 소스는 남은 항목을 피드 요약만으로 처리합니다.',
            );
          }
        }
      }

      if (text.length < 40) continue;

      items.push({
        sourceId: source.id,
        sourceName: source.name,
        url,
        title: title || undefined,
        text: clampText(text),
        collectedAt: ctx.now.toISOString(),
      });
    }

    return items;
  },
};

/* -------------------------------------------------------------------------- */
/* fixture 어댑터 (로컬 파일 — 개발·테스트용, 네트워크 접근 없음)              */
/* -------------------------------------------------------------------------- */

export const fixtureAdapter: SourceAdapter = {
  kind: 'fixture',

  async collect(source: SourceConfig, ctx: CollectContext): Promise<RawItem[]> {
    const body = await readFile(source.url, 'utf8');
    const parsed: unknown = JSON.parse(body);

    if (!Array.isArray(parsed)) {
      throw new Error(`[${source.id}] fixture 파일은 배열이어야 합니다: ${source.url}`);
    }

    return parsed.slice(0, source.maxItems).map((entry, index) => {
      const record = entry as Record<string, unknown>;
      return {
        sourceId: source.id,
        sourceName: source.name,
        url: typeof record.url === 'string' ? record.url : `${source.url}#${index}`,
        title: typeof record.title === 'string' ? record.title : undefined,
        text: clampText(normalizeWhitespace(String(record.text ?? ''))),
        collectedAt: ctx.now.toISOString(),
      };
    });
  },
};

const ADAPTERS: SourceAdapter[] = [htmlAdapter, rssAdapter, fixtureAdapter];

export function getAdapter(kind: string): SourceAdapter {
  const adapter = ADAPTERS.find((candidate) => candidate.kind === kind);
  if (!adapter) {
    const known = ADAPTERS.map((a) => a.kind).join(', ');
    throw new Error(`알 수 없는 어댑터 종류 '${kind}'. 사용 가능: ${known}`);
  }
  return adapter;
}
