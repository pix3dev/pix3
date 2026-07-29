import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import lit from 'eslint-plugin-lit';
import litA11y from 'eslint-plugin-lit-a11y';

/**
 * Rules shared by every TypeScript block. Kept in one place so the editor app, the runtime package
 * and the collab server are held to the same standard — they were not, until the packages were
 * brought under lint.
 */
const typescriptRules = {
  ...tseslint.configs.recommended.rules,
  'prettier/prettier': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/explicit-function-return-type': 'off',
  '@typescript-eslint/explicit-module-boundary-types': 'off',

  // A tree walk that seeds its cursor with `this` is the idiom throughout the node classes
  // (`getNodeByPath`, ancestor lookups), and a closure that captures the instance needs a name.
  // Neither is the bug this rule exists to catch, so name the ones we mean rather than
  // sprinkling disable comments.
  '@typescript-eslint/no-this-alias': [
    'error',
    { allowDestructuring: true, allowedNames: ['current', 'root', 'node', 'runner', 'lastContext'] },
  ],

  // An empty interface is a deliberate declaration-merging seam here: `SceneNodeNames` is
  // augmented by the editor with the current scene's node names and stays empty everywhere else.
  '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],

  // Base rules TypeScript supersedes. `no-undef` does not know browser or Node globals, and
  // `no-redeclare` reads a function's overload signatures as duplicate declarations.
  'no-undef': 'off',
  'no-redeclare': 'off',
};

export default [
  {
    // Global. A per-block `ignores` only narrows that block, so without this the recommended
    // config below still parses these with the default parser — and template payloads are
    // TypeScript that compiles against the runtime import map, not against this repo.
    ignores: [
      'dist/**',
      'node_modules/**',
      '**/dist/**',
      '**/node_modules/**',
      'src/templates/projects/*/files/**',
    ],
  },
  js.configs.recommended,
  {
    // The runtime package is in the root tsconfig's `include`, so typed linting covers it from
    // here. The collab server has its own tsconfig and gets its own block below.
    files: [
      'src/**/*.ts',
      'src/**/*.js',
      'packages/pix3-runtime/src/**/*.ts',
      'packages/pix3-runtime/src/**/*.js',
    ],
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
      ...typescriptRules,

      // Lit-specific rules
      'lit/no-invalid-html': 'error',
      'lit/no-useless-template-literals': 'error',
      'lit-a11y/click-events-have-key-events': 'off',
      'lit-a11y/anchor-is-valid': 'error',
    },
  },
  {
    // The collab server is Node, not the browser, and compiles against its own tsconfig — so it
    // needs its own block rather than a wider glob on the one above. No Lit rules apply here.
    files: ['packages/pix3-collab-server/src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: './packages/pix3-collab-server/tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier,
    },
    rules: typescriptRules,
  },
];
