import { GOVERNORATES, RULE_MAP, VAT_RATES } from './rules.ts';
import type { Confidence, RuleId, Severity } from './rules.ts';
import { NS, at, descendants, kids, parseXml, pathOf, qnameOf, text } from './xml.ts';
import type { El } from './xml.ts';

export interface Finding {
  rule: RuleId;
  severity: Severity;
  confidence: Confidence;
  source?: string;
  message: string;
  path?: string;
  fix: string;
}

export interface LineSummary {
  id: string;
  name: string;
  quantity: number;
  price: number;
  /** VAT category (S/Z/O); empty on income documents. */
  category: string;
  rate: number;
  extension: number;
  /** Line total including all taxes. */
  payable: number;
}

export interface InvoiceSummary {
  kind: 'invoice' | 'credit-note';
  /** income = 011/021 (no VAT), sales = 012/022, special = 013/023. */
  track: 'income' | 'sales' | 'special' | 'other';
  paymentTerms: 'cash' | 'receivable' | 'unknown';
  id: string;
  uuid: string;
  issueDate: string;
  typeCode: string;
  typeName: string;
  payable: number;
  lines: LineSummary[];
  billingReference?: { id: string; uuid: string; total: number };
}

export interface Report {
  ok: boolean;
  errors: number;
  warnings: number;
  findings: Finding[];
  invoice?: InvoiceSummary;
}

/** Absolute amount tolerance in JOD (1 fils); a small relative term absorbs precision on large values. */
export const EPS = 0.001;
export const near = (a: number, b: number, abs = EPS) => Math.abs(a - b) <= abs + 1e-6 * Math.max(Math.abs(a), Math.abs(b));

