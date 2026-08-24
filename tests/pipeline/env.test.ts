import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnvFile, parseEnvFile, parseEnvLine } from '@pipeline/env';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'jubdeal-env-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseEnvLine', () => {
  it('KEY=value 를 읽는다', () => {
    expect(parseEnvLine('FOO=bar')).toEqual({ key: 'FOO', value: 'bar' });
  });

  it('따옴표를 벗겨 낸다', () => {
    expect(parseEnvLine('FOO="bar baz"')).toEqual({ key: 'FOO', value: 'bar baz' });
    expect(parseEnvLine("FOO='bar'")).toEqual({ key: 'FOO', value: 'bar' });
  });

  it('export 접두사를 허용한다', () => {
    expect(parseEnvLine('export FOO=bar')).toEqual({ key: 'FOO', value: 'bar' });
  });

  it('주석과 빈 줄은 무시한다', () => {
    expect(parseEnvLine('# 주석')).toBeNull();
    expect(parseEnvLine('   ')).toBeNull();
  });

  it('따옴표 없는 값의 줄 끝 주석을 잘라낸다', () => {
    expect(parseEnvLine('FOO=bar # 설명')).toEqual({ key: 'FOO', value: 'bar' });
  });

  it('따옴표 안의 # 는 값으로 남긴다', () => {
    expect(parseEnvLine('FOO="bar # baz"')).toEqual({ key: 'FOO', value: 'bar # baz' });
  });

  it('값에 = 가 들어 있어도 첫 = 에서만 나눈다', () => {
    expect(parseEnvLine('URL=https://x.com/?a=1&b=2')).toEqual({
      key: 'URL',
      value: 'https://x.com/?a=1&b=2',
    });
  });

  it('키 형식이 아니면 무시한다', () => {
    expect(parseEnvLine('123=x')).toBeNull();
    expect(parseEnvLine('=value')).toBeNull();
  });
});

describe('parseEnvFile', () => {
  it('여러 줄을 읽는다', () => {
    const entries = parseEnvFile(['A=1', '# 주석', '', 'B="two"'].join('\n'));

    expect(entries.get('A')).toBe('1');
    expect(entries.get('B')).toBe('two');
    expect(entries.size).toBe(2);
  });

  it('CRLF 줄바꿈도 처리한다', () => {
    expect(parseEnvFile(['A=1', 'B=2'].join('\r\n')).get('B')).toBe('2');
  });
});

describe('loadEnvFile', () => {
  it('비어 있는 환경변수를 채운다', async () => {
    const file = path.join(dir, '.env');
    await writeFile(file, 'JUBDEAL_TEST_KEY=from-file\n');

    const target: NodeJS.ProcessEnv = {};
    const result = loadEnvFile(file, target);

    expect(result.found).toBe(true);
    expect(target.JUBDEAL_TEST_KEY).toBe('from-file');
    expect(result.applied).toContain('JUBDEAL_TEST_KEY');
  });

  it('이미 설정된 환경변수를 덮어쓰지 않는다', async () => {
    // CI 는 시크릿을 환경변수로 직접 주입합니다.
    // .env 가 그 값을 덮어쓰면 원인을 찾기 어려운 사고가 납니다.
    const file = path.join(dir, '.env');
    await writeFile(file, 'JUBDEAL_TEST_KEY=from-file\n');

    const target: NodeJS.ProcessEnv = { JUBDEAL_TEST_KEY: 'from-ci' };
    const result = loadEnvFile(file, target);

    expect(target.JUBDEAL_TEST_KEY).toBe('from-ci');
    expect(result.skipped).toContain('JUBDEAL_TEST_KEY');
  });

  it('빈 값은 설정하지 않는다', async () => {
    // 빈 문자열을 넣으면 코드의 기본값 폴백(`?? 기본값`)이 동작하지 않습니다.
    const file = path.join(dir, '.env');
    await writeFile(file, 'JUBDEAL_EMPTY=\n');

    const target: NodeJS.ProcessEnv = {};
    loadEnvFile(file, target);

    expect(target.JUBDEAL_EMPTY).toBeUndefined();
  });

  it('파일이 없으면 조용히 넘어간다', () => {
    const result = loadEnvFile(path.join(dir, 'nope.env'), {});

    expect(result.found).toBe(false);
    expect(result.applied).toEqual([]);
  });
});
