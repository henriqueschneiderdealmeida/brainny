import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      'no-console': 'error', // REG-3: enforce Pino-only logging
    },
  },
  {
    // Allow console in scripts and config files
    files: ['scripts/**', 'drizzle.config.ts', 'eslint.config.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Test files: relax unsafe rules — mocks and inject() return loosely-typed values
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'src/db/migrations/**'],
  },
);
