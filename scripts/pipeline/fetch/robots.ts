/**
 * robots.txt 파서 (수집 예절)
 * ---------------------------------------------------------------------------
 * 남의 서버를 긁는 이상 robots.txt 는 지켜야 합니다.
 * 표준(REP, RFC 9309)의 핵심만 구현합니다:
 *  - User-agent 그룹 매칭 (정확 일치 우선, 없으면 `*`)
 *  - Allow / Disallow, 최장 일치 우선, 동률이면 Allow 우선
 *  - `*` 와 `$` 와일드카드
 *  - Crawl-delay (초)
 *
 * 파싱에 실패하거나 robots.txt 를 못 읽으면 **허용**으로 간주합니다.
 * (표준 동작이며, 없는 파일을 이유로 수집을 막으면 오탐이 큽니다.)
 */

export interface RobotsRule {
  /** 정규화된 경로 패턴 */
  pattern: string;
  allow: boolean;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySec?: number;
}

export interface RobotsTxt {
  groups: RobotsGroup[];
}

/** robots.txt 본문을 파싱합니다. */
export function parseRobotsTxt(body: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // 연속된 User-agent 줄은 하나의 그룹을 공유합니다.
  let acceptingAgents = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!current || !acceptingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        acceptingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    acceptingAgents = false;

    if (field === 'allow' || field === 'disallow') {
      // 빈 Disallow 는 "전체 허용"을 뜻하므로 규칙으로 만들지 않습니다.
      if (field === 'disallow' && value === '') continue;
      current.rules.push({ pattern: value, allow: field === 'allow' });
      continue;
    }

    if (field === 'crawl-delay') {
      const delay = Number.parseFloat(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelaySec = delay;
    }
  }

  return { groups };
}

/**
 * 우리 User-Agent 에 해당하는 그룹을 고릅니다 (정확 일치 > `*`).
 *
 * 같은 User-agent 토큰이 파일 안에 여러 번 등장하면 **모든 그룹의 규칙을 합칩니다.**
 * 첫 번째 그룹만 쓰면 뒤쪽 그룹의 Disallow 가 통째로 무시되어,
 * 차단된 경로를 긁게 됩니다 (RFC 9309 는 같은 토큰의 규칙을 병합하도록 규정).
 */
export function selectGroup(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();

  // 가장 길게 일치하는 토큰을 먼저 찾습니다.
  let bestToken: string | null = null;
  for (const group of robots.groups) {
    for (const agent of group.agents) {
      if (agent === '*') continue;
      if (ua.startsWith(agent) && (bestToken === null || agent.length > bestToken.length)) {
        bestToken = agent;
      }
    }
  }

  const token = bestToken ?? '*';
  const matching = robots.groups.filter((group) => group.agents.includes(token));
  if (matching.length === 0) return null;

  // 같은 토큰을 가진 그룹이 여러 개면 규칙과 Crawl-delay 를 병합합니다.
  return {
    agents: [token],
    rules: matching.flatMap((group) => group.rules),
    crawlDelaySec: matching.reduce<number | undefined>(
      (max, group) =>
        group.crawlDelaySec === undefined ? max : Math.max(max ?? 0, group.crawlDelaySec),
      undefined,
    ),
  };
}

/**
 * robots 패턴과 URL 경로의 퍼센트 인코딩 표현을 맞춥니다.
 *
 * robots.txt 에 `Disallow: /비밀` 처럼 원문이 적혀 있고 URL 은 `/%EB%B9%84%EB%B0%80`
 * 로 인코딩되어 오면(또는 그 반대), 문자열 비교가 그대로는 빗나가 차단된 경로를 긁습니다.
 * 양쪽을 디코드한 형태로 통일해 비교합니다.
 */
export function normalizePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // 잘못된 인코딩(단독 %)이면 원문 그대로 비교합니다.
    return value;
  }
}

/** robots 패턴이 경로에 매칭되는지 (`*`, `$` 지원) */
export function matchesPattern(rawPattern: string, rawPath: string): boolean {
  const pattern = normalizePath(rawPattern);
  const path = normalizePath(rawPath);

  if (pattern === '') return false;

  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;

  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const source = `^${escaped}${anchoredEnd ? '$' : ''}`;

  try {
    return new RegExp(source).test(path);
  } catch {
    return false;
  }
}

/**
 * 해당 경로를 가져와도 되는지 판단합니다.
 * 최장 일치 우선, 길이가 같으면 Allow 우선 (표준 규칙).
 */
export function isAllowed(robots: RobotsTxt | null, userAgent: string, url: string): boolean {
  if (!robots) return true;

  const group = selectGroup(robots, userAgent);
  if (!group || group.rules.length === 0) return true;

  let path: string;
  try {
    const parsed = new URL(url);
    path = parsed.pathname + parsed.search;
  } catch {
    return true;
  }

  let decision: { allow: boolean; length: number } | null = null;

  for (const rule of group.rules) {
    if (!matchesPattern(rule.pattern, path)) continue;

    const length = rule.pattern.length;
    if (
      !decision ||
      length > decision.length ||
      (length === decision.length && rule.allow && !decision.allow)
    ) {
      decision = { allow: rule.allow, length };
    }
  }

  return decision ? decision.allow : true;
}

/** robots.txt 가 지정한 크롤 지연(ms). 없으면 null. */
export function getCrawlDelayMs(robots: RobotsTxt | null, userAgent: string): number | null {
  if (!robots) return null;
  const group = selectGroup(robots, userAgent);
  if (!group || group.crawlDelaySec === undefined) return null;
  return Math.round(group.crawlDelaySec * 1000);
}
