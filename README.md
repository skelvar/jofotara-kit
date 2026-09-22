# jofotara-kit

**The JoFotara sandbox that doesn't exist — plus a validator and an AI agent skill.**

JoFotara (فوترة, Jordan's ISTD e-invoicing system) has no test environment. The only way to
see if your XML is right is to send a real invoice with real credentials and create a real
tax record. `jofotara-kit` lets you get the shape right locally first:

- **`validate`** — lints JoFotara UBL 2.1 XML against rules learned from a production
  integration: 9-decimal amounts, `currencyID="JO"`, numeric ICV, type codes, totals math,
  credit-note references, element order, and more. Every finding says how to fix it.
- **`serve`** — a local mock of `POST /core/invoices/`: same path, same `Client-Id` /
  `Secret-Key` headers, same `{"invoice": base64}` body, `EINV_STATUS` / `EINV_RESULTS` /
  `EINV_QR`-shaped responses. It remembers what it accepted, so duplicate submissions and
  credit notes against unknown originals are rejected.
- **`template`** — prints a sales invoice (388) or credit note (381) in the exact shape the
  live API accepted.
- **Agent skill** — teaches Claude Code, Cursor, Devin, Codex & co. how JoFotara works and
  makes them validate their own output instead of guessing.

> Not affiliated with the Income and Sales Tax Department. Passing `jofotara-kit` means
> "passes known rules", not "accepted by ISTD".

## Quick start

```bash
npx jofotara-kit template invoice > invoice.xml
npx jofotara-kit validate invoice.xml
npx jofotara-kit serve --port 8080
```

Then point your integration's base URL at `http://127.0.0.1:8080` instead of
`https://backend.jofotara.gov.jo`. Nothing else changes.

```bash
curl -s http://127.0.0.1:8080/core/invoices/ \
  -H "Client-Id: test" -H "Secret-Key: test" -H "Content-Type: application/json" \
  -d "$(npx jofotara-kit template invoice --body)"
```

## Install the agent skill

```bash
npx skills add skelvar/jofotara-kit
```

Or copy [`skills/jofotara`](skills/jofotara) into your agent's skills folder
(`.claude/skills/`, `.devin/skills/`, `.cursor/skills/`, …).

## Commands

| Command | What it does |
|---|---|
| `validate [files...] [--json]` | Validate XML, a `{"invoice": base64}` request body, or bare base64. Reads stdin if no files. Exit 1 on errors. |
| `serve [--port] [--host] [--client-id] [--secret-key] [--reject-status]` | Run the mock. With `--client-id/--secret-key` only those credentials pass. `--reject-status 200` tests "HTTP 200 but rejected" handling. |
| `template <invoice\|credit-note\|income-invoice\|income-credit-note> [--body]` | Print a sample XML, or its JSON request body. |
| `rules [--json]` | List every rule. |

Mock extras: `GET /_kit/invoices` lists accepted documents, `DELETE /_kit/invoices` resets.
Mock responses add a `JOFOTARA_KIT` key with full findings and fixes; everything else mirrors
the real response shape. The mock QR decodes to `JOFOTARA-KIT MOCK|NOT A TAX DOCUMENT|…`.

## Use in CI

```bash
# have your test suite write the XML your integration generates to out/, then:
npx jofotara-kit validate out/*.xml
```

Or as a library:

```ts
import { validate } from 'jofotara-kit';

const report = validate(xml);
if (!report.ok) throw new Error(report.findings.map((f) => `${f.rule}: ${f.message}`).join('\n'));
```

## Confidence levels

JoFotara publishes no validator, so every rule states where it comes from:

| Confidence | Meaning |
|---|---|
| `verified` | The passing shape/value was accepted by the live API in production. |
| `reported` | Documented by other integrators or SDKs, not observed first-hand. |
| `inferred` | Follows from UBL 2.1 or common sense; not confirmed against the live API. |

Run `npx jofotara-kit rules` for the full list.

## Scope

Sales invoices (388, `012` cash / `022` receivable), income invoices (388/`011`, no VAT),
and their credit notes (381) — full, partial and multiple returns, with cross-track checks.
All in JOD. Special sales (`013`/`023`) and income receivable (`021`) are not covered yet.

## Contributing

The most valuable contribution is **a real JoFotara rejection the kit didn't predict** —
the XML (redacted: tax numbers, names, TSP) and the response body. That is how `inferred`
rules become `verified`. Never share your Client-Id or Secret-Key.

```bash
npm install
npm test
npm run build
```

## License

MIT
