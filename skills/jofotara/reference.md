# JoFotara integration — reference

Rules marked `verified` reflect XML shapes accepted by the live JoFotara API.
Scope: one seller; sales invoices (فاتورة مبيعات), income invoices (فاتورة دخل), and their
credit notes (إشعار دائن), in JOD.

XML element names, attribute values and code lists are **fixed by JoFotara**. Your own
database/field names are yours — only the XML contract matters.

For the complete XML, always generate it rather than copying from docs:

```bash
npx jofotara-kit template invoice
npx jofotara-kit template credit-note
```

---

## 1. Transport & auth

```
POST https://backend.jofotara.gov.jo/core/invoices/
Client-Id:     <from the JoFotara portal>
Secret-Key:    <from the JoFotara portal>
Content-Type:  application/json

{"invoice": "<base64 of the UTF-8 UBL XML>"}
```

```js
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30_000);
const res = await fetch(`${baseUrl}/core/invoices/`, {
  method: 'POST',
  headers: { 'Client-Id': clientId, 'Secret-Key': secretKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') }),
  signal: controller.signal,
});
clearTimeout(timer);
const raw = await res.text();
let body; try { body = JSON.parse(raw); } catch { body = raw; } // may be plain text on errors
```

Make `baseUrl` configurable so the same code talks to `jofotara-kit serve` locally.

### Credentials / config (per seller)

| Value | Where it goes |
|---|---|
| Client-Id | HTTP header |
| Secret-Key | HTTP header — never log |
| Income source sequence (TSP, تسلسل مصدر الدخل) | `SellerSupplierParty/Party/PartyIdentification/ID` |
| Seller tax number (الرقم الضريبي) | `AccountingSupplierParty/Party/PartyTaxScheme/CompanyID` |
| Seller registered name | `AccountingSupplierParty/Party/PartyLegalEntity/RegistrationName` |

The TSP is shown in the portal next to the Client-Id / Secret-Key.

---

## 2. Code lists

| Document | InvoiceTypeCode value | `name` attribute |
|---|---|---|
| Sales invoice, cash (نقدية) | `388` | `012` |
| Sales invoice, receivable (ذمم) | `388` | `022` |
| Sales credit note (return) | `381` | `012` (a `022` name on a return has not been observed accepted) |
| Income invoice (فاتورة دخل) | `388` | `011` |
| Income credit note | `381` | `011` |

**Tracks.** Income (`011`) and sales (`012`/`022`) are separate: separate credentials, TSP and
tax number (income tax number vs sales tax number). Income documents carry **no `TaxTotal`**
at document or line level; `TaxInclusiveAmount = TaxExclusiveAmount − discounts`,
`PayableAmount = Σ LineExtensionAmount`. A return always uses the original's track.

- `PaymentMeansCode listID="UN/ECE 4461"`: `10` cash (default), `42` bank transfer.
- Tax category `schemeAgencyID="6" schemeID="UN/ECE 5305"`: `S` standard (with Percent), `Z` zero-rated, `E` exempt.
- Customer ID `schemeID`: `TN` tax number (verified). `NAT` national ID exists in code lists.
- Walk-in customer: ID and CompanyID `-`, schemeID `TN`, name `Cash customer`.

---

## 3. Field map (what each XML field means)

### Header

| XML | Meaning |
|---|---|
| `cbc:ProfileID` | always `reporting:1.0` |
| `cbc:ID` | invoice number, unique per seller |
| `cbc:UUID` | random UUID v4 minted at submission time |
| `cbc:IssueDate` | sale date `YYYY-MM-DD` |
| `cbc:InvoiceTypeCode` | see §2 |
| `cbc:Note` | free text; always emit, even empty |
| ICV (`AdditionalDocumentReference[ID=ICV]/UUID`) | numeric counter, ideally increasing |
| Customer `PartyIdentification/ID` + `PartyTaxScheme/CompanyID` | customer tax number, `-` if none |
| Customer `PartyLegalEntity/RegistrationName` | customer name, `Cash customer` if none. **Required** for `022` invoices and totals > 10,000 JOD (reported) |

### Lines (one `cac:InvoiceLine` per item)

| XML | Meaning |
|---|---|
| `cbc:ID` | 1-based line index |
| `cbc:InvoicedQuantity unitCode="PCE"` | quantity > 0, 2 dp |
| `cbc:LineExtensionAmount` | line net before tax |
| `cac:TaxTotal/cbc:TaxAmount` | line VAT |
| `cac:TaxTotal/cbc:RoundingAmount` | line total incl. VAT |
| `cac:TaxSubtotal/cbc:TaxAmount` | line VAT again (no `TaxableAmount` — intentional) |
| `cac:TaxCategory/cbc:ID` + `cbc:Percent` | `S`/`Z`/`E`, rate 2 dp |
| `cac:Item/cbc:Name` | item description (Arabic fine) |
| `cac:Price/cbc:PriceAmount` | unit price before tax and discount |
| `cac:Price/cac:AllowanceCharge/cbc:Amount` | line discount **amount** (not baked into price) |