export const ORDER = [
  'cbc:ProfileID', 'cbc:ID', 'cbc:UUID', 'cbc:IssueDate', 'cbc:InvoiceTypeCode', 'cbc:Note',
  'cbc:DocumentCurrencyCode', 'cbc:TaxCurrencyCode', 'cac:BillingReference', 'cac:AdditionalDocumentReference',
  'cac:AccountingSupplierParty', 'cac:AccountingCustomerParty', 'cac:SellerSupplierParty', 'cac:PaymentMeans',
  'cac:AllowanceCharge', 'cac:TaxTotal', 'cac:LegalMonetaryTotal', 'cac:InvoiceLine',
];
// TaxTotal is track-dependent and PaymentMeans is only required on returns; both are checked separately.
const OPTIONAL = new Set(['cbc:Note', 'cac:BillingReference', 'cac:PaymentMeans', 'cac:TaxTotal']);
const REPEATABLE = new Set(['cac:AdditionalDocumentReference', 'cac:InvoiceLine']);
const AMOUNT_NAMES = new Set([
  'Amount', 'TaxAmount', 'RoundingAmount', 'LineExtensionAmount', 'PriceAmount', 'TaxableAmount',
  'TaxExclusiveAmount', 'TaxInclusiveAmount', 'AllowanceTotalAmount', 'PrepaidAmount', 'PayableAmount',
]);
const TRACKS: Record<string, InvoiceSummary['track']> = { 1: 'income', 2: 'sales', 3: 'special' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^\d+(\.\d+)?$/;

export function finding(rule: RuleId, message: string, el?: El): Finding {
  const { severity, confidence, source, fix } = RULE_MAP[rule];
  return { rule, severity, confidence, ...(source ? { source } : {}), message, ...(el ? { path: pathOf(el) } : {}), fix };
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
const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);

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
  const one = (q: string) => kids(root, q)[0];

  // ── Top-level structure ──────────────────────────────────────────────
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

  // ── Header ───────────────────────────────────────────────────────────
  const profile = one('cbc:ProfileID');
  if (profile && text(profile) !== 'reporting:1.0') add('JOF-HDR-001', `ProfileID is "${text(profile)}".`, profile);
  const idEl = one('cbc:ID');
  const id = text(idEl);
  if (idEl && !id) add('JOF-XML-003', 'Invoice number <cbc:ID> is empty.', idEl);
  const uuidEl = one('cbc:UUID');
  const uuid = text(uuidEl);
  if (uuidEl && !UUID_RE.test(uuid)) add('JOF-HDR-002', `UUID "${uuid}" is not a valid UUID.`, uuidEl);
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
  const nameMatch = /^0([12])([123])$/.exec(typeName);
  const track: InvoiceSummary['track'] = nameMatch ? TRACKS[nameMatch[2]] : 'other';
  const paymentTerms: InvoiceSummary['paymentTerms'] = nameMatch ? (nameMatch[1] === '1' ? 'cash' : 'receivable') : 'unknown';
  if (typeEl && !nameMatch) add('JOF-HDR-005', `InvoiceTypeCode name="${typeName}".`, typeEl);
  const income = track === 'income';
  const taxed = track === 'sales' || track === 'special';
  const salesReturn = kind === 'credit-note' && track === 'sales';

  const lineTaxTotals = kids(root, 'cac:InvoiceLine').map((l) => at(l, 'cac:TaxTotal')).filter((e) => e !== undefined);
  if (income && (seen.has('cac:TaxTotal') || lineTaxTotals.length)) {
    const where = [seen.has('cac:TaxTotal') && 'document level', lineTaxTotals.length && `${lineTaxTotals.length} line(s)`].filter(Boolean);
    add('JOF-INC-001', `Income document has TaxTotal at ${where.join(' and ')}.`, one('cac:TaxTotal') ?? lineTaxTotals[0]);
  }
  if (taxed && !seen.has('cac:TaxTotal')) add('JOF-INC-002', 'Sales document has no document-level <cac:TaxTotal>.', root);

  for (const q of ['cbc:DocumentCurrencyCode', 'cbc:TaxCurrencyCode']) {
    const el = one(q);
    if (el && text(el) !== 'JOD') add('JOF-HDR-007', `<${q}> is "${text(el)}".`, el);
  }
  if (seen.has('cac:AdditionalDocumentReference')) {
    const icv = kids(root, 'cac:AdditionalDocumentReference').find((a) => text(at(a, 'cbc:ID')) === 'ICV');
    const value = at(icv, 'cbc:UUID');
    if (!icv) add('JOF-XML-003', 'No <cac:AdditionalDocumentReference> with <cbc:ID>ICV</cbc:ID>.', root);
    else if (!/^[1-9]\d*$/.test(text(value))) add('JOF-HDR-008', `ICV is "${text(value)}".`, value ?? icv);
  }

  // ── Parties ──────────────────────────────────────────────────────────
  const seller = at(root, 'cac:AccountingSupplierParty/cac:Party');
  if (seller) {
    const taxNo = at(seller, 'cac:PartyTaxScheme/cbc:CompanyID');
    if (!text(taxNo)) add('JOF-PTY-001', 'Seller tax number is empty or missing.', taxNo ?? seller);
    else if (!/^\d+$/.test(text(taxNo))) add('JOF-PTY-004', `Seller tax number is "${text(taxNo)}".`, taxNo);
    if (!text(at(seller, 'cac:PartyLegalEntity/cbc:RegistrationName'))) add('JOF-PTY-002', 'Seller registered name is empty or missing.', seller);
  }
  if (seen.has('cac:SellerSupplierParty')) {
    const tsp = at(root, 'cac:SellerSupplierParty/cac:Party/cac:PartyIdentification/cbc:ID');
    if (!text(tsp)) add('JOF-PTY-003', 'Income source sequence is empty or missing.', tsp ?? one('cac:SellerSupplierParty'));
    else if (!/^\d+$/.test(text(tsp))) add('JOF-PTY-004', `Income source sequence is "${text(tsp)}".`, tsp);
  }
  const customer = at(root, 'cac:AccountingCustomerParty/cac:Party');
  for (const party of [seller, customer]) {
    const country = at(party, 'cac:PostalAddress/cac:Country/cbc:IdentificationCode');
    if (country && text(country) !== 'JO') add('JOF-PTY-008', `Country code is "${text(country)}".`, country);
  }
  const payableEl = at(root, 'cac:LegalMonetaryTotal/cbc:PayableAmount');
  const payable = num(payableEl);
  if (customer) {
    const buyerId = at(customer, 'cac:PartyIdentification/cbc:ID');
    const scheme = buyerId?.getAttribute('schemeID') ?? '';
    if (buyerId && (!['NIN', 'PN', 'TN'].includes(scheme) || !/^\d+$/.test(text(buyerId)))) {
      add('JOF-PTY-005', `Buyer ID is "${text(buyerId)}" with schemeID "${scheme}".`, buyerId);
    }
    const city = at(customer, 'cac:PostalAddress/cbc:CountrySubentityCode');
    if (text(city) && !GOVERNORATES.includes(text(city))) add('JOF-PTY-009', `CountrySubentityCode is "${text(city)}".`, city);
    if (kind === 'invoice' && !text(at(customer, 'cac:PartyLegalEntity/cbc:RegistrationName')) && (paymentTerms === 'receivable' || payable > 10_000)) {
      add('JOF-PTY-007', `Buyer name is empty on a ${paymentTerms === 'receivable' ? 'receivable' : `${payable} JOD`} invoice.`, customer);
    }
  }
  const pmCode = at(root, 'cac:PaymentMeans/cbc:PaymentMeansCode');
  if (pmCode && (text(pmCode) !== '10' || pmCode.getAttribute('listID') !== 'UN/ECE 4461')) {
    add('JOF-PAY-001', `PaymentMeansCode is "${text(pmCode)}" with listID "${pmCode.getAttribute('listID') ?? ''}".`, pmCode);
  }

  // ── Amount formatting ────────────────────────────────────────────────
  const amounts = descendants(root).filter((e) => e.namespaceURI === NS.cbc && (e.hasAttribute('currencyID') || AMOUNT_NAMES.has(e.localName ?? '')));
  const groups: [RuleId, El[], (e: El) => string][] = [
    ['JOF-AMT-001', amounts.filter((e) => !DECIMAL.test(text(e)) && !/^-\d/.test(text(e))), (e) => `"${text(e)}"`],
    ['JOF-AMT-002', amounts.filter((e) => e.getAttribute('currencyID') !== 'JO'), (e) => `currencyID="${e.getAttribute('currencyID') ?? ''}"`],
    ['JOF-AMT-003', amounts.filter((e) => num(e) < 0), (e) => `"${text(e)}"`],
  ];
  for (const [rule, bad, show] of groups) {
    if (bad.length) add(rule, `${bad.length} amount(s) affected, e.g. <${bad[0].tagName}> ${show(bad[0])}.`, bad[0]);
  }

  // ── Lines ────────────────────────────────────────────────────────────
  const lines = kids(root, 'cac:InvoiceLine');
  const sum = { gross: 0, discount: 0, tax: 0, special: 0 };
  const byRate = new Map<string, { category: string; rate: number; taxable: number; tax: number }>();
  const summaries: LineSummary[] = [];
  const lineIds = new Set<string>();

  lines.forEach((line, i) => {
    const n = i + 1;
    const need = (path: string) => {
      const el = at(line, path);
      if (!el) add('JOF-XML-003', `InvoiceLine ${n} is missing <${path}>.`, line);
      return el;
    };
    const lineId = text(at(line, 'cbc:ID'));
    if (!/^[1-9]\d*$/.test(lineId) || lineIds.has(lineId)) add('JOF-LIN-001', `InvoiceLine ${n} has ID "${lineId}"${lineIds.has(lineId) ? ' (duplicate)' : ''}.`, at(line, 'cbc:ID') ?? line);
    lineIds.add(lineId);

    const qtyEl = need('cbc:InvoicedQuantity');
    const extEl = need('cbc:LineExtensionAmount');
    const priceEl = need('cac:Price/cbc:PriceAmount');
    const discEl = at(line, 'cac:Price/cac:AllowanceCharge/cbc:Amount');
    const name = text(at(line, 'cac:Item/cbc:Name'));
    if (!name) add('JOF-LIN-005', `InvoiceLine ${n} has no item name.`, line);

    const qty = num(qtyEl), ext = num(extEl), price = num(priceEl);
    const discount = discEl ? num(discEl) : 0;
    if (qtyEl) {
      if (!DECIMAL.test(text(qtyEl))) add('JOF-LIN-003', `InvoiceLine ${n} quantity is "${text(qtyEl)}".`, qtyEl);
      else if (!(qty > 0)) add('JOF-LIN-002', `InvoiceLine ${n} quantity is "${text(qtyEl)}".`, qtyEl);
      if (qtyEl.getAttribute('unitCode') !== 'PCE') add('JOF-LIN-004', `InvoiceLine ${n} unitCode is "${qtyEl.getAttribute('unitCode') ?? ''}".`, qtyEl);
    }
    const expectedExt = qty * price - discount;
    if (extEl && !isNaN(expectedExt) && !near(ext, expectedExt)) {
      add('JOF-MTH-001', `InvoiceLine ${n}: LineExtensionAmount is ${text(extEl)}, expected ${fmt(expectedExt)} (${fmt(qty)} × ${fmt(price)} − ${fmt(discount)}).`, extEl);
    }

    let tax = 0, special = 0, category = '', rate = 0;
    if (taxed) {
      const taxTotal = at(line, 'cac:TaxTotal');
      const taxEl = need('cac:TaxTotal/cbc:TaxAmount');
      const roundEl = need('cac:TaxTotal/cbc:RoundingAmount');
      const subtotals = kids(taxTotal, 'cac:TaxSubtotal');
      const schemeOf = (st: El) => text(at(st, 'cac:TaxCategory/cac:TaxScheme/cbc:ID'));
      const vat = subtotals.find((st) => schemeOf(st) === 'VAT') ?? (track === 'sales' ? subtotals[0] : undefined);
      const oth = subtotals.find((st) => schemeOf(st) === 'OTH');
      if (track === 'special' && (!vat || !oth)) {
        add('JOF-INC-003', `InvoiceLine ${n} is missing its ${[!oth && 'OTH', !vat && 'VAT'].filter(Boolean).join(' and ')} TaxSubtotal.`, taxTotal ?? line);
      }
      else if (taxTotal && !vat) add('JOF-XML-003', `InvoiceLine ${n} is missing <cac:TaxSubtotal>.`, taxTotal);

      tax = num(taxEl);
      special = oth ? num(at(oth, 'cbc:TaxAmount')) : 0;
      const catEl = at(vat, 'cac:TaxCategory/cbc:ID');
      const pctEl = at(vat, 'cac:TaxCategory/cbc:Percent');
      category = text(catEl);
      rate = num(pctEl);
      if (vat && !catEl) add('JOF-XML-003', `InvoiceLine ${n} is missing <cac:TaxCategory/cbc:ID>.`, vat);
      if (vat && !pctEl) add('JOF-XML-003', `InvoiceLine ${n} is missing <cac:TaxCategory/cbc:Percent>.`, vat);

      if (catEl && !['S', 'Z', 'O'].includes(category)) {
        add('JOF-LIN-007', `InvoiceLine ${n}: category "${category}"${category === 'E' ? ' (use Z for exempt)' : ''}.`, catEl);
      } else if (catEl && pctEl) {
        if (!VAT_RATES.includes(rate)) add('JOF-LIN-009', `InvoiceLine ${n}: Percent is "${text(pctEl)}".`, pctEl);
        else if (category === 'S' ? rate === 0 : rate !== 0 || !near(tax, 0)) {
          add('JOF-LIN-006', `InvoiceLine ${n}: category ${category} with ${text(pctEl)}% and tax ${text(taxEl)}.`, catEl);
        }
      }
      const vatBase = ext + special;
      if (!isNaN(rate) && !isNaN(tax) && !isNaN(vatBase) && !near(tax, (vatBase * rate) / 100, 0.006)) {
        add('JOF-LIN-008', `InvoiceLine ${n}: tax ${text(taxEl)}, expected ${fmt((vatBase * rate) / 100)} (${fmt(vatBase)} × ${fmt(rate)}%).`, taxEl ?? line);
      }
      if (roundEl && !isNaN(ext + tax + special) && !near(num(roundEl), ext + tax + special)) {
        add('JOF-MTH-002', `InvoiceLine ${n}: RoundingAmount is ${text(roundEl)}, expected ${fmt(ext + tax + special)}.`, roundEl);
      }
      const vatSub = at(vat, 'cbc:TaxAmount');
      if (vatSub && !isNaN(tax) && !near(num(vatSub), tax)) add('JOF-MTH-003', `InvoiceLine ${n}: VAT TaxSubtotal is ${text(vatSub)}, line tax is ${text(taxEl)}.`, vatSub);
      for (const st of subtotals) {
        const taxable = at(st, 'cbc:TaxableAmount');
        if (taxable && !near(num(taxable), ext)) add('JOF-MTH-009', `InvoiceLine ${n}: TaxableAmount is ${text(taxable)}, line amount is ${text(extEl)}.`, taxable);
      }
      if (salesReturn && vat && !at(vat, 'cbc:TaxableAmount')) add('JOF-RET-006', `InvoiceLine ${n} has no TaxableAmount.`, vat);
      if (salesReturn) {
        const base = at(line, 'cac:Price/cbc:BaseQuantity');
        if (!base || text(base) !== '1' || base.getAttribute('unitCode') !== 'C62') add('JOF-RET-009', `InvoiceLine ${n} BaseQuantity is ${base ? `"${text(base)}" unitCode="${base.getAttribute('unitCode') ?? ''}"` : 'missing'}.`, base ?? line);
      }
      const key = `${category}:${rate}`;
      const g = byRate.get(key) ?? { category, rate, taxable: 0, tax: 0 };
      g.taxable += ext;
      g.tax += tax;
      byRate.set(key, g);
    }

    sum.gross += qty * price;
    sum.discount += discount;
    sum.tax += tax;
    sum.special += special;
    summaries.push({ id: lineId, name, quantity: qty, price, category, rate, extension: ext, payable: ext + tax + special });
  });

  // ── Document totals ──────────────────────────────────────────────────
  const docTaxTotal = one('cac:TaxTotal');
  // With an unknown type name the total formula is unknown too (JOF-HDR-005 already reported).
  if (track !== 'other' && lines.length && !isNaN(sum.gross + sum.discount + sum.tax + sum.special)) {
    const docTax = taxed ? at(docTaxTotal, 'cbc:TaxAmount') : undefined;
    if (docTaxTotal && taxed && !docTax) add('JOF-XML-003', 'Document <cac:TaxTotal> has no <cbc:TaxAmount>.', docTaxTotal);
    if (docTax && !near(num(docTax), sum.tax)) add('JOF-MTH-004', `Document TaxAmount is ${text(docTax)}, lines sum to ${fmt(sum.tax)}.`, docTax);

    const docSubs = kids(docTaxTotal, 'cac:TaxSubtotal');
    if (salesReturn && docTaxTotal && !docSubs.length) add('JOF-RET-010', 'Document TaxTotal has no TaxSubtotal.', docTaxTotal);
    if (track === 'sales' && docSubs.length) {
      const remaining = new Map(byRate);
      let subTax = 0;
      for (const st of docSubs) {
        const cat = text(at(st, 'cac:TaxCategory/cbc:ID'));
        const rate = num(at(st, 'cac:TaxCategory/cbc:Percent'));
        const g = remaining.get(`${cat}:${rate}`);
        const taxable = num(at(st, 'cbc:TaxableAmount')), stTax = num(at(st, 'cbc:TaxAmount'));
        subTax += stTax;
        if (!g) add('JOF-MTH-010', `Document TaxSubtotal ${cat} ${fmt(rate)}% matches no line.`, st);
        else if (!near(taxable, g.taxable) || !near(stTax, g.tax)) {
          add('JOF-MTH-010', `Document TaxSubtotal ${cat} ${fmt(rate)}%: ${fmt(taxable)} / ${fmt(stTax)}, lines give ${fmt(g.taxable)} / ${fmt(g.tax)}.`, st);
        }
        remaining.delete(`${cat}:${rate}`);
      }
      for (const g of remaining.values()) add('JOF-MTH-010', `No document TaxSubtotal for ${g.category} ${fmt(g.rate)}%.`, docTaxTotal);
      if (docTax && !near(subTax, num(docTax))) add('JOF-MTH-010', `Document subtotals sum to ${fmt(subTax)}, TaxAmount is ${text(docTax)}.`, docTax);
    }

    const docDisc = at(root, 'cac:AllowanceCharge/cbc:Amount');
    if (docDisc && !near(num(docDisc), sum.discount)) add('JOF-MTH-005', `Document AllowanceCharge is ${text(docDisc)}, line discounts sum to ${fmt(sum.discount)}.`, docDisc);

    const lmt = one('cac:LegalMonetaryTotal');
    if (lmt) {
      const get = (q: string) => {
        const el = at(lmt, q);
        if (!el) add('JOF-XML-003', `LegalMonetaryTotal is missing <${q}>.`, lmt);
        return el;
      };
      const excl = get('cbc:TaxExclusiveAmount'), incl = get('cbc:TaxInclusiveAmount'), allow = get('cbc:AllowanceTotalAmount');
      get('cbc:PayableAmount');
      const prepaid = at(lmt, 'cbc:PrepaidAmount');
      if (salesReturn && (!prepaid || num(prepaid) !== 0)) add('JOF-RET-011', `PrepaidAmount is ${prepaid ? `"${text(prepaid)}"` : 'missing'}.`, prepaid ?? lmt);
      if (excl && !near(num(excl), sum.gross)) add('JOF-MTH-006', `TaxExclusiveAmount is ${text(excl)}, expected ${fmt(sum.gross)}.`, excl);
      if (allow && !near(num(allow), sum.discount)) add('JOF-MTH-005', `AllowanceTotalAmount is ${text(allow)}, expected ${fmt(sum.discount)}.`, allow);
      const expectedIncl = sum.gross - sum.discount + sum.tax + sum.special;
      if (incl && !near(num(incl), expectedIncl)) add('JOF-MTH-007', `TaxInclusiveAmount is ${text(incl)}, expected ${fmt(expectedIncl)}.`, incl);
      const expectedPayable = expectedIncl - (prepaid ? num(prepaid) || 0 : 0);
      if (payableEl && !near(payable, expectedPayable)) add('JOF-MTH-008', `PayableAmount is ${text(payableEl)}, expected ${fmt(expectedPayable)}.`, payableEl);
    }
  }

  // ── Returns ──────────────────────────────────────────────────────────
  const billing = one('cac:BillingReference');
  let billingReference: InvoiceSummary['billingReference'];
  if (kind === 'credit-note') {
    const ref = at(billing, 'cac:InvoiceDocumentReference');
    const refId = at(ref, 'cbc:ID'), refUuid = at(ref, 'cbc:UUID'), refDesc = at(ref, 'cbc:DocumentDescription');
    if (!text(refId) || !refUuid || !refDesc) {
      add('JOF-RET-001', 'BillingReference/InvoiceDocumentReference must have ID, UUID and DocumentDescription.', ref ?? billing ?? root);
    }
    if (refUuid && !UUID_RE.test(text(refUuid))) add('JOF-RET-002', `BillingReference UUID is "${text(refUuid)}".`, refUuid);
    if (refUuid && text(refUuid) === uuid) add('JOF-RET-007', 'Return UUID equals the original invoice UUID.', uuidEl);
    if (refDesc && !DECIMAL.test(text(refDesc))) add('JOF-RET-003', `DocumentDescription is "${text(refDesc)}".`, refDesc);
    else if (refDesc && payable > num(refDesc) + EPS) add('JOF-RET-008', `Return PayableAmount ${text(payableEl)} exceeds the original total ${text(refDesc)}.`, payableEl);
    const reason = at(root, 'cac:PaymentMeans/cbc:InstructionNote');
    if (!text(reason)) add('JOF-RET-004', 'No return reason in PaymentMeans/InstructionNote.', reason ?? one('cac:PaymentMeans') ?? root);
    if (refUuid) billingReference = { id: text(refId), uuid: text(refUuid), total: num(refDesc) };
  } else if (kind === 'invoice' && billing) {
    add('JOF-RET-005', 'Invoice 388 has a BillingReference.', billing);
  }

  const summary = kind && id && uuid
    ? { kind, track, paymentTerms, id, uuid, issueDate, typeCode, typeName, payable, lines: summaries, ...(billingReference ? { billingReference } : {}) }
    : undefined;
  return report(out, summary);
}
