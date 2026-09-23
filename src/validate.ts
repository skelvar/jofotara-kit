import { RULE_MAP } from './rules.ts';
import type { Confidence, RuleId, Severity } from './rules.ts';
import { NS, at, descendants, kids, parseXml, pathOf, qnameOf, text } from './xml.ts';
import type { El } from './xml.ts';

export interface Finding {
  rule: RuleId;
  severity: Severity;
  confidence: Confidence;
  message: string;
  path?: string;
  fix: string;
}

export interface InvoiceSummary {
  kind: 'invoice' | 'credit-note';
  /** income = name 011/021 (no VAT), sales = 012/022/013/023. */
  track: 'income' | 'sales' | 'other';
  id: string;
  uuid: string;
  issueDate: string;
  typeCode: string;
  typeName: string;
  payable: number;
  billingReference?: { id: string; uuid: string; total: number };
}

export interface Report {
  ok: boolean;
  errors: number;
  warnings: number;
  findings: Finding[];
  invoice?: InvoiceSummary;
}

/** Amount comparison tolerance in JOD (1 fils). */
export const EPS = 0.001;

export const ORDER = [
  'cbc:ProfileID', 'cbc:ID', 'cbc:UUID', 'cbc:IssueDate', 'cbc:InvoiceTypeCode', 'cbc:Note',
  'cbc:DocumentCurrencyCode', 'cbc:TaxCurrencyCode', 'cac:BillingReference', 'cac:AdditionalDocumentReference',
  'cac:AccountingSupplierParty', 'cac:AccountingCustomerParty', 'cac:SellerSupplierParty', 'cac:PaymentMeans',
  'cac:AllowanceCharge', 'cac:TaxTotal', 'cac:LegalMonetaryTotal', 'cac:InvoiceLine',
];
// cac:TaxTotal is track-dependent: required for sales, forbidden for income (checked separately).
const OPTIONAL = new Set(['cbc:Note', 'cac:BillingReference', 'cac:AllowanceCharge', 'cac:TaxTotal']);
const INCOME_NAMES = new Set(['011', '021']);
const SALES_NAMES = new Set(['012', '022', '013', '023']);
const VERIFIED_NAMES = new Set(['011', '012', '022']);
const REPEATABLE = new Set(['cac:AdditionalDocumentReference', 'cac:InvoiceLine']);
const AMOUNT_NAMES = new Set([
  'Amount', 'TaxAmount', 'RoundingAmount', 'LineExtensionAmount', 'PriceAmount',
  'TaxExclusiveAmount', 'TaxInclusiveAmount', 'AllowanceTotalAmount', 'PayableAmount',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NINE_DP = /^-?\d+\.\d{9}$/;
const TWO_DP = /^\d+\.\d{2}$/;

export function finding(rule: RuleId, message: string, el?: El): Finding {
  const r = RULE_MAP[rule];
  return { rule, severity: r.severity, confidence: r.confidence, message, ...(el ? { path: pathOf(el) } : {}), fix: r.fix };
}

export function report(findings: Finding[], invoice?: InvoiceSummary): Report {
  const errors = findings.filter((f) => f.severity === 'error').length;
  return { ok: errors === 0, errors, warnings: findings.length - errors, findings, ...(invoice ? { invoice } : {}) };
}

type Decoded = { xml?: string; findings: Finding[] };

function decodeBase64(value: string): Decoded {
  const clean = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 === 1) {
    return { findings: [finding('JOF-ENV-002', 'The "invoice" value is not valid base64.')] };
  }
  const xml = Buffer.from(clean, 'base64').toString('utf8').replace(/^\uFEFF/, '');
  return xml.trimStart().startsWith('<')
    ? { xml, findings: [] }
    : { findings: [finding('JOF-ENV-002', 'The decoded "invoice" value is not XML.')] };
}

/** Decode a JoFotara request body: `{"invoice": "<base64 xml>"}`. */
export function decodeEnvelope(body: string): Decoded {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { findings: [finding('JOF-ENV-001', 'Request body is not valid JSON.')] };
  }
  const invoice = (parsed as { invoice?: unknown } | null)?.invoice;
  return typeof invoice === 'string'
    ? decodeBase64(invoice)
    : { findings: [finding('JOF-ENV-001', 'Request body has no "invoice" string field.')] };
}