### Formatting

- Amounts: exactly 9 decimals, `currencyID="JO"`. Quantities and percents: 2 decimals.
- XML-escape every interpolated value (`& < > " '`). UTF-8.
- Keep the element order of the template — UBL is order-sensitive.
- The document-level `AllowanceCharge` is emitted even when the discount is `0.000000000`.

---

## 4. Math (compute exactly this)

```
gross          = qty × unitPrice
lineExtension  = max(gross − discount, 0)
tax            = lineExtension × rate / 100   (round to fils, 3 dp, before formatting)
lineTotal      = lineExtension + tax           → RoundingAmount
percent        = lineExtension > 0 && tax > 0 ? tax / lineExtension × 100 : 0
category       = tax > 0 ? 'S' : 'Z'
```

Document totals:

```
AllowanceCharge/Amount = AllowanceTotalAmount = Σ discount
TaxTotal/TaxAmount     = Σ tax
TaxExclusiveAmount     = Σ gross                       ← BEFORE discount
TaxInclusiveAmount     = TaxExclusive − Σ discount + Σ tax   (credit notes: = PayableAmount)
PayableAmount          = Σ lineTotal
```

---

## 5. What to persist

Per invoice:

| Field | Purpose |
|---|---|
| accepted flag | 1 accepted / 0 not sent or rejected |
| QR text | returned QR string — **print it on the invoice** |
| raw response | full body + your request metadata (invoice id, UUID you sent, type, total) |
| submitted XML | audit trail and UUID recovery for returns |

---

## 6. Response parsing (defensive)

Decide in order; any rejection short-circuits:

1. HTTP not ok → rejected
2. `EINV_RESULTS.status === "ERROR"` → rejected
3. `EINV_STATUS` matches `/NOT_SUBMITTED|ERROR|REJECT/i` → rejected
4. `EINV_RESULTS.ERRORS` non-empty → rejected
5. `EINV_STATUS` matches `/SUBMITTED|ACCEPT|PASS|SUCCESS/i` → accepted
6. `EINV_RESULTS.status` matches `/PASS|SUCCESS|ACCEPT/i` → accepted
7. fallback: HTTP ok

Key casing varies — check upper and lower case. Walk the JSON recursively:

- **QR**: first non-empty string under a key matching `/qr/i`.
- **UUID**: `EINV_INV_UUID`, `EINV_UUID`, `INV_UUID`, `INVOICE_UUID`, `invoiceUuid`; else any
  `/uuid/i` key whose value is an RFC 4122 UUID. For returns, prefer the UUID **you sent**.

Rejection payloads are not standardized. Show the raw `ERRORS` to a human.

---

## 7. Credit notes (returns)

A return is a **new document** on the same endpoint. The original stays on record.

Prerequisites — the original must be **accepted**, and you need:

| Needed | Goes to |
|---|---|
| original invoice number | `BillingReference/InvoiceDocumentReference/cbc:ID` |
| original submission UUID (the `<cbc:UUID>` you sent) | `…/cbc:UUID` |
| original PayableAmount, 9 dp | `…/cbc:DocumentDescription` |

Resolve the UUID from the saved original XML, else stored request metadata, else ask the
user. **Never** put a guessed/fresh UUID, the invoice number, or the QR string there.

The return itself:

- own number (convention `R_<original>`; strip an existing `R_` first), own fresh UUID, own ICV
- `<cbc:InvoiceTypeCode name="012">381</cbc:InvoiceTypeCode>`
- `<cac:BillingReference>` placed right after `TaxCurrencyCode`
- reason **required** in `PaymentMeans/cbc:InstructionNote` (e.g. `ارجاع فاتورة`)
- copy the original `AccountingCustomerParty` block verbatim when you have it
- all amounts positive; `TaxInclusiveAmount = PayableAmount`
- gets its own QR to print; guard against re-submitting an accepted return too

**Partial and multiple returns.** Put only the returned lines/quantities in the credit note;
`DocumentDescription` stays the original's full PayableAmount. Give each return its own number
(e.g. `R1_<orig>`, `R2_<orig>`) and track the returned total per original — the sum of all
returns must not exceed the original. Partial returns follow the same XML shape but were not
exercised against the live API (`JOF-STA-006` warns).

---

## 8. Honest unknowns

- No government sandbox exists. `jofotara-kit serve` models known behavior only.
- ICV: any positive number was accepted; strict monotonicity never enforced in practice.
- `E` (exempt), `unitCode` other than `PCE`, name `022` on returns, partial returns, and
  non-JOD documents were never exercised against the live API.
- Field length / charset limits are unpublished. Arabic, hyphens and `-` placeholders work.
- The QR string is opaque — render verbatim, never decode/re-encode.
- If you hit a real rejection the kit did not predict, the redacted response is the most
  valuable contribution to the project.
