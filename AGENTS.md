# jofotara-kit

- Node >= 22.18, TypeScript with native type stripping (`.ts` import specifiers, `erasableSyntaxOnly`).
- `npm test` — node:test runs `test/**/*.test.ts` directly from source.
- `npm run typecheck` / `npm run build` (tsc → `dist/`, rewrites `.ts` imports to `.js`).
- Rules live in `src/rules.ts` (id, severity, confidence, source, title, fix); checks in `src/validate.ts`.
  Every rule needs a source: `manual` + page of the ISTD technical guide v1.4, `verified` (live response), or `inferred`.
- `src/templates.ts` follows the manual's shapes; every template must validate with zero findings.
- The kit is public: never reference private projects, customers or their data in code, docs, tests or commits.
- Never add real tax numbers, TSPs, Client-Ids or Secret-Keys to fixtures.
