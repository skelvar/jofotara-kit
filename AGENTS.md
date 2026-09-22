# jofotara-kit

- Node >= 22.18, TypeScript with native type stripping (`.ts` import specifiers, `erasableSyntaxOnly`).
- `npm test` — node:test runs `test/**/*.test.ts` directly from source.
- `npm run typecheck` / `npm run build` (tsc → `dist/`, rewrites `.ts` imports to `.js`).
- Rules live in `src/rules.ts` (id, severity, confidence, title, fix); checks in `src/validate.ts`.
  Every new rule needs a confidence level: verified / reported / inferred.
- `src/templates.ts` is the production-accepted shape; the sample invoice and credit note must validate with zero findings.
- Never add real tax numbers, TSPs, Client-Ids or Secret-Keys to fixtures.
