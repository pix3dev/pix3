import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import lit from 'eslint-plugin-lit';
import litA11y from 'eslint-plugin-lit-a11y';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'src/**/*.js'],
    // Template payloads are copied into user projects verbatim — they compile
    // against the runtime import map, not this repo's tsconfig project.
    ignores: ['dist/**', 'node_modules/**', 'src/templates/projects/*/files/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        queueMicrotask: 'readonly',
        CustomEvent: 'readonly',
        FileSystemHandleKind: 'readonly',
        DataTransferItemList: 'readonly',
        DragEvent: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        Event: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier,
      lit,
      'lit-a11y': litA11y,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'prettier/prettier': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-undef': 'off', // Turn off base no-undef as it doesn't understand browser globals
      
      // Lit-specific rules
      'lit/no-invalid-html': 'error',
      'lit/no-useless-template-literals': 'error',
      'lit-a11y/click-events-have-key-events': 'off',
      'lit-a11y/anchor-is-valid': 'error',
    },
  },
];