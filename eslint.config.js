import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/**
 * ESLint Flat Config — 줍딜(JubDeal)
 * CI에서 `npm run lint` 로 실행되며, 실패 시 배포가 차단됩니다.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'out/**',
      'build/**',
      '.astro/**',
      'coverage/**',
      'node_modules/**',
      '*.d.ts',
      // 저장소 루트의 일회성 스크립트. .gitignore 와 같은 이유입니다 —
      // 조사용 탐침 파일이 루트에 남아 lint 를 깨뜨리는 일이 반복됐습니다.
      // 이 저장소의 스크립트는 scripts/ 아래에 둡니다.
      // flat config 의 ignores 는 루트 기준이며 `/` 접두사를 쓰지 않습니다.
      '*.mjs',
      '*.cjs',
      '*.js',
      '*.ts',
      '!astro.config.mjs',
      '!eslint.config.js',
      '!vitest.config.ts',
      '!vitest.setup.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs['flat/recommended'],

  // 공통 언어 옵션
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },

  // React 아일랜드 컴포넌트 (접근성 규칙 포함)
  {
    files: ['**/*.{jsx,tsx}'],
    ...jsxA11y.flatConfigs.recommended,
    languageOptions: {
      ...jsxA11y.flatConfigs.recommended.languageOptions,
      globals: globals.browser,
    },
  },

  // 테스트 파일
  {
    files: ['tests/**/*.{ts,tsx}', '**/*.{test,spec}.{ts,tsx}', 'vitest.setup.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // 설정 파일
  {
    files: ['*.config.{js,mjs,ts}', 'scripts/**/*.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-console': 'off',
    },
  },
);
