import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * .env 로더
 * ---------------------------------------------------------------------------
 * 파이프라인 CLI 는 `tsx` 로 직접 실행되어 Astro 의 env 로딩을 타지 않습니다.
 * `.env` 에 키를 넣어도 `process.env` 에는 들어오지 않으므로 여기서 직접 읽습니다.
 *
 * **이미 설정된 환경변수를 덮어쓰지 않습니다.**
 * CI 는 시크릿을 환경변수로 직접 주입하는데, 저장소에 남은 `.env` 가
 * 그 값을 덮어쓰면 원인을 찾기 어려운 사고가 납니다.
 * (`.env` 는 .gitignore 로 막혀 있지만, 로컬에서 CI 를 흉내 낼 때도 마찬가지입니다.)
 */

export interface LoadEnvResult {
  /** 실제로 채워 넣은 키 이름 */
  applied: string[];
  /** 이미 환경변수에 있어 건너뛴 키 이름 */
  skipped: string[];
  /** 파일을 찾았는지 */
  found: boolean;
}

/** `KEY=value` 한 줄을 파싱합니다. 주석·빈 줄·따옴표를 처리합니다. */
export function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  // `export KEY=value` 형태도 허용
  const withoutExport = trimmed.replace(/^export\s+/, '');

  const separator = withoutExport.indexOf('=');
  if (separator <= 0) return null;

  const key = withoutExport.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = withoutExport.slice(separator + 1).trim();

  // 따옴표로 감싼 값은 벗겨 내고, 그렇지 않으면 줄 끝 주석을 잘라냅니다.
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  if (quoted) {
    value = quoted[2] ?? '';
  } else {
    const comment = value.indexOf(' #');
    if (comment !== -1) value = value.slice(0, comment).trim();
  }

  return { key, value };
}

export function parseEnvFile(contents: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const line of contents.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) entries.set(parsed.key, parsed.value);
  }

  return entries;
}

/**
 * `.env` 를 읽어 비어 있는 환경변수만 채웁니다.
 * 파일이 없으면 조용히 넘어갑니다(CI 에서는 정상 상황).
 */
export function loadEnvFile(
  filePath: string = path.resolve(process.cwd(), '.env'),
  target: NodeJS.ProcessEnv = process.env,
): LoadEnvResult {
  let contents: string;

  try {
    contents = readFileSync(filePath, 'utf8');
  } catch {
    return { applied: [], skipped: [], found: false };
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of parseEnvFile(contents)) {
    // 빈 값은 "설정하지 않음"으로 봅니다. 빈 문자열을 넣으면
    // 코드의 기본값 폴백(`?? 기본값`)이 동작하지 않습니다.
    if (value === '') continue;

    if (target[key] !== undefined && target[key] !== '') {
      skipped.push(key);
      continue;
    }

    target[key] = value;
    applied.push(key);
  }

  return { applied, skipped, found: true };
}
