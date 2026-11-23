// Flat ESLint config. Determinism rules (design section 2, requirement A5):
// engine code never reads wall-clock time or platform randomness directly.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const bannedClockAndRandom = [
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message: 'Use the injected Clock (A5). Date.now is banned in engine code.',
  },
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'Use the injected Clock (A5). new Date is banned in engine code.',
  },
  {
    selector: "MemberExpression[object.name='performance'][property.name='now']",
    message: 'Use the injected scheduler (A5). performance.now is banned in engine code.',
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message: 'Use the injected Random (R10.2). Math.random is banned.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'docs/api/**',
      '.kiro/**',
      '**/*.d.ts',
      'scripts/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Source code of every package: no wall clock, no Math.random.
    files: ['packages/*/src/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...bannedClockAndRandom] },
  },
  {
    // The only places allowed to touch the platform clock: the default Clock.
    files: ['packages/core/src/ops/clock.ts', 'packages/testing/src/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
);
