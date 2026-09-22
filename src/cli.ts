#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs, styleText } from 'node:util';
import { createMockServer } from './mock.ts';
import { RULES } from './rules.ts';
import { sampleCreditNote, sampleInvoice, toRequestBody } from './templates.ts';
import { validate } from './validate.ts';
import type { Report } from './validate.ts';

const HELP = `jofotara-kit — local tooling for JoFotara (Jordan ISTD e-invoicing) integrations

Usage:
  jofotara-kit validate [files...] [--json]    Validate XML, a {"invoice": base64} body, or base64 (stdin if no files)
  jofotara-kit serve [--port 8080] [--host 127.0.0.1] [--client-id ID] [--secret-key KEY] [--reject-status 400]
                                               Run a local mock of POST /core/invoices/
  jofotara-kit template <invoice|credit-note|income-invoice|income-credit-note> [--body]
                                               Print a production-shaped sample (or its JSON request body)
  jofotara-kit rules [--json]                  List every rule with severity and confidence

Exit codes: 0 ok, 1 validation errors, 2 usage error.
Not affiliated with the Income and Sales Tax Department (ISTD).`;

const color = (fmt: Parameters<typeof styleText>[0], s: string) => styleText(fmt, s);

function printReport(name: string, r: Report) {
  const kind = r.invoice ? `${r.invoice.kind} ${r.invoice.typeCode}/${r.invoice.typeName}` : 'unparsed';
  const head = r.ok ? color('green', 'PASS') : color('red', 'FAIL');
  console.log(`${head}  ${name}  (${kind}, ${r.errors} errors, ${r.warnings} warnings)`);
  for (const f of r.findings) {
    const sev = f.severity === 'error' ? color('red', 'error  ') : color('yellow', 'warning');
    console.log(`  ${sev} ${color('bold', f.rule)} ${f.message} ${color('dim', `[${f.confidence}]`)}`);
    if (f.path) console.log(color('dim', `          at ${f.path}`));
    console.log(color('dim', `          fix: ${f.fix}`));
  }
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'validate': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: 'boolean' } } });
      if (!positionals.length && process.stdin.isTTY) {
        console.error('validate: pass one or more files, or pipe input on stdin.');
        return 2;
      }
      const inputs = positionals.length
        ? positionals.map((file) => ({ file, content: readFileSync(file, 'utf8') }))
        : [{ file: '<stdin>', content: await readStdin() }];
      const results = inputs.map(({ file, content }) => ({ file, ...validate(content) }));
      if (values.json) console.log(JSON.stringify(results, null, 2));
      else results.forEach((r) => printReport(r.file, r));
      return results.every((r) => r.ok) ? 0 : 1;
    }
    case 'serve': {
      const { values } = parseArgs({
        args: rest,
        options: {
          port: { type: 'string', default: '8080' },
          host: { type: 'string', default: '127.0.0.1' },
          'client-id': { type: 'string' },
          'secret-key': { type: 'string' },
          'reject-status': { type: 'string', default: '400' },
        },
      });
      const server = createMockServer({
        clientId: values['client-id'],
        secretKey: values['secret-key'],
        rejectStatus: Number(values['reject-status']),
        log: (line) => console.log(line),
      });
      server.listen(Number(values.port), values.host, () => {
        console.log(`jofotara-kit mock listening on http://${values.host}:${values.port}/core/invoices/`);
        console.log(color('dim', 'NOT a tax authority. Passing here means "passes known rules", not "accepted by ISTD".'));
      });
      return new Promise(() => {});
    }
    case 'template': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { body: { type: 'boolean' } } });
      const original = { id: 'INV-001', uuid: '00000000-0000-4000-8000-000000000000' };
      const templates: Record<string, () => string> = {
        invoice: () => sampleInvoice(),
        'credit-note': () => sampleCreditNote({ ...original, payable: 27.04 }),
        'income-invoice': () => sampleInvoice({ track: 'income' }),
        'income-credit-note': () => sampleCreditNote({ ...original, payable: 24 }, { track: 'income', reason: 'ارجاع فاتورة دخل' }),
      };
      const build = templates[positionals[0] ?? ''];
      if (!build) {
        console.error(`template: expected one of ${Object.keys(templates).join(', ')}.`);
        return 2;
      }
      const xml = build();
      console.log(values.body ? toRequestBody(xml) : xml);
      return 0;
    }
    case 'rules': {
      const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
      if (values.json) console.log(JSON.stringify(RULES, null, 2));
      else for (const r of RULES) console.log(`${r.id}  ${r.severity.padEnd(7)}  ${r.confidence.padEnd(8)}  ${r.title}`);
      return 0;
    }
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e: Error) => {
    console.error(e.message);
    process.exitCode = 2;
  },
);
