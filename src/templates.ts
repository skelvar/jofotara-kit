import { randomUUID } from 'node:crypto';

export interface SampleLine {
  name: string;
  qty: number;
  price: number;
  discount?: number;
  /** VAT percent, e.g. 16. Omit or 0 for zero-rated. */
  taxRate?: number;
}

export interface SampleOptions {
  /** sales (default): VAT document, name 012/022. income: name 011, no TaxTotal anywhere. */
  track?: 'sales' | 'income';
  id?: string;
  uuid?: string;
  issueDate?: string;
  icv?: number;
  typeName?: '012' | '022';
  note?: string;
  seller?: { taxNumber: string; name: string; tsp: string };
  customer?: { id: string; name: string };
  lines?: SampleLine[];
}

export interface CreditNoteOptions extends SampleOptions {
  reason?: string;
}

export interface OriginalInvoice {
  id: string;
  uuid: string;
  payable: number;
}

const DEFAULT_SELLER = { taxNumber: '12345678', name: 'Example Trading LLC', tsp: '1234567' };
const WALK_IN = { id: '-', name: 'Cash customer' };
const DEFAULT_LINES: SampleLine[] = [
  { name: 'Widget', qty: 2, price: 10, discount: 1, taxRate: 16 },
  { name: 'Book', qty: 1, price: 5 },
];

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const amt = (n: number) => `currencyID="JO">${n.toFixed(9)}`;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Line math that produces live-API-accepted totals. */
export function computeLines(lines: SampleLine[]) {
  return lines.map((l) => {
    const gross = l.qty * l.price;
    const discount = l.discount ?? 0;
    const ext = Math.max(gross - discount, 0);
    const tax = round3((ext * (l.taxRate ?? 0)) / 100);
    return { ...l, gross, discount, ext, tax, net: ext + tax };
  });
}

function build(o: SampleOptions, credit?: { original: OriginalInvoice; reason: string }): string {
  const income = o.track === 'income';
  const seller = o.seller ?? DEFAULT_SELLER;
  const customer = o.customer ?? WALK_IN;
  const lines = computeLines((o.lines ?? DEFAULT_LINES).map((l) => (income ? { ...l, taxRate: 0 } : l)));
  const total = (k: 'gross' | 'discount' | 'tax' | 'net') => lines.reduce((s, l) => s + l[k], 0);
  const gross = total('gross'), discount = total('discount'), tax = total('tax'), payable = total('net');
  const typeCode = credit ? '381' : '388';
  const typeName = income ? '011' : credit ? '012' : (o.typeName ?? '012');
  const note = o.note ?? (credit ? credit.reason : '');

  const billing = credit
    ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${esc(credit.original.id)}</cbc:ID>
      <cbc:UUID>${esc(credit.original.uuid)}</cbc:UUID>
      <cbc:DocumentDescription>${credit.original.payable.toFixed(9)}</cbc:DocumentDescription>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>`
    : '';

  const invoiceLines = lines
    .map((l, i) => {
      const percent = l.ext > 0 && l.tax > 0 ? ((l.tax / l.ext) * 100).toFixed(2) : '0.00';
      const lineTax = income ? '' : `
    <cac:TaxTotal>
      <cbc:TaxAmount ${amt(l.tax)}</cbc:TaxAmount>
      <cbc:RoundingAmount ${amt(l.net)}</cbc:RoundingAmount>
      <cac:TaxSubtotal>
        <cbc:TaxAmount ${amt(l.tax)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${l.tax > 0 ? 'S' : 'Z'}</cbc:ID>
          <cbc:Percent>${percent}</cbc:Percent>
          <cac:TaxScheme>
            <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
          </cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>`;
      return `
  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${l.qty.toFixed(2)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount ${amt(l.ext)}</cbc:LineExtensionAmount>${lineTax}
    <cac:Item>
      <cbc:Name>${esc(l.name)}</cbc:Name>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount ${amt(l.price)}</cbc:PriceAmount>
      <cac:AllowanceCharge>
        <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
        <cbc:AllowanceChargeReason>DISCOUNT</cbc:AllowanceChargeReason>
        <cbc:Amount ${amt(l.discount)}</cbc:Amount>
      </cac:AllowanceCharge>
    </cac:Price>
  </cac:InvoiceLine>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(o.id ?? (credit ? `R_${credit.original.id}` : 'INV-001'))}</cbc:ID>
  <cbc:UUID>${esc(o.uuid ?? randomUUID())}</cbc:UUID>
  <cbc:IssueDate>${esc(o.issueDate ?? new Date().toISOString().slice(0, 10))}</cbc:IssueDate>
  <cbc:InvoiceTypeCode name="${typeName}">${typeCode}</cbc:InvoiceTypeCode>
  <cbc:Note>${esc(note)}</cbc:Note>
  <cbc:DocumentCurrencyCode>JOD</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>JOD</cbc:TaxCurrencyCode>${billing}
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${o.icv ?? 1}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PostalAddress>
        <cac:Country>
          <cbc:IdentificationCode>JO</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(seller.taxNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(seller.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="TN">${esc(customer.id)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:PostalZone/>
        <cbc:CountrySubentityCode/>
        <cac:Country>
          <cbc:IdentificationCode>JO</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(customer.id)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(customer.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
    <cac:AccountingContact>
      <cbc:Telephone/>
    </cac:AccountingContact>
  </cac:AccountingCustomerParty>
  <cac:SellerSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID>${esc(seller.tsp)}</cbc:ID>
      </cac:PartyIdentification>
    </cac:Party>
  </cac:SellerSupplierParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode listID="UN/ECE 4461">10</cbc:PaymentMeansCode>${credit ? `
    <cbc:InstructionNote>${esc(credit.reason)}</cbc:InstructionNote>` : ''}
  </cac:PaymentMeans>
  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>discount</cbc:AllowanceChargeReason>
    <cbc:Amount ${amt(discount)}</cbc:Amount>
  </cac:AllowanceCharge>${income ? '' : `
  <cac:TaxTotal>
    <cbc:TaxAmount ${amt(tax)}</cbc:TaxAmount>
  </cac:TaxTotal>`}
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount ${amt(gross)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount ${amt(credit ? payable : gross - discount + tax)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount ${amt(discount)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount ${amt(payable)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${invoiceLines}
</Invoice>
`;
}

/** A sales invoice (388) in the exact shape accepted by the live JoFotara API. */
export const sampleInvoice = (o: SampleOptions = {}) => build(o);

/** A full-return credit note (381) for `original`, in the live-API-accepted shape. */
export const sampleCreditNote = (original: OriginalInvoice, o: CreditNoteOptions = {}) =>
  build(o, { original, reason: o.reason ?? 'ارجاع فاتورة' });

/** Wrap XML in the JoFotara request body: `{"invoice": "<base64>"}`. */
export const toRequestBody = (xml: string) => JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') });
