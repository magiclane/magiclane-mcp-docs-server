/**
 * SPDX-FileCopyrightText: 2025-2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierPluginRecommended from 'eslint-plugin-prettier/recommended';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';

export default [
  {
    ignores: ['**/node_modules/**', 'dist/**', 'coverage/**'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierPluginRecommended,

  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      'unused-imports': unusedImports,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          disallowTypeAnnotations: false,
        },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],
      // stdout carries the MCP protocol on the stdio transport, so a stray
      // console.log corrupts it. Library code may only write to stderr
      // (console.error / console.warn); the entry points are exempted below.
      'no-console': ['error', { allow: ['error', 'warn'] }],
      'prefer-const': 'warn',
      'prettier/prettier': 'warn',
    },
  },

  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**/*.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      'unused-imports/no-unused-vars': 'off',
    },
  },

  {
    // Process entry points legitimately print human-facing startup / shutdown
    // lines (the HTTP entry to stdout, the stdio entry to stderr).
    files: ['src/docs-server.ts', 'src/docs-server-http.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    files: ['scripts/**/*.js', 'scripts/**/*.mjs', 'scripts/**/*.cjs', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
];
