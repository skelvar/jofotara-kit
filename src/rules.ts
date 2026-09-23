export type Severity = 'error' | 'warning';

/**
 * Where a rule comes from.
 * - manual: stated in the ISTD technical guide for the national e-invoicing API (v1.4, 2023-12-01).
 * - verified: behaviour observed on the live API and contributed back (with a redacted response).
 * - inferred: follows from UBL 2.1 or accounting common sense; not stated in the manual.
 */
export type Confidence = 'manual' | 'verified' | 'inferred';

export interface Rule {
  id: string;
  severity: Severity;
  confidence: Confidence;
  /** Manual page(s), e.g. "p.41", when confidence is `manual`. */
  source?: string;
  title: string;
  fix: string;
}

type Def = readonly [Severity, Confidence, string | undefined, string, string];

const defs = {
  'JOF-ENV-001': ['error', 'manual', 'p.81', 'Request body must be JSON {"invoice": "<base64>"}', 'POST with Content-Type: application/json and body {"invoice": base64(utf8 xml)}.'],
  'JOF-ENV-002': ['error', 'manual', 'p.81', '"invoice" must be base64 of the UTF-8 XML', 'Encode the XML as UTF-8 bytes, then base64 (Node: Buffer.from(xml, "utf8").toString("base64")).'],
  'JOF-AUTH-001': ['error', 'manual', 'p.9, p.81', 'Client-Id and Secret-Key headers are required', 'Send both headers from the device-linking screen of the JoFotara portal on every request.'],
  'JOF-AUTH-002': ['error', 'inferred', undefined, 'Credentials do not match', 'Use the Client-Id / Secret-Key the mock was started with (--client-id / --secret-key).'],

  'JOF-XML-001': ['error', 'manual', 'p.9', 'XML must be well-formed', 'Build XML with a serializer or escape & < > " \' in every interpolated value.'],
  'JOF-XML-002': ['error', 'manual', 'p.9', 'Root must be <Invoice> in the UBL 2.1 Invoice-2 namespace', 'Use <Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"> with the cac/cbc/ext namespaces. Returns are also <Invoice>.'],
  'JOF-XML-003': ['error', 'manual', 'p.11-80', 'Required element is missing', 'Compare with `jofotara-kit template <type>` and add the missing element.'],
  'JOF-XML-004': ['error', 'inferred', undefined, 'Top-level elements are out of order', 'UBL is order-sensitive. Emit elements in the template order.'],
  'JOF-XML-005': ['warning', 'inferred', undefined, 'Unexpected top-level element', 'Remove elements that are not part of the documented JoFotara shape.'],
  'JOF-XML-006': ['error', 'inferred', undefined, 'Element appears more than once', 'Only <cac:AdditionalDocumentReference> and <cac:InvoiceLine> may repeat at top level.'],

  'JOF-HDR-001': ['error', 'manual', 'p.9', 'ProfileID must be "reporting:1.0"', 'Emit <cbc:ProfileID>reporting:1.0</cbc:ProfileID>.'],
  'JOF-HDR-002': ['error', 'manual', 'p.11', 'UUID must be a valid UUID', 'Generate a fresh random UUID per document (crypto.randomUUID()). ID + UUID together are the document key.'],
  'JOF-HDR-003': ['error', 'manual', 'p.11', 'IssueDate must be yyyy-mm-dd', 'Format the date as yyyy-mm-dd, e.g. 2022-12-31.'],
  'JOF-HDR-004': ['error', 'manual', 'p.11, p.23', 'InvoiceTypeCode must be 388 (new) or 381 (return)', 'Use 388 for new invoices and 381 for returns.'],
  'JOF-HDR-005': ['error', 'manual', 'p.11, 23, 32, 44, 57, 70', 'Unknown InvoiceTypeCode name', 'name is <payment><track>: 011/021 income, 012/022 general sales, 013/023 special sales (first digit 0, then 1 cash / 2 receivable).'],
  'JOF-HDR-007': ['error', 'manual', 'p.11', 'Document and tax currency must be JOD', 'Emit JOD in <cbc:DocumentCurrencyCode> and <cbc:TaxCurrencyCode>.'],
  'JOF-HDR-008': ['warning', 'manual', 'p.11', 'ICV should be a counter (1, 2, 3, ...)', 'Put a positive integer invoice counter in the ICV <cbc:UUID>. The manual lets you choose the sequence, but a document number or UUID is not a counter.'],
  'JOF-HDR-010': ['warning', 'inferred', undefined, 'IssueDate is in the future', 'Use the actual sale or return date.'],

  'JOF-PTY-001': ['error', 'manual', 'p.13', 'Seller tax number is required', 'Set AccountingSupplierParty/Party/PartyTaxScheme/CompanyID.'],
  'JOF-PTY-002': ['error', 'manual', 'p.13', 'Seller registered name is required', 'Set AccountingSupplierParty/Party/PartyLegalEntity/RegistrationName as registered with ISTD.'],
  'JOF-PTY-003': ['error', 'manual', 'p.16', 'Income source sequence is required', 'Set SellerSupplierParty/Party/PartyIdentification/ID to the income source sequence (تسلسل مصدر الدخل) chosen when linking the device.'],
  'JOF-PTY-004': ['warning', 'inferred', undefined, 'Tax number / income source sequence should be digits only', 'Copy the values exactly from the JoFotara portal; they are numeric.'],
  'JOF-PTY-005': ['error', 'manual', 'p.14', 'Buyer ID must be digits with schemeID NIN, PN or TN', 'NIN = national number, PN = personal (non-Jordanian) number, TN = tax number. The ID must be digits only.'],
  'JOF-PTY-007': ['error', 'manual', 'p.14, p.35, p.60', 'Buyer name is required for receivable invoices and cash invoices above JOD 10,000', 'Provide the buyer RegistrationName when name is x2x (receivable) or the total exceeds 10,000 JOD.'],
  'JOF-PTY-008': ['error', 'manual', 'p.13', 'Country code must be JO', 'Emit <cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country>.'],
  'JOF-PTY-009': ['error', 'manual', 'p.36', 'CountrySubentityCode must be a governorate code', 'Use one of JO-AM, JO-AZ, JO-IR, JO-BA, JO-MN, JO-MD, JO-MA, JO-KA, JO-JA, JO-AT, JO-AQ, JO-AJ, or leave it empty.'],
  'JOF-PAY-001': ['warning', 'manual', 'p.26, p.48', 'PaymentMeansCode should be 10 with listID "UN/ECE 4461"', 'Emit <cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode>.'],

  'JOF-AMT-001': ['error', 'manual', 'p.17-80', 'Amounts must be plain decimal numbers', 'Write amounts like 64, 64.00 or 64.000 — no exponent, sign, thousands separator or currency symbol. The manual does not fix the number of decimals.'],
  'JOF-AMT-002': ['error', 'manual', 'p.17-80', 'Amounts must carry currencyID="JO"', 'Use currencyID="JO" on every amount (the document currency codes are JOD, amounts use JO).'],
  'JOF-AMT-003': ['error', 'manual', 'p.27-30, 49-54', 'Amounts must not be negative', 'Keep all amounts positive, including on returns; type code 381 carries the credit meaning.'],

  'JOF-LIN-001': ['error', 'manual', 'p.19', 'Line IDs must be unique within the document', 'Number each InvoiceLine/cbc:ID uniquely. On returns, use the line number from the original invoice.'],
  'JOF-LIN-002': ['error', 'inferred', undefined, 'Quantity must be greater than zero', 'Send a positive quantity.'],
  'JOF-LIN-003': ['error', 'manual', 'p.19', 'Quantity must be a plain decimal number', 'Write quantities like 33 or 33.00.'],
  'JOF-LIN-004': ['error', 'manual', 'p.19, p.40', 'unitCode must be PCE', 'Emit <cbc:InvoicedQuantity unitCode="PCE">. Fixed text in every template.'],
  'JOF-LIN-005': ['error', 'manual', 'p.19', 'Item name is required', 'Set InvoiceLine/cac:Item/cbc:Name.'],
  'JOF-LIN-006': ['error', 'manual', 'p.41, 53, 78', 'Tax category does not match the rate', 'S = taxable at 1, 2, 3, 4, 5, 7, 8, 10 or 16%. Z = exempt at 0%. O = zero-rated at 0%.'],
  'JOF-LIN-007': ['error', 'manual', 'p.41, 53, 78', 'Unknown tax category', 'Only S, Z and O exist. Note: Z means EXEMPT and O means ZERO-RATED (not E).'],
  'JOF-LIN-008': ['warning', 'manual', 'p.40', 'Line tax does not equal LineExtensionAmount × Percent', 'Tax = (quantity × price − discount) × rate. Rounding to fils is fine; larger gaps usually mean a wrong rate or a tax-inclusive price.'],
  'JOF-LIN-009': ['error', 'manual', 'p.41', 'Unsupported VAT rate', 'Use one of 0, 1, 2, 3, 4, 5, 7, 8, 10, 16.'],

  'JOF-INC-001': ['error', 'manual', 'p.17-20, 27-30', 'Income documents (011/021) must not carry TaxTotal', 'Omit both the document-level and per-line <cac:TaxTotal> on income invoices and income returns.'],
  'JOF-INC-002': ['error', 'manual', 'p.38-40, 63-65', 'Sales documents require TaxTotal', 'Emit the document-level <cac:TaxTotal> and a per-line <cac:TaxTotal> on every sales line, zero-rated and exempt lines included.'],
  'JOF-INC-003': ['error', 'manual', 'p.65, p.77', 'Special-sales lines need a special-tax (OTH) and a VAT subtotal', 'Each 013/023 line carries two TaxSubtotals: TaxScheme OTH (special tax, no Percent) and TaxScheme VAT (general tax with Percent).'],

  'JOF-MTH-001': ['error', 'manual', 'p.19, p.40', 'LineExtensionAmount must equal quantity × price − line discount', 'Compute the line amount before tax from quantity, unit price and the line discount.'],
  'JOF-MTH-002': ['error', 'manual', 'p.41, p.66', 'Line RoundingAmount must equal LineExtensionAmount + taxes', 'RoundingAmount is the line total including tax (plus special tax on 013/023).'],
  'JOF-MTH-003': ['error', 'manual', 'p.40', 'Line VAT TaxSubtotal must equal the line TaxAmount', 'Repeat the same line VAT amount in TaxTotal/TaxAmount and in the VAT TaxSubtotal.'],
  'JOF-MTH-004': ['error', 'manual', 'p.38, p.63', 'Document TaxTotal must equal the sum of line VAT', 'Sum line VAT amounts into the top-level <cac:TaxTotal>/TaxAmount.'],
  'JOF-MTH-005': ['error', 'manual', 'p.17, p.38', 'Document discount must equal the sum of line discounts', 'JoFotara does not accept invoice-level discounts: spread any order discount over the lines, then AllowanceCharge/Amount = AllowanceTotalAmount = Σ line discounts.'],
  'JOF-MTH-006': ['error', 'manual', 'p.17, p.38', 'TaxExclusiveAmount must equal Σ (price × quantity)', 'TaxExclusiveAmount is the total BEFORE discounts and tax.'],
  'JOF-MTH-007': ['error', 'manual', 'p.17, 38, 63', 'TaxInclusiveAmount is wrong', 'Income: exclusive − discounts. Sales: exclusive − discounts + VAT. Special: exclusive − discounts + special tax + VAT.'],
  'JOF-MTH-008': ['error', 'manual', 'p.17, 38, 51, 63', 'PayableAmount is wrong', 'PayableAmount equals TaxInclusiveAmount (minus PrepaidAmount, which is 0 on returns).'],
  'JOF-MTH-009': ['error', 'manual', 'p.53, p.66', 'TaxableAmount must equal the line amount', 'Line TaxableAmount = quantity × price − line discount.'],
  'JOF-MTH-010': ['error', 'manual', 'p.49-50', 'Document tax subtotals do not match the lines', 'Emit one document-level TaxSubtotal per category and rate, with TaxableAmount and TaxAmount summed from those lines; TaxTotal/TaxAmount is their sum.'],

  'JOF-RET-001': ['error', 'manual', 'p.22, p.45', 'Return (381) requires a BillingReference to the original invoice', 'Add cac:BillingReference/cac:InvoiceDocumentReference with the original cbc:ID, cbc:UUID and cbc:DocumentDescription (original total).'],
  'JOF-RET-002': ['error', 'manual', 'p.23', 'BillingReference UUID must be the original invoice UUID', 'Use the <cbc:UUID> of the original invoice — not its number or the QR string.'],
  'JOF-RET-003': ['error', 'manual', 'p.23, p.45', 'BillingReference DocumentDescription must be the original invoice total', 'Put the original PayableAmount as a plain decimal number.'],
  'JOF-RET-004': ['error', 'manual', 'p.26, p.48', 'Return reason is required', 'Add <cac:PaymentMeans> with PaymentMeansCode 10 and the reason in <cbc:InstructionNote>.'],
  'JOF-RET-005': ['warning', 'inferred', undefined, 'New invoice (388) carries a BillingReference', 'Only returns (381) reference an original invoice.'],
  'JOF-RET-006': ['error', 'manual', 'p.52-53', 'Sales return lines need a TaxableAmount', 'On 012/022 returns, add <cbc:TaxableAmount> (line amount) inside each line TaxSubtotal.'],
  'JOF-RET-007': ['error', 'manual', 'p.11, p.22', 'Return must have its own UUID', 'Generate a fresh UUID for the return; the original UUID goes only in BillingReference.'],
  'JOF-RET-008': ['error', 'manual', 'p.22', 'Return total exceeds the original invoice total', 'A return can never exceed what was sold on the original invoice.'],
  'JOF-RET-009': ['error', 'manual', 'p.52, p.54', 'Sales return lines need BaseQuantity 1', 'On 012/022 returns, add <cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity> right after PriceAmount.'],
  'JOF-RET-010': ['error', 'manual', 'p.49-50', 'Sales return needs document-level tax subtotals', 'On 012/022 returns, the top-level TaxTotal carries one TaxSubtotal per category and rate (TaxableAmount, TaxAmount, TaxCategory).'],
  'JOF-RET-011': ['error', 'manual', 'p.51', 'Sales return needs PrepaidAmount 0', 'On 012/022 returns, add <cbc:PrepaidAmount currencyID="JO">0</cbc:PrepaidAmount> before PayableAmount.'],

  'JOF-STA-001': ['error', 'manual', 'p.11', 'This document ID + UUID was already accepted', 'ID and UUID are the document key. Never resubmit an accepted document; after a timeout, treat the result as unknown and verify first.'],
  'JOF-STA-002': ['error', 'inferred', undefined, 'This invoice number was already accepted', 'A resend of an accepted invoice with a new UUID creates a second legal document.'],
  'JOF-STA-003': ['error', 'manual', 'p.22', 'Return references an invoice that was not accepted', 'Get the original invoice accepted first, then reference its number, UUID and total.'],
  'JOF-STA-004': ['error', 'manual', 'p.23', 'BillingReference does not match the original invoice', 'ID, UUID and DocumentDescription must match the original invoice number, UUID and total.'],
  'JOF-STA-005': ['error', 'manual', 'p.22', 'Returned quantity exceeds what was sold', 'Across all returns, each line may return at most the quantity sold on the original invoice.'],
  'JOF-STA-007': ['error', 'manual', 'p.23, p.44, p.70', 'Return type name differs from the original invoice', 'A return uses the original track and payment terms: 011→011, 021→021, 012→012, 022→022, 013→013, 023→023.'],
  'JOF-STA-008': ['error', 'inferred', undefined, 'Return is dated before the original invoice', 'IssueDate of a return must be on or after the original IssueDate.'],
  'JOF-STA-009': ['error', 'manual', 'p.29', 'Return line does not match an original line', 'Use the original line number, item name, unit price, tax category and rate for every returned line.'],
} as const satisfies Record<string, Def>;

export type RuleId = keyof typeof defs;

export const RULE_MAP = Object.fromEntries(
  Object.entries(defs).map(([id, [severity, confidence, source, title, fix]]) => [
    id,
    { id, severity, confidence, ...(source ? { source } : {}), title, fix },
  ]),
) as Record<RuleId, Rule>;

export const RULES: Rule[] = Object.values(RULE_MAP);

/** VAT rates allowed by the manual (p.41). */
export const VAT_RATES = [0, 1, 2, 3, 4, 5, 7, 8, 10, 16];
/** Governorate codes for CountrySubentityCode (p.36). */
export const GOVERNORATES = ['JO-BA', 'JO-MN', 'JO-MD', 'JO-MA', 'JO-KA', 'JO-JA', 'JO-IR', 'JO-AZ', 'JO-AT', 'JO-AQ', 'JO-AM', 'JO-AJ'];
