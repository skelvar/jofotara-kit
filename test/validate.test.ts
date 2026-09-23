import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sampleCreditNote, sampleInvoice, toRequestBody } from '../src/templates.ts';
import { validate } from '../src/validate.ts';

const ORIGINAL = { id: 'INV-001', uuid: '3f2b8c1e-4d5a-4b6c-9e7f-1a2b3c4d5e6f', payable: 27.04 };
const invoice = sampleInvoice({ uuid: ORIGINAL.uuid });
const credit = sampleCreditNote(ORIGINAL);
const rules = (input: string) => validate(input).findings.map((f) => f.rule);

describe('validate', () => {
  it('accepts the production-shaped invoice with zero findings', () => {
    const r = validate(invoice);
    assert.deepEqual(r.findings, []);
    assert.equal(r.ok, true);
    assert.equal(r.invoice?.kind, 'invoice');
    assert.equal(r.invoice?.payable, 27.04);
  });

  it('accepts the production-shaped credit note with zero findings', () => {
    const r = validate(credit);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.invoice?.billingReference, { id: 'INV-001', uuid: ORIGINAL.uuid, total: 27.04 });
  });

  it('decodes the JSON request body and bare base64', () => {
    const body = toRequestBody(invoice);
    assert.equal(validate(body).ok, true);
    assert.equal(validate(JSON.parse(body).invoice).ok, true);
  });

  it('rejects broken envelopes', () => {
    assert.deepEqual(rules('{"xml": "abc"}'), ['JOF-ENV-001']);
    assert.deepEqual(rules('{"invoice": "!!!"}'), ['JOF-ENV-002']);
    assert.deepEqual(rules('{not json'), ['JOF-ENV-001']);
  });

  it('flags malformed XML and wrong root', () => {
    assert.deepEqual(rules('<Invoice><cbc:ID>'), ['JOF-XML-001']);
    assert.deepEqual(rules('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"/>'), ['JOF-XML-002']);
  });

  it('flags 2-decimal amounts and JOD currencyID', () => {
    assert.ok(rules(invoice.replace('27.040000000</cbc:PayableAmount>', '27.04</cbc:PayableAmount>')).includes('JOF-AMT-001'));
    assert.ok(rules(invoice.replaceAll('currencyID="JO"', 'currencyID="JOD"')).includes('JOF-AMT-002'));
  });

  it('flags a non-numeric ICV and a non-UUID document UUID', () => {
    assert.deepEqual(rules(invoice.replace('<cbc:UUID>1</cbc:UUID>', '<cbc:UUID>INV-001</cbc:UUID>')), ['JOF-HDR-008']);
    assert.deepEqual(rules(invoice.replace(ORIGINAL.uuid, 'INV-001')), ['JOF-HDR-002']);
  });

  it('flags wrong totals', () => {
    const r = rules(invoice.replace('27.040000000</cbc:PayableAmount>', '30.000000000</cbc:PayableAmount>'));
    assert.deepEqual(r, ['JOF-MTH-008']);
    assert.ok(rules(invoice.replace('<cbc:TaxAmount currencyID="JO">3.040000000</cbc:TaxAmount>\n  </cac:TaxTotal>', '<cbc:TaxAmount currencyID="JO">3.000000000</cbc:TaxAmount>\n  </cac:TaxTotal>')).includes('JOF-MTH-004'));
  });

  it('flags out-of-order elements', () => {
    const swapped = invoice.replace(
      /(<cbc:DocumentCurrencyCode>JOD<\/cbc:DocumentCurrencyCode>)(\s*)(<cbc:TaxCurrencyCode>JOD<\/cbc:TaxCurrencyCode>)/,
      '$3$2$1',
    );
    assert.deepEqual(rules(swapped), ['JOF-XML-004']);
  });

  it('flags tax category mismatch', () => {
    assert.ok(rules(invoice.replace('UN/ECE 5305">S<', 'UN/ECE 5305">Z<')).includes('JOF-LIN-006'));
  });

  it('requires a return reason and BillingReference on credit notes', () => {
    assert.deepEqual(rules(credit.replace(/<cbc:InstructionNote>.*<\/cbc:InstructionNote>/, '')), ['JOF-RET-004']);
    const noRef = credit.replace(/<cac:BillingReference>[\s\S]*<\/cac:BillingReference>/, '');
    assert.ok(rules(noRef).includes('JOF-RET-001'));
  });

  it('rejects the original invoice number used as BillingReference UUID', () => {
    assert.deepEqual(rules(credit.replace(`<cbc:UUID>${ORIGINAL.uuid}</cbc:UUID>`, '<cbc:UUID>INV-001</cbc:UUID>')), ['JOF-RET-002']);
  });

  it('requires a customer name on receivable invoices', () => {
    const receivable = sampleInvoice({ typeName: '022', customer: { id: '99887766', name: '' } });
    assert.deepEqual(rules(receivable), ['JOF-PTY-007']);
    assert.deepEqual(rules(sampleInvoice({ customer: { id: '-', name: '' } })), ['JOF-PTY-006']);
  });

  it('accepts income invoices and income returns (011, no TaxTotal)', () => {
    const inc = sampleInvoice({ track: 'income', uuid: ORIGINAL.uuid });
    const r = validate(inc);
    assert.deepEqual(r.findings, []);
    assert.equal(r.invoice?.track, 'income');
    assert.equal(r.invoice?.payable, 24);
    assert.deepEqual(validate(sampleCreditNote({ ...ORIGINAL, payable: 24 }, { track: 'income' })).findings, []);
  });

  it('rejects TaxTotal on income documents and its absence on sales documents', () => {
    const incomeWithTax = invoice.replace('name="012"', 'name="011"');
    assert.ok(rules(incomeWithTax).includes('JOF-INC-001'));
    const salesWithoutTax = sampleInvoice({ track: 'income' }).replace('name="011"', 'name="012"');
    assert.ok(rules(salesWithoutTax).includes('JOF-INC-002'));
  });

  it('classifies unverified names by track: 021 income, 013/023 sales', () => {
    const inc021 = validate(sampleInvoice({ track: 'income' }).replace('name="011"', 'name="021"'));
    assert.deepEqual(inc021.findings.map((f) => f.rule), ['JOF-HDR-006']);
    assert.equal(inc021.invoice?.track, 'income');
    const special = validate(invoice.replace('name="012"', 'name="013"'));
    assert.deepEqual(special.findings.map((f) => f.rule), ['JOF-HDR-006']);
    assert.equal(special.invoice?.track, 'sales');
    assert.deepEqual(rules(invoice.replace('name="012"', 'name="099"')), ['JOF-HDR-005']);
  });

  it('rejects a credit note larger than the original total', () => {
    assert.deepEqual(rules(sampleCreditNote({ ...ORIGINAL, payable: 10 })), ['JOF-RET-008']);
  });

  it('escapes Arabic and special characters correctly', () => {
    const r = validate(sampleInvoice({ lines: [{ name: 'كتاب & قلم <A4>', qty: 1, price: 5, taxRate: 16 }] }));
    assert.deepEqual(r.findings, []);
  });
});
