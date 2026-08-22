import { describe, expect, it } from 'vitest';
import {
  getCrawlDelayMs,
  isAllowed,
  matchesPattern,
  parseRobotsTxt,
  selectGroup,
} from '@pipeline/fetch/robots';

const UA = 'JubDealBot/1.0';

describe('parseRobotsTxt', () => {
  it('User-agent 그룹과 규칙을 읽는다', () => {
    const robots = parseRobotsTxt(`
User-agent: *
Disallow: /admin
Allow: /admin/public
Crawl-delay: 2
    `);

    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]?.agents).toEqual(['*']);
    expect(robots.groups[0]?.rules).toEqual([
      { pattern: '/admin', allow: false },
      { pattern: '/admin/public', allow: true },
    ]);
    expect(robots.groups[0]?.crawlDelaySec).toBe(2);
  });

  it('주석과 빈 줄을 무시한다', () => {
    const robots = parseRobotsTxt('# 주석\n\nUser-agent: *  # 뒤 주석\nDisallow: /x\n');
    expect(robots.groups[0]?.rules).toEqual([{ pattern: '/x', allow: false }]);
  });

  it('연속된 User-agent 줄은 하나의 그룹을 공유한다', () => {
    const robots = parseRobotsTxt('User-agent: a\nUser-agent: b\nDisallow: /p\n');

    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]?.agents).toEqual(['a', 'b']);
  });

  it('빈 Disallow 는 규칙으로 만들지 않는다 (전체 허용을 뜻함)', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow:\n');
    expect(robots.groups[0]?.rules).toEqual([]);
  });

  it('알 수 없는 필드는 무시한다', () => {
    const robots = parseRobotsTxt('User-agent: *\nSitemap: https://x/y.xml\nDisallow: /a\n');
    expect(robots.groups[0]?.rules).toHaveLength(1);
  });
});

describe('selectGroup', () => {
  const robots = parseRobotsTxt(`
User-agent: *
Disallow: /all

User-agent: JubDealBot
Disallow: /ours
  `);

  it('정확히 일치하는 그룹을 와일드카드보다 우선한다', () => {
    expect(selectGroup(robots, UA)?.rules[0]?.pattern).toBe('/ours');
  });

  it('일치하는 그룹이 없으면 와일드카드를 쓴다', () => {
    expect(selectGroup(robots, 'OtherBot/2.0')?.rules[0]?.pattern).toBe('/all');
  });

  it('그룹이 아예 없으면 null', () => {
    expect(selectGroup({ groups: [] }, UA)).toBeNull();
  });
});

describe('matchesPattern', () => {
  it('접두 일치', () => {
    expect(matchesPattern('/admin', '/admin/users')).toBe(true);
    expect(matchesPattern('/admin', '/public')).toBe(false);
  });

  it('* 와일드카드', () => {
    expect(matchesPattern('/a/*/c', '/a/b/c')).toBe(true);
    expect(matchesPattern('/*.pdf', '/docs/manual.pdf')).toBe(true);
  });

  it('$ 는 끝을 고정한다', () => {
    expect(matchesPattern('/a$', '/a')).toBe(true);
    expect(matchesPattern('/a$', '/ab')).toBe(false);
  });

  it('빈 패턴은 매칭하지 않는다', () => {
    expect(matchesPattern('', '/anything')).toBe(false);
  });
});

describe('isAllowed', () => {
  it('robots 가 없으면 허용한다', () => {
    expect(isAllowed(null, UA, 'https://x.com/any')).toBe(true);
  });

  it('Disallow 경로를 막는다', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /private\n');

    expect(isAllowed(robots, UA, 'https://x.com/private/a')).toBe(false);
    expect(isAllowed(robots, UA, 'https://x.com/public/a')).toBe(true);
  });

  it('더 긴 규칙이 이긴다 (Allow 예외)', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /a\nAllow: /a/b\n');

    expect(isAllowed(robots, UA, 'https://x.com/a/c')).toBe(false);
    expect(isAllowed(robots, UA, 'https://x.com/a/b/d')).toBe(true);
  });

  it('길이가 같으면 Allow 가 이긴다', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /x\nAllow: /x\n');
    expect(isAllowed(robots, UA, 'https://x.com/x')).toBe(true);
  });

  it('전체 차단(Disallow: /)을 존중한다', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /\n');
    expect(isAllowed(robots, UA, 'https://x.com/anything')).toBe(false);
  });

  it('우리 봇만 차단한 경우를 존중한다', () => {
    const robots = parseRobotsTxt(
      'User-agent: JubDealBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n',
    );

    expect(isAllowed(robots, UA, 'https://x.com/a')).toBe(false);
    expect(isAllowed(robots, 'GoodBot', 'https://x.com/a')).toBe(true);
  });

  it('쿼리스트링까지 포함해 매칭한다', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /*?print=\n');
    expect(isAllowed(robots, UA, 'https://x.com/page?print=1')).toBe(false);
  });
});

describe('getCrawlDelayMs', () => {
  it('Crawl-delay 를 ms 로 변환한다', () => {
    const robots = parseRobotsTxt('User-agent: *\nCrawl-delay: 1.5\n');
    expect(getCrawlDelayMs(robots, UA)).toBe(1500);
  });

  it('없으면 null', () => {
    expect(getCrawlDelayMs(parseRobotsTxt('User-agent: *\n'), UA)).toBeNull();
    expect(getCrawlDelayMs(null, UA)).toBeNull();
  });
});
