import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { EPS, decodeEnvelope, finding, near, report, validateXml } from './validate.ts';
import type { Finding, InvoiceSummary } from './validate.ts';

export interface MockOptions {
  /** If set, only this Client-Id is accepted. Otherwise any non-empty value is. */
  clientId?: string;
  /** If set, only this Secret-Key is accepted. Otherwise any non-empty value is. */
  secretKey?: string;
  /** HTTP status for rejected invoices (default 400). Use 200 to test "HTTP 200 but rejected" handling. */
  rejectStatus?: number;
  log?: (line: string) => void;
}

export interface StoredInvoice extends InvoiceSummary {
  qr: string;
  receivedAt: string;
}

const NOTICE = 'Local jofotara-kit mock. NOT a tax document. Passing means "passes known rules", not "accepted by ISTD".';
const MAX_BODY = 5_000_000;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const toResult = (f: Finding) => ({
  type: f.severity === 'error' ? 'ERROR' : 'WARNING',
  status: f.severity === 'error' ? 'ERROR' : 'WARNING',
  EINV_CODE: f.rule,
  EINV_CATEGORY: f.rule.split('-')[1],
  EINV_MESSAGE: f.message,
});

export function createMockServer(opts: MockOptions = {}): Server {
  const accepted = new Map<string, StoredInvoice>();
  const log = opts.log ?? (() => {});

  function stateChecks(s: InvoiceSummary): Finding[] {
    const out: Finding[] = [];
    if (accepted.has(s.uuid)) out.push(finding('JOF-STA-001', `Document "${s.id}" / ${s.uuid} was already accepted.`));
    const sameNumber = [...accepted.values()].find((x) => x.id === s.id && x.uuid !== s.uuid);
    if (sameNumber) out.push(finding('JOF-STA-002', `Invoice number "${s.id}" was already accepted with UUID ${sameNumber.uuid}.`));
    const ref = s.billingReference;
    if (!ref) return out;
    const orig = accepted.get(ref.uuid);
    if (!orig || orig.kind !== 'invoice') {
      out.push(finding('JOF-STA-003', `BillingReference UUID ${ref.uuid} is not an invoice accepted by this mock.`));
      return out;
    }
    if (orig.id !== ref.id || !near(orig.payable, ref.total)) {
      out.push(finding('JOF-STA-004', `Original is "${orig.id}" / ${orig.payable}; reference says "${ref.id}" / ${ref.total}.`));
    }
    if (orig.typeName !== s.typeName) {
      out.push(finding('JOF-STA-007', `Original "${orig.id}" is name="${orig.typeName}"; this return is name="${s.typeName}".`));
    }
    if (s.issueDate < orig.issueDate) out.push(finding('JOF-STA-008', `Return dated ${s.issueDate}, original dated ${orig.issueDate}.`));

    const priorReturns = [...accepted.values()].filter((x) => x.billingReference?.uuid === ref.uuid);
    for (const line of s.lines) {
      const o = orig.lines.find((l) => l.id === line.id);
      if (!o) {
        out.push(finding('JOF-STA-009', `Return line ${line.id} ("${line.name}") has no line ${line.id} on the original invoice.`));
        continue;
      }
      const diffs = [
        o.name !== line.name && `name "${line.name}" vs "${o.name}"`,
        !near(o.price, line.price) && `price ${line.price} vs ${o.price}`,
        (o.category !== line.category || o.rate !== line.rate) && `tax ${line.category} ${line.rate}% vs ${o.category} ${o.rate}%`,
      ].filter(Boolean);
      if (diffs.length) out.push(finding('JOF-STA-009', `Return line ${line.id}: ${diffs.join(', ')} (original values required).`));
      const before = priorReturns.flatMap((r) => r.lines).filter((l) => l.id === line.id).reduce((t, l) => t + l.quantity, 0);
      if (before + line.quantity > o.quantity + 1e-9) {
        out.push(finding('JOF-STA-005', `Line ${line.id} ("${o.name}"): returning ${line.quantity} after ${before} already returned, but only ${o.quantity} were sold.`));
      }
    }
    const returned = priorReturns.reduce((t, x) => t + x.payable, 0);
    const lineOverReturn = out.some((f) => f.rule === 'JOF-STA-005');
    if (!lineOverReturn && returned + s.payable > orig.payable + EPS) {
      out.push(finding('JOF-STA-005', `Returns would total ${returned + s.payable} against an original total of ${orig.payable} (${returned} already returned).`));
    }
    return out;
  }

  function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
  }

  function reply(res: ServerResponse, status: number, findings: Finding[], stored?: StoredInvoice) {
    const errors = findings.filter((f) => f.severity === 'error');
    send(res, status, {
      EINV_RESULTS: {
        status: stored ? 'PASS' : 'ERROR',
        INFO: [],
        WARNINGS: findings.filter((f) => f.severity === 'warning').map(toResult),
        ERRORS: errors.map(toResult),
      },
      EINV_STATUS: stored ? 'SUBMITTED' : 'NOT_SUBMITTED',
      ...(stored ? { EINV_QR: stored.qr, EINV_INV_UUID: stored.uuid } : {}),
      JOFOTARA_KIT: { mock: true, notice: NOTICE, findings },
    });
  }

  async function submit(req: IncomingMessage, res: ServerResponse) {
    const clientId = req.headers['client-id'], secretKey = req.headers['secret-key'];
    if (!clientId || !secretKey) {
      log('POST /core/invoices/ -> 401 missing credentials');
      return reply(res, 401, [finding('JOF-AUTH-001', 'Missing Client-Id and/or Secret-Key header.')]);
    }
    if ((opts.clientId && clientId !== opts.clientId) || (opts.secretKey && secretKey !== opts.secretKey)) {
      log('POST /core/invoices/ -> 401 wrong credentials');
      return reply(res, 401, [finding('JOF-AUTH-002', 'Client-Id / Secret-Key do not match the credentials this mock was started with.')]);
    }

    const decoded = decodeEnvelope(await readBody(req));
    const base = decoded.xml === undefined ? report(decoded.findings) : validateXml(decoded.xml);
    const result = report(base.invoice ? [...base.findings, ...stateChecks(base.invoice)] : base.findings, base.invoice);
    const label = base.invoice ? `${base.invoice.id} ${base.invoice.typeCode}/${base.invoice.typeName}` : '(unparsed)';

    if (!result.ok || !result.invoice) {
      log(`POST /core/invoices/ ${label} -> NOT_SUBMITTED (${result.errors} errors, ${result.warnings} warnings)`);
      for (const f of result.findings) log(`  ${f.severity.padEnd(7)} ${f.rule}  ${f.message}`);
      return reply(res, opts.rejectStatus ?? 400, result.findings);
    }
    const inv = result.invoice;
    const qr = Buffer.from(`JOFOTARA-KIT MOCK|NOT A TAX DOCUMENT|${inv.id}|${inv.uuid}|${inv.issueDate}|${inv.payable.toFixed(3)}`).toString('base64');
    const stored: StoredInvoice = { ...inv, qr, receivedAt: new Date().toISOString() };
    accepted.set(inv.uuid, stored);
    log(`POST /core/invoices/ ${label} -> SUBMITTED (${result.warnings} warnings)`);
    reply(res, 200, result.findings, stored);
  }

  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'POST' && /^\/core\/invoices\/?$/.test(pathname)) return await submit(req, res);
      if (pathname === '/_kit/invoices' && req.method === 'GET') return send(res, 200, [...accepted.values()]);
      if (pathname === '/_kit/invoices' && req.method === 'DELETE') {
        accepted.clear();
        return send(res, 200, { cleared: true });
      }
      if (pathname === '/' && req.method === 'GET') {
        return send(res, 200, {
          name: 'jofotara-kit mock',
          notice: NOTICE,
          endpoints: {
            'POST /core/invoices/': 'Submit {"invoice": base64(xml)} with Client-Id / Secret-Key headers',
            'GET /_kit/invoices': 'List invoices accepted by this mock',
            'DELETE /_kit/invoices': 'Forget all accepted invoices',
          },
        });
      }
      send(res, 404, { error: `No route for ${req.method} ${pathname}` });
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });
}
