---
name: jofotara
description: Use when building, reviewing or debugging an integration with JoFotara (فوترة / نظام الفوترة الوطني, Jordan ISTD e-invoicing) — generating UBL 2.1 invoice XML, POSTing to backend.jofotara.gov.jo/core/invoices/, Client-Id/Secret-Key auth, InvoiceTypeCode 388/381 with name 012/022, ICV, income source sequence (TSP), EINV_STATUS/EINV_QR responses, credit notes/returns, or diagnosing a JoFotara rejection. Sales invoices and their credit notes.
---

# JoFotara integration

JoFotara is Jordan's mandatory e-invoicing platform (Income and Sales Tax Department, ISTD).
Every invoice is a UBL 2.1 XML document, base64-encoded, sent in one HTTP POST. The API
replies with a status and a QR string that must be printed on the invoice.

**There is no government sandbox.** Every request to the real endpoint with real credentials
creates a real tax record. Never send test invoices to production to "see what happens" —
use the local tooling below.

## Tooling — use it, don't guess

```bash
npx jofotara-kit template invoice          # production-shaped sample 388 invoice XML
npx jofotara-kit template credit-note      # production-shaped sample 381 return XML
npx jofotara-kit template income-invoice   # 388/011 income document (no VAT)
npx jofotara-kit template income-credit-note
npx jofotara-kit validate out/*.xml        # lint generated XML (also accepts {"invoice": base64} bodies)
npx jofotara-kit rules                     # every rule: id, severity, confidence
npx jofotara-kit serve --port 8080         # local mock of POST /core/invoices/
```

Workflow when implementing or fixing an integration:

1. Run `template invoice` and `template credit-note`. Treat their element order, attributes
   and formatting as the contract. Only values change.
2. Build the generator in the user's stack. Map their data model to the XML fields
   (see [reference.md](reference.md) §3).
3. **Validate every XML your code produces** with `jofotara-kit validate` before claiming it
   works. Add it to the project's tests/CI. Fix every `error`; read every `warning`.
4. Point the integration's base URL at `http://127.0.0.1:8080` (`jofotara-kit serve`) and run
   the full flow: submit, parse response, store, print QR, submit a return.
5. Only then switch the base URL to `https://backend.jofotara.gov.jo` — config only, no code change.

Each finding has a **confidence**: `verified` (observed against the live API), `reported`
(other integrators/SDKs), `inferred` (UBL/common sense). Passing the kit means "passes known
rules", not "guaranteed accepted". Say so to the user.

## Quick reference

| Thing | Value |
|---|---|
| Endpoint | `POST https://backend.jofotara.gov.jo/core/invoices/` |
| Auth | headers `Client-Id`, `Secret-Key` (static, from the JoFotara portal). No OAuth, no token |
| Body | `{"invoice": "<base64 of UTF-8 XML>"}`, `Content-Type: application/json` |
| Timeout | 30 s. A timeout is **not** a rejection — the invoice may have landed |
| Currency | `JOD` in DocumentCurrencyCode/TaxCurrencyCode, but `currencyID="JO"` on amounts |
| Amounts | exactly 9 decimals (`toFixed(9)`); quantity & percent 2 decimals |
| Sales invoice | `<cbc:InvoiceTypeCode name="012">388</…>` cash, `name="022"` receivable. Has `TaxTotal` (doc + every line) |
| Income invoice | `name="011"`, **no `TaxTotal` anywhere**, Payable = Σ LineExtension. Separate credentials/TSP from sales |
| Credit note | `381` + `<cac:BillingReference>` + reason in `PaymentMeans/InstructionNote`. Same track as the original: sales → `381/012`, income → `381/011` |
| UUID | fresh random UUID v4 per submission in `<cbc:UUID>` |
| ICV | **numeric** counter in `AdditionalDocumentReference[ID=ICV]/UUID` |
| TSP | income source sequence (تسلسل مصدر الدخل) in `SellerSupplierParty/…/ID` |
| Tax category | `S` + percent when VAT > 0, `Z` zero-rated, `E` exempt (unverified) |
| Success | `EINV_STATUS` ~ `SUBMITTED/ACCEPT/PASS/SUCCESS` **and** no `EINV_RESULTS.ERRORS` |
| QR | first string under any key matching `/qr/i` (usually `EINV_QR`), print verbatim |

## Non-negotiables

- **Never log or commit `Secret-Key`.** Mask it in UIs (`ab****yz`). Read from env/config.
- **Store the full raw response** and the submitted XML (or at least its UUID). It is the
  only proof of acceptance and you need the UUID for credit notes.
- **Idempotency:** never resubmit an accepted invoice. A resend mints a new UUID = a second
  legal document. After a timeout, check before retrying.
- **HTTP 200 is not success.** The body can still say `EINV_RESULTS.status = "ERROR"`.
  Responses may also be plain text — `JSON.parse` inside try/catch and keep the raw text.
- **Returns are new documents**, never edits or deletes. All amounts stay positive.
- Keep a dry-run switch (build + save XML, don't POST) in the user's integration.

## Common mistakes (each maps to a validator rule)

- Amounts with 2–3 decimals → `JOF-AMT-001`. `currencyID="JOD"` on amounts → `JOF-AMT-002`.
- ICV as a UUID or invoice number → `JOF-HDR-008`.
- Discount baked into unit price instead of a line `AllowanceCharge` → `JOF-MTH-001/006`.
- `TaxExclusiveAmount` after discount (it is gross, **before** discount) → `JOF-MTH-006`.
- Credit note referencing the invoice number or QR instead of the original UUID → `JOF-RET-002`.
- Negating amounts on returns → `JOF-AMT-003`.
- Reordering elements (UBL is order-sensitive) → `JOF-XML-004`.
- Picking the return's type name from a config default instead of the original's track → sales
  invoice returned as `381/011` → `JOF-STA-007` / `JOF-INC-001`. Derive it from the original.
- Resending a return with a fresh UUID under the same return number → `JOF-STA-002`. Guard returns
  exactly like invoices.
- `DocumentDescription` computed without VAT when the original XML is missing → `JOF-RET-008`.
  Store the original PayableAmount at submission time.
- Multiple partial returns must never exceed the original total in sum → `JOF-STA-005`.

Full field map, math, response parsing, credit-note flow and honest unknowns: [reference.md](reference.md).
