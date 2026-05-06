import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import pickle from './eslint-plugin-pickle/index.js';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { pickle },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      complexity: ['error', { max: 15 }],
      'max-lines-per-function': ['error', { max: 120, skipBlankLines: true, skipComments: true }],
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'preserve-caught-error': 'off',
      'pickle/no-raw-state-write': 'error',
      'pickle/cli-guard-basename': 'error',
      'pickle/hook-decision-values': 'error',
      'pickle/no-unsafe-error-cast': 'error',
      'pickle/no-gemini-path': 'error',
      'pickle/no-deployed-file-edit': 'error',
      'pickle/require-number-validation': 'error',
      'pickle/no-process-exit-in-library': 'error',
      'pickle/promise-token-format': 'error',
      'pickle/no-sync-in-async': 'warn',
      'pickle/spawn-error-handler': 'error',
      'pickle/no-hardcoded-timeout': 'error',
      'pickle/no-bare-convergence-history': 'error',
    },
  },
  {
    files: ['src/services/dot-builder.ts'],
    rules: {
      'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['src/bin/microverse-runner.ts'],
    rules: {
      'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
      complexity: ['error', { max: 25 }],
    },
  },
  {
    files: [
      'src/bin/council-publish.ts',
      'src/bin/log-commit.ts',
      'src/bin/log-watcher.ts',
      'src/bin/monitor.ts',
      'src/bin/mux-runner.ts',
      'src/bin/pipeline-runner.ts',
      'src/bin/raw-morty.ts',
      'src/bin/refinement-watcher.ts',
      'src/bin/spawn-gate-remediator.ts',
      'src/bin/standup.ts',
      'src/bin/status.ts',
      'src/services/adapter-preflight.ts',
    ],
    rules: {
      complexity: ['error', { max: 160 }],
      'max-lines-per-function': ['error', { max: 650, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['src/services/citadel/sibling-auth-audit.ts'],
    rules: {
      complexity: ['error', { max: 18 }],
    },
  },
  {
    ignores: ['bin/**', 'services/**', 'tests/**', '*.js', 'eslint.config.js', 'eslint-plugin-pickle/**'],
  },
);
