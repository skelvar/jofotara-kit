export type Severity = 'error' | 'warning';

/**
 * How sure we are that the live JoFotara API behaves this way.
 * - verified: the passing shape/value was accepted by the live API in production.
 * - reported: documented by other integrators or SDKs, not observed first-hand.
 * - inferred: follows from UBL 2.1 or common sense; not confirmed against the live API.
 */
export type Confidence = 'verified' | 'reported' | 'inferred';

export interface Rule {
  id: string;
  severity: Severity;
  confidence: Confidence;
  title: string;
  fix: string;
}

const defs = {
  'JOF-ENV-001': ['error', 'verified', 'Request body must be JSON {"invoice": "<base64>"}', 'POST with Content-Type: application/json and body {"invoice": base64(utf8 xml)}.'],
  'JOF-ENV-002': ['error', 'verified', '"invoice" must be base64 of the UTF-8 XML', 'Encode the XML string as UTF-8 bytes, then base64 (Node: Buffer.from(xml, "utf8").toString("base64")).'],
  'JOF-AUTH-001': ['error', 'verified', 'Client-Id and Secret-Key headers are required', 'Send both static headers issued by the ISTD JoFotara portal on every request. There is no token exchange.'],
  'JOF-AUTH-002': ['error', 'inferred', 'Credentials do not match', 'Use the Client-Id / Secret-Key the mock was started with (--client-id / --secret-key).'],

  'JOF-XML-001': ['error', 'verified', 'XML must be well-formed', 'Build XML with a serializer or escape & < > " \' in every interpolated value.'],
  'JOF-XML-002': ['error', 'verified', 'Root must be <Invoice> in the UBL 2.1 Invoice-2 namespace', 'Use <Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"> with the cac/cbc namespaces. Credit notes are also <Invoice>, not <CreditNote>.'],
  'JOF-XML-003': ['error', 'verified', 'Required element is missing', 'Compare with `jofotara-kit template invoice` and add the missing element.'],
  'JOF-XML-004': ['error', 'inferred', 'Top-level elements are out of order', 'UBL is order-sensitive. Emit elements exactly in the template order.'],
  'JOF-XML-005': ['warning', 'inferred', 'Unexpected top-level element', 'Remove elements that are not part of the accepted JoFotara shape unless you know the API accepts them.'],
  'JOF-XML-006': ['error', 'inferred', 'Element appears more than once', 'Only <cac:AdditionalDocumentReference> and <cac:InvoiceLine> may repeat at top level.'],

  'JOF-HDR-001': ['error', 'verified', 'ProfileID must be "reporting:1.0"', 'Emit <cbc:ProfileID>reporting:1.0</cbc:ProfileID>.'],
  'JOF-HDR-002': ['error', 'verified', 'UUID must be an RFC 4122 UUID', 'Generate a fresh random UUID v4 per submission (crypto.randomUUID()). Never use the invoice number.'],
  'JOF-HDR-003': ['error', 'verified', 'IssueDate must be a valid YYYY-MM-DD date', 'Format the sale date as YYYY-MM-DD (not dd-mm-yyyy, no time part).'],
  'JOF-HDR-004': ['error', 'verified', 'InvoiceTypeCode must be 388 (invoice) or 381 (credit note)', 'Use 388 for sales invoices and 381 for returns.'],
  'JOF-HDR-005': ['error', 'verified', 'InvoiceTypeCode name must be 011 (income), 012 (sales cash) or 022 (sales receivable)', 'Use name="011" for income-tax documents, "012" for cash sales, "022" for receivable sales.'],
  'JOF-HDR-006': ['warning', 'reported', 'InvoiceTypeCode name is outside the verified tracks', 'Income receivable (021) and special-sales (013/023) exist but are not covered by verified rules; validate carefully.'],
  'JOF-HDR-007': ['error', 'verified', 'Document and tax currency must be JOD', 'Emit JOD in <cbc:DocumentCurrencyCode> and <cbc:TaxCurrencyCode>.'],
  'JOF-HDR-008': ['error', 'verified', 'ICV must be numeric', 'Put a numeric counter (ideally increasing) in the ICV <cbc:UUID>, not a UUID or document number.'],
  'JOF-HDR-009': ['warning', 'verified', '<cbc:Note> should always be present', 'Emit <cbc:Note/> even when there is no note; production always sends it.'],
  'JOF-HDR-010': ['warning', 'inferred', 'IssueDate is in the future', 'Use the actual sale date.'],

  'JOF-PTY-001': ['error', 'verified', 'Seller tax number is required', 'Set AccountingSupplierParty/Party/PartyTaxScheme/CompanyID to your tax number.'],
  'JOF-PTY-002': ['error', 'verified', 'Seller registration name is required', 'Set AccountingSupplierParty/Party/PartyLegalEntity/RegistrationName.'],
  'JOF-PTY-003': ['error', 'verified', 'Income source sequence (TSP) is required', 'Set SellerSupplierParty/Party/PartyIdentification/ID to the "تسلسل مصدر الدخل" value from the JoFotara portal.'],
  'JOF-PTY-004': ['warning', 'inferred', 'Tax number / income source sequence should be digits only', 'Copy the values exactly from the JoFotara portal; they are numeric.'],
  'JOF-PTY-005': ['warning', 'verified', 'Customer ID schemeID is not TN', 'TN (tax number) is verified; NAT (national ID) exists in code lists. Other schemes are unverified.'],
  'JOF-PTY-006': ['warning', 'verified', 'Customer name is empty', 'Use the customer name, or "Cash customer" with ID "-" for walk-in sales.'],
  'JOF-PTY-007': ['error', 'reported', 'Customer name is required for receivable invoices or totals over 10,000 JOD', 'Provide the real customer name for name="022" invoices and for any invoice above 10,000 JOD.'],
  'JOF-PTY-008': ['warning', 'verified', 'Country code should be JO', 'Emit <cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country>.'],
  'JOF-PAY-001': ['warning', 'verified', 'PaymentMeansCode should be 10 (cash) or 42 (bank) with listID "UN/ECE 4461"', 'Emit <cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode>.'],

  'JOF-AMT-001': ['error', 'verified', 'Amounts must have exactly 9 decimal places', 'Format every monetary amount with toFixed(9), e.g. 116.000000000.'],
  'JOF-AMT-002': ['error', 'verified', 'Amounts must carry currencyID="JO"', 'Use currencyID="JO" on amounts (not "JOD" — the document codes use JOD, amounts use JO).'],
  'JOF-AMT-003': ['error', 'verified', 'Amounts must not be negative', 'Keep all amounts positive, including on credit notes; type code 381 carries the credit meaning.'],

  'JOF-LIN-001': ['warning', 'verified', 'Line IDs should be 1, 2, 3, ...', 'Number InvoiceLine/cbc:ID sequentially starting at 1.'],
  'JOF-LIN-002': ['error', 'verified', 'Quantity must be greater than zero', 'Send a positive quantity (default 1).'],
  'JOF-LIN-003': ['warning', 'verified', 'Quantity should have 2 decimal places', 'Format quantities with toFixed(2).'],
  'JOF-LIN-004': ['warning', 'verified', 'unitCode should be PCE', 'Only unitCode="PCE" has been exercised in production.'],
  'JOF-LIN-005': ['error', 'verified', 'Item name is required', 'Set InvoiceLine/cac:Item/cbc:Name.'],
  'JOF-LIN-006': ['error', 'verified', 'Tax category must match the tax amount', 'Use S when the line has VAT (> 0), Z for zero-rated or E for exempt when tax is 0.'],
  'JOF-LIN-007': ['warning', 'reported', 'Exempt (E) tax category is unverified', 'E exists in the code list and in other SDKs but was never exercised against the live API by this kit.'],
  'JOF-LIN-008': ['warning', 'verified', 'Tax percent should be 2 decimals and match tax / line amount', 'Derive Percent = tax / LineExtensionAmount × 100, formatted with toFixed(2) (0.00 for Z/E).'],

  'JOF-INC-001': ['error', 'verified', 'Income documents (name="011") must not carry TaxTotal', 'Omit both the document-level and per-line <cac:TaxTotal> on income invoices and income returns.'],
  'JOF-INC-002': ['error', 'verified', 'Sales documents (012/022) require TaxTotal', 'Emit the document-level <cac:TaxTotal> and a per-line <cac:TaxTotal> on every sales invoice line, even for zero-rated lines.'],

  'JOF-MTH-001': ['error', 'verified', 'LineExtensionAmount must equal max(quantity × price − discount, 0)', 'Compute line net before tax from quantity, unit price and the line discount.'],
  'JOF-MTH-002': ['error', 'verified', 'Line RoundingAmount must equal LineExtensionAmount + line tax', 'RoundingAmount is the line total including tax.'],
  'JOF-MTH-003': ['error', 'verified', 'Line TaxSubtotal/TaxAmount must equal line TaxTotal/TaxAmount', 'Repeat the same line tax amount in both places.'],
  'JOF-MTH-004': ['error', 'verified', 'Document TaxTotal must equal the sum of line taxes', 'Sum line TaxAmount values into the top-level <cac:TaxTotal>.'],
  'JOF-MTH-005': ['error', 'verified', 'Document discount must equal the sum of line discounts', 'Top-level AllowanceCharge/Amount and AllowanceTotalAmount both equal Σ line discounts.'],
  'JOF-MTH-006': ['error', 'verified', 'TaxExclusiveAmount must equal Σ (quantity × price) before discount', 'TaxExclusiveAmount is the gross total BEFORE discounts.'],
  'JOF-MTH-007': ['error', 'verified', 'TaxInclusiveAmount is wrong', 'Invoices: TaxExclusive − discounts + tax. Credit notes: equal to PayableAmount. Income: no tax term.'],
  'JOF-MTH-008': ['error', 'verified', 'PayableAmount must equal Σ (LineExtensionAmount + line tax)', 'Sum the line totals including tax (income: Σ LineExtensionAmount).'],

  'JOF-RET-001': ['error', 'verified', 'Credit note (381) requires a BillingReference to the original invoice', 'Add cac:BillingReference/cac:InvoiceDocumentReference with cbc:ID, cbc:UUID and cbc:DocumentDescription.'],
  'JOF-RET-002': ['error', 'verified', 'BillingReference UUID must be the original submission UUID', 'Use the <cbc:UUID> you sent with the ACCEPTED original invoice — not its number, a fresh UUID, or the QR string.'],
  'JOF-RET-003': ['error', 'verified', 'BillingReference DocumentDescription must be the original payable total (9 dp)', 'Put the original invoice PayableAmount, formatted with toFixed(9).'],
  'JOF-RET-004': ['error', 'verified', 'Return reason is required', 'Add <cbc:InstructionNote> with the reason inside <cac:PaymentMeans>.'],
  'JOF-RET-005': ['warning', 'inferred', 'Invoice (388) carries a BillingReference', 'Only credit notes (381) should reference an original invoice.'],
  'JOF-RET-006': ['warning', 'verified', 'Credit note name="022" is unverified', 'Production sales returns always used name="012", even for receivable originals.'],
  'JOF-RET-007': ['error', 'verified', 'Credit note must have its own UUID', 'Generate a fresh UUID for the return; the original UUID goes only in BillingReference.'],
  'JOF-RET-008': ['error', 'inferred', 'Credit note total exceeds the original invoice total', 'A return can credit at most the original PayableAmount (DocumentDescription).'],

  'JOF-STA-001': ['error', 'inferred', 'This UUID was already accepted', 'Never resubmit an accepted invoice. Check your stored response before sending; after a timeout, verify before retrying.'],
  'JOF-STA-002': ['error', 'inferred', 'This invoice number was already accepted', 'Each accepted invoice number is a legal document; a resend with a new UUID creates a duplicate.'],
  'JOF-STA-003': ['error', 'inferred', 'Credit note references an invoice that was not accepted', 'Submit (to this mock) and get acceptance for the original invoice first, then reference its UUID.'],
  'JOF-STA-004': ['error', 'inferred', 'BillingReference does not match the original invoice', 'BillingReference ID and DocumentDescription must match the original invoice number and payable total.'],
  'JOF-STA-005': ['error', 'inferred', 'Returns exceed the original invoice total', 'The sum of all accepted returns for one invoice must not exceed its PayableAmount.'],
  'JOF-STA-006': ['warning', 'inferred', 'Partial return', 'Full returns are verified. Partial returns (fewer lines/quantities) are expected to work but were never exercised against the live API.'],
  'JOF-STA-007': ['error', 'inferred', 'Return track differs from the original invoice track', 'Return an income invoice (011) with an income return (381/011) and a sales invoice (012/022) with a sales return (381/012) under the same credentials.'],
  'JOF-STA-008': ['error', 'inferred', 'Return is dated before the original invoice', 'IssueDate of a credit note must be on or after the original IssueDate.'],
} as const satisfies Record<string, readonly [Severity, Confidence, string, string]>;

export type RuleId = keyof typeof defs;

export const RULE_MAP = Object.fromEntries(
  Object.entries(defs).map(([id, [severity, confidence, title, fix]]) => [id, { id, severity, confidence, title, fix }]),
) as Record<RuleId, Rule>;

export const RULES: Rule[] = Object.values(RULE_MAP);
