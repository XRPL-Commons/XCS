// The indexer's lint has exactly one rule: a relative import must carry an
// explicit `.js` (or `.json`) extension. `tsconfig.json` overrides the base
// NodeNext pair with `Preserve`/`Bundler` so `#db/*` can reach the shared `db/`
// folder (see the comment there), and Bundler resolution stops TypeScript from
// enforcing the extension. The extension is still required at runtime: `dev`
// runs `tsx watch` and `start` runs the ESM output under Node, both of which
// resolve relative specifiers literally. A `no-restricted-syntax` selector
// expresses this without pulling in an import-resolution plugin; only the
// TypeScript parser is added, because espree cannot parse `.ts`.
import tsParser from '@typescript-eslint/parser'

const relativeWithoutExtension = '[source.value=/^\\.{1,2}\\//]:not([source.value=/\\.(js|json)$/])'
const message =
  'Relative imports must carry an explicit ".js" extension: tsx and Node resolve them literally at runtime.'

export default [
  { ignores: ['dist/**', 'coverage/**'] },
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `ImportDeclaration${relativeWithoutExtension}`, message },
        { selector: `ExportNamedDeclaration${relativeWithoutExtension}`, message },
        { selector: `ExportAllDeclaration${relativeWithoutExtension}`, message },
        { selector: `ImportExpression${relativeWithoutExtension}`, message },
      ],
    },
  },
]
