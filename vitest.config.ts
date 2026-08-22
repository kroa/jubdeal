import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * 유닛 테스트 전용 Vite/Vitest 설정.
 * Astro 빌드 파이프라인과 분리되어 있으며, React 아일랜드 컴포넌트와
 * 순수 도메인 로직(src/lib)을 검증합니다.
 *
 * 환경 전략:
 *  - 기본은 가벼운 `node` 환경입니다.
 *  - DOM이 필요한 컴포넌트 테스트만 파일 상단에
 *    `// @vitest-environment jsdom` 주석으로 jsdom을 켭니다.
 *    (jsdom 초기화가 느린 환경에서도 전체 실행 시간이 안정적으로 유지됩니다.)
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@pipeline': fileURLToPath(new URL('./scripts/pipeline', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.astro/**'],
    restoreMocks: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: [
        'src/lib/**/*.ts',
        'src/hooks/**/*.ts',
        'src/components/**/*.tsx',
        'src/pages/**/*.ts',
        'scripts/pipeline/**/*.ts',
      ],
      // 품질 게이트: 커버리지가 아래로 떨어지면 `npm run test:coverage` 가 실패합니다.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