/** Validate raw XML, a JSON request body, or a bare base64 string. */
export function validate(input: string): Report {
  const s = input.replace(/^\uFEFF/, '').trim();
  const decoded: Decoded = s.startsWith('<') ? { xml: s, findings: [] } : s.startsWith('{') ? decodeEnvelope(s) : decodeBase64(s);
  return decoded.xml === undefined ? report(decoded.findings) : validateXml(decoded.xml);
}

const num = (el?: El): number => {
  const t = text(el);
  return t === '' ? NaN : Number(t);
};
const near = (a: number, b: number) => Math.abs(a - b) <= EPS;
const f9 = (n: number) => n.toFixed(9);

function isIsoDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validateXml(xml: string): Report {
  const out: Finding[] = [];
  const add = (rule: RuleId, message: string, el?: El) => void out.push(finding(rule, message, el));

  const { root, error } = parseXml(xml.replace(/^\uFEFF/, ''));
  if (!root) return report([finding('JOF-XML-001', `XML is not well-formed: ${error}`)]);
  if (root.localName !== 'Invoice' || root.namespaceURI !== NS.inv) {
    return report([finding('JOF-XML-002', `Root element is <${root.tagName}> in namespace "${root.namespaceURI ?? ''}".`, root)]);
  }

  // Top-level structure
  const seen = new Map<string, number>();
  let last = -1;
  let orderReported = false;
  for (const el of kids(root)) {
    if (el.namespaceURI === NS.ext) continue;
    const q = qnameOf(el);
    const idx = q ? ORDER.indexOf(q) : -1;
    if (!q || idx < 0) {
      add('JOF-XML-005', `Unexpected top-level element <${el.tagName}>.`, el);
      continue;
    }
    seen.set(q, (seen.get(q) ?? 0) + 1);
    if (idx < last && !orderReported) {
      add('JOF-XML-004', `<${q}> must come before <${ORDER[last]}>.`, el);
      orderReported = true;
    }
    last = Math.max(last, idx);
  }
  for (const [q, n] of seen) if (n > 1 && !REPEATABLE.has(q)) add('JOF-XML-006', `<${q}> appears ${n} times.`, kids(root, q)[1]);
  for (const q of ORDER) if (!OPTIONAL.has(q) && !seen.has(q)) add('JOF-XML-003', `Missing required element <${q}>.`, root);
  if (!seen.has('cbc:Note')) add('JOF-HDR-009', 'No <cbc:Note> element.', root);

  // Header
  const one = (q: string) => kids(root, q)[0];
  const profile = one('cbc:ProfileID');
  if (profile && text(profile) !== 'reporting:1.0') add('JOF-HDR-001', `ProfileID is "${text(profile)}".`, profile);
  const idEl = one('cbc:ID');
  const id = text(idEl);
  if (idEl && !id) add('JOF-XML-003', 'Invoice number <cbc:ID> is empty.', idEl);
  const uuidEl = one('cbc:UUID');
  const uuid = text(uuidEl);
  if (uuidEl && !UUID_RE.test(uuid)) add('JOF-HDR-002', `UUID "${uuid}" is not an RFC 4122 UUID.`, uuidEl);
  const dateEl = one('cbc:IssueDate');
  const issueDate = text(dateEl);
  if (dateEl && !isIsoDate(issueDate)) add('JOF-HDR-003', `IssueDate is "${issueDate}".`, dateEl);
  else if (dateEl && issueDate > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) {
    add('JOF-HDR-010', `IssueDate ${issueDate} is in the future.`, dateEl);
  }

  const typeEl = one('cbc:InvoiceTypeCode');
  const typeCode = text(typeEl);
  const typeName = typeEl?.getAttribute('name') ?? '';
  const kind: InvoiceSummary['kind'] | undefined = typeCode === '381' ? 'credit-note' : typeCode === '388' ? 'invoice' : undefined;
  if (typeEl && !kind) add('JOF-HDR-004', `InvoiceTypeCode is "${typeCode}".`, typeEl);
  // name = <payment><track>: 0[1 cash|2 receivable][1 income|2 general sales|3 special sales].
  const track: InvoiceSummary['track'] = INCOME_NAMES.has(typeName) ? 'income' : SALES_NAMES.has(typeName) ? 'sales' : 'other';
  const income = track === 'income';
  if (typeEl && !VERIFIED_NAMES.has(typeName)) {
    add(track === 'other' ? 'JOF-HDR-005' : 'JOF-HDR-006', `InvoiceTypeCode name="${typeName}".`, typeEl);
  }
  const lineTaxTotals = kids(root, 'cac:InvoiceLine').map((l) => at(l, 'cac:TaxTotal')).filter((e) => e !== undefined);
  if (income && (seen.has('cac:TaxTotal') || lineTaxTotals.length)) {
    const where = [seen.has('cac:TaxTotal') && 'document level', lineTaxTotals.length && `${lineTaxTotals.length} line(s)`].filter(Boolean);
    add('JOF-INC-001', `Income document has TaxTotal at ${where.join(' and ')}.`, one('cac:TaxTotal') ?? lineTaxTotals[0]);
  }
  if (track === 'sales' && !seen.has('cac:TaxTotal')) add('JOF-INC-002', 'Sales document has no document-level <cac:TaxTotal>.', root);
  for (const q of ['cbc:DocumentCurrencyCode', 'cbc:TaxCurrencyCode']) {
    const el = one(q);
    if (el && text(el) !== 'JOD') add('JOF-HDR-007', `<${q}> is "${text(el)}".`, el);
  }
  if (seen.has('cac:AdditionalDocumentReference')) {
    const icv = kids(root, 'cac:AdditionalDocumentReference').find((a) => text(at(a, 'cbc:ID')) === 'ICV');
    const value = at(icv, 'cbc:UUID');
    if (!icv) add('JOF-XML-003', 'No <cac:AdditionalDocumentReference> with <cbc:ID>ICV</cbc:ID>.', root);
    else if (!/^\d+$/.test(text(value))) add('JOF-HDR-008', `ICV is "${text(value)}".`, value ?? icv);
  }

  // Parties
  const seller = at(root, 'cac:AccountingSupplierParty/cac:Party');
  if (seller) {
    const taxNo = at(seller, 'cac:PartyTaxScheme/cbc:CompanyID');
    if (!text(taxNo)) add('JOF-PTY-001', 'Seller tax number is empty or missing.', taxNo ?? seller);
    else if (!/^\d+$/.test(text(taxNo))) add('JOF-PTY-004', `Seller tax number is "${text(taxNo)}".`, taxNo);
    const name = at(seller, 'cac:PartyLegalEntity/cbc:RegistrationName');
    if (!text(name)) add('JOF-PTY-002', 'Seller registration name is empty or missing.', name ?? seller);
  }
  const tspParty = at(root, 'cac:SellerSupplierParty/cac:Party');
  if (seen.has('cac:SellerSupplierParty')) {
    const tsp = at(tspParty, 'cac:PartyIdentification/cbc:ID');
    if (!text(tsp)) add('JOF-PTY-003', 'Income source sequence is empty or missing.', tsp ?? tspParty ?? one('cac:SellerSupplierParty'));
    else if (!/^\d+$/.test(text(tsp))) add('JOF-PTY-004', `Income source sequence is "${text(tsp)}".`, tsp);
  }
  for (const party of [seller, at(root, 'cac:AccountingCustomerParty/cac:Party')]) {
    const country = at(party, 'cac:PostalAddress/cac:Country/cbc:IdentificationCode');
    if (country && text(country) !== 'JO') add('JOF-PTY-008', `Country code is "${text(country)}".`, country);
  }

  const payableEl = at(root, 'cac:LegalMonetaryTotal/cbc:PayableAmount');
  const payable = num(payableEl);
  const customer = at(root, 'cac:AccountingCustomerParty/cac:Party');
  if (customer) {
    const custId = at(customer, 'cac:PartyIdentification/cbc:ID');
    const scheme = custId?.getAttribute('schemeID') ?? '';
    if (custId && scheme !== 'TN') add('JOF-PTY-005', `Customer ID schemeID is "${scheme}".`, custId);
    if (kind === 'invoice' && !text(at(customer, 'cac:PartyLegalEntity/cbc:RegistrationName'))) {
      if (typeName === '022' || payable > 10_000) add('JOF-PTY-007', 'Customer name is empty on a receivable or > 10,000 JOD invoice.', customer);
      else add('JOF-PTY-006', 'Customer name is empty.', customer);
    }
  }

  const pmCode = at(root, 'cac:PaymentMeans/cbc:PaymentMeansCode');
  if (pmCode && (!['10', '42'].includes(text(pmCode)) || pmCode.getAttribute('listID') !== 'UN/ECE 4461')) {
    add('JOF-PAY-001', `PaymentMeansCode is "${text(pmCode)}" with listID "${pmCode.getAttribute('listID') ?? ''}".`, pmCode);
  }

  // Amount formatting
  const amounts = descendants(root).filter((e) => e.hasAttribute('currencyID') || AMOUNT_NAMES.has(e.localName ?? ''))
    .filter((e) => e.namespaceURI === NS.cbc);
  const groups: [RuleId, El[], (e: El) => string][] = [
    ['JOF-AMT-001', amounts.filter((e) => !NINE_DP.test(text(e))), (e) => `"${text(e)}"`],
    ['JOF-AMT-002', amounts.filter((e) => e.getAttribute('currencyID') !== 'JO'), (e) => `currencyID="${e.getAttribute('currencyID') ?? ''}"`],
    ['JOF-AMT-003', amounts.filter((e) => num(e) < 0), (e) => `"${text(e)}"`],
  ];
  for (const [rule, bad, show] of groups) {
    if (bad.length) add(rule, `${bad.length} amount(s) affected, e.g. <${bad[0].tagName}> ${show(bad[0])}.`, bad[0]);
  }

  // Lines
  const lines = kids(root, 'cac:InvoiceLine');
  const sum = { gross: 0, discount: 0, tax: 0, payable: 0 };
  lines.forEach((line, i) => {
    const n = i + 1;
    const need = (path: string, label: string) => {
      const el = at(line, path);
      if (!el) add('JOF-XML-003', `InvoiceLine ${n} is missing <${label}>.`, line);
      return el;
    };
    const lineId = at(line, 'cbc:ID');
    if (text(lineId) !== String(n)) add('JOF-LIN-001', `InvoiceLine ${n} has ID "${text(lineId)}".`, lineId ?? line);
    const qtyEl = need('cbc:InvoicedQuantity', 'cbc:InvoicedQuantity');
    const extEl = need('cbc:LineExtensionAmount', 'cbc:LineExtensionAmount');
    // Income lines carry no tax block at all (JOF-INC-001 reports it if present).
    const taxNeed = (path: string, label: string) => (income ? undefined : need(path, label));
    const taxEl = taxNeed('cac:TaxTotal/cbc:TaxAmount', 'cac:TaxTotal/cbc:TaxAmount');
    const roundEl = taxNeed('cac:TaxTotal/cbc:RoundingAmount', 'cac:TaxTotal/cbc:RoundingAmount');
    const subEl = taxNeed('cac:TaxTotal/cac:TaxSubtotal/cbc:TaxAmount', 'cac:TaxSubtotal/cbc:TaxAmount');
    const catEl = taxNeed('cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:ID', 'cac:TaxCategory/cbc:ID');
    const pctEl = income ? undefined : at(line, 'cac:TaxTotal/cac:TaxSubtotal/cac:TaxCategory/cbc:Percent');
    const priceEl = need('cac:Price/cbc:PriceAmount', 'cac:Price/cbc:PriceAmount');
    const discEl = at(line, 'cac:Price/cac:AllowanceCharge/cbc:Amount');
    if (!text(at(line, 'cac:Item/cbc:Name'))) add('JOF-LIN-005', `InvoiceLine ${n} has no item name.`, line);

    const qty = num(qtyEl), ext = num(extEl), tax = income ? 0 : num(taxEl), price = num(priceEl);
    const discount = discEl ? num(discEl) : 0;
    if (qtyEl) {
      if (!(qty > 0)) add('JOF-LIN-002', `InvoiceLine ${n} quantity is "${text(qtyEl)}".`, qtyEl);
      else if (!TWO_DP.test(text(qtyEl))) add('JOF-LIN-003', `InvoiceLine ${n} quantity is "${text(qtyEl)}".`, qtyEl);
      if (qtyEl.getAttribute('unitCode') !== 'PCE') add('JOF-LIN-004', `InvoiceLine ${n} unitCode is "${qtyEl.getAttribute('unitCode') ?? ''}".`, qtyEl);
    }

    const gross = qty * price;
    const expectedExt = Math.max(gross - discount, 0);
    if (extEl && !isNaN(expectedExt) && !near(ext, expectedExt)) {
      add('JOF-MTH-001', `InvoiceLine ${n}: LineExtensionAmount is ${text(extEl)}, expected ${f9(expectedExt)}.`, extEl);
    }
    if (roundEl && !isNaN(ext + tax) && !near(num(roundEl), ext + tax)) {
      add('JOF-MTH-002', `InvoiceLine ${n}: RoundingAmount is ${text(roundEl)}, expected ${f9(ext + tax)}.`, roundEl);
    }
    if (subEl && !isNaN(tax) && !near(num(subEl), tax)) add('JOF-MTH-003', `InvoiceLine ${n}: TaxSubtotal is ${text(subEl)}, line tax is ${text(taxEl)}.`, subEl);

    const cat = text(catEl);
    if (catEl) {
      const ok = cat === 'S' ? tax > 0 : (cat === 'Z' || cat === 'E') && near(tax, 0);
      if (!ok) add('JOF-LIN-006', `InvoiceLine ${n}: category "${cat}" with tax ${text(taxEl)}.`, catEl);
      if (cat === 'E') add('JOF-LIN-007', `InvoiceLine ${n} uses exempt category E.`, catEl);
    }
    if (pctEl) {
      const derived = ext > 0 && tax > 0 ? (tax / ext) * 100 : 0;
      if (!TWO_DP.test(text(pctEl)) || Math.abs(num(pctEl) - derived) > 0.05) {
        add('JOF-LIN-008', `InvoiceLine ${n}: Percent is "${text(pctEl)}", derived ${derived.toFixed(2)}.`, pctEl);
      }
    } else if (catEl) add('JOF-XML-003', `InvoiceLine ${n} is missing <cac:TaxCategory/cbc:Percent>.`, line);

    sum.gross += gross;
    sum.discount += discount;
    sum.tax += tax;
    sum.payable += ext + tax;
  });

  // Document totals
  if (lines.length && !isNaN(sum.payable)) {
    const docTax = income ? undefined : at(root, 'cac:TaxTotal/cbc:TaxAmount');
    if (docTax && !near(num(docTax), sum.tax)) add('JOF-MTH-004', `Document TaxAmount is ${text(docTax)}, lines sum to ${f9(sum.tax)}.`, docTax);
    const docDisc = at(root, 'cac:AllowanceCharge/cbc:Amount');
    if (docDisc && !near(num(docDisc), sum.discount)) add('JOF-MTH-005', `Document AllowanceCharge is ${text(docDisc)}, line discounts sum to ${f9(sum.discount)}.`, docDisc);

    const lmt = one('cac:LegalMonetaryTotal');
    if (lmt) {
      const get = (q: string) => {
        const el = at(lmt, q);
        if (!el) add('JOF-XML-003', `LegalMonetaryTotal is missing <${q}>.`, lmt);
        return el;
      };
      const excl = get('cbc:TaxExclusiveAmount'), incl = get('cbc:TaxInclusiveAmount'), allow = get('cbc:AllowanceTotalAmount');
      get('cbc:PayableAmount');
      if (excl && !near(num(excl), sum.gross)) add('JOF-MTH-006', `TaxExclusiveAmount is ${text(excl)}, expected ${f9(sum.gross)}.`, excl);
      if (allow && !near(num(allow), sum.discount)) add('JOF-MTH-005', `AllowanceTotalAmount is ${text(allow)}, expected ${f9(sum.discount)}.`, allow);
      const expectedIncl = kind === 'credit-note' ? sum.payable : sum.gross - sum.discount + sum.tax;
      if (incl && !near(num(incl), expectedIncl)) add('JOF-MTH-007', `TaxInclusiveAmount is ${text(incl)}, expected ${f9(expectedIncl)}.`, incl);
      if (payableEl && !near(payable, sum.payable)) add('JOF-MTH-008', `PayableAmount is ${text(payableEl)}, expected ${f9(sum.payable)}.`, payableEl);
    }
  }

  // Credit notes
  const billing = one('cac:BillingReference');
  let billingReference: InvoiceSummary['billingReference'];
  if (kind === 'credit-note') {
    const ref = at(billing, 'cac:InvoiceDocumentReference');
    const refId = at(ref, 'cbc:ID'), refUuid = at(ref, 'cbc:UUID'), refDesc = at(ref, 'cbc:DocumentDescription');
    if (!text(refId) || !refUuid || !refDesc) {
      add('JOF-RET-001', 'BillingReference/InvoiceDocumentReference must have ID, UUID and DocumentDescription.', ref ?? billing ?? root);
    }
    if (refUuid && !UUID_RE.test(text(refUuid))) add('JOF-RET-002', `BillingReference UUID is "${text(refUuid)}".`, refUuid);
    if (refUuid && text(refUuid) === uuid) add('JOF-RET-007', 'Credit note UUID equals the original invoice UUID.', uuidEl);
    if (refDesc && !NINE_DP.test(text(refDesc))) add('JOF-RET-003', `DocumentDescription is "${text(refDesc)}".`, refDesc);
    else if (refDesc && payable > num(refDesc) + EPS) {
      add('JOF-RET-008', `Credit note PayableAmount ${text(payableEl)} exceeds the original total ${text(refDesc)}.`, payableEl);
    }
    const reason = at(root, 'cac:PaymentMeans/cbc:InstructionNote');
    if (!text(reason)) add('JOF-RET-004', 'No return reason in PaymentMeans/InstructionNote.', reason ?? one('cac:PaymentMeans') ?? root);
    if (typeName === '022') add('JOF-RET-006', 'Credit note uses name="022".', typeEl);
    if (refUuid) billingReference = { id: text(refId), uuid: text(refUuid), total: num(refDesc) };
  } else if (kind === 'invoice' && billing) {
    add('JOF-RET-005', 'Invoice 388 has a BillingReference.', billing);
  }

  const summary = kind && id && uuid ? { kind, track, id, uuid, issueDate, typeCode, typeName, payable, ...(billingReference ? { billingReference } : {}) } : undefined;
  return report(out, summary);
}
