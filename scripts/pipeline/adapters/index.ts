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

  const root = selector ? $(selector) : $('body');
  const target = root.length > 0 ? root : $('body');

  return normalizeWhitespace(target.text());
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
        detailUrl = new URL(href, source.url).href;
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
    let budget = fetchBudgetFor(source.maxItems);

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
        url = new URL(href, source.url).href;
      } catch {
        continue;
      }

      // 피드 요약이 충분하면 그대로 쓰고, 짧으면 상세 페이지를 가져옵니다.
      const summaryHtml =
        node.find('content\\:encoded').first().text() ||
        node.find('content').first().text() ||
        node.find('description').first().text() ||
        node.find('summary').first().text();

      let text = normalizeWhitespace(cheerio.load(summaryHtml || '').text());

      if (text.length < 200 && isSameSite(source.url, url)) {
        budget -= 1;
        try {
          text = htmlToText(await ctx.fetchText(url), source.selectors?.detail);
        } catch (error) {
          ctx.log(`[${source.id}] 상세 페이지 실패, 요약만 사용: ${url} — ${String(error)}`);
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
