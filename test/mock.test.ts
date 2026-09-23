import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createMockServer } from '../src/mock.ts';
import { DEFAULT_LINES, sampleCreditNote, sampleInvoice, samplePayable, toRequestBody } from '../src/templates.ts';
import type { SampleLine } from '../src/templates.ts';

const server = createMockServer({ clientId: 'id', secretKey: 'key' });
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(async () => {
  await fetch(`${base}/_kit/invoices`, { method: 'DELETE' });
});

async function submit(xml: string, headers: Record<string, string> = { 'Client-Id': 'id', 'Secret-Key': 'key' }) {
  const res = await fetch(`${base}/core/invoices/`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: toRequestBody(xml),
  });
  return { status: res.status, body: await res.json() };
}
const codes = (body: any) => body.EINV_RESULTS.ERRORS.map((e: any) => e.EINV_CODE);
const [widget, , book] = DEFAULT_LINES;
const oneWidget: SampleLine = { ...widget, qty: 1, discount: 0.5 };

async function acceptedOriginal(o: Parameters<typeof sampleInvoice>[0] = {}) {
  const original = { id: o.id ?? `INV-${randomUUID().slice(0, 8)}`, uuid: randomUUID(), payable: samplePayable(DEFAULT_LINES, o.track) };
  const res = await submit(sampleInvoice({ ...o, id: original.id, uuid: original.uuid }));
  assert.equal(res.status, 200);
  return original;
}

describe('mock server', () => {
  it('accepts a valid invoice and returns a QR string', async () => {
    const uuid = randomUUID();
    const { status, body } = await submit(sampleInvoice({ uuid }));
    assert.equal(status, 200);
    assert.equal(body.EINV_STATUS, 'SUBMITTED');
    assert.equal(body.EINV_INV_UUID, uuid);
    assert.match(Buffer.from(body.EINV_QR, 'base64').toString(), /^JOFOTARA-KIT MOCK\|NOT A TAX DOCUMENT/);
  });

  it('requires credentials', async () => {
    assert.equal((await submit(sampleInvoice(), {})).status, 401);
    assert.deepEqual(codes((await submit(sampleInvoice(), { 'Client-Id': 'id', 'Secret-Key': 'nope' })).body), ['JOF-AUTH-002']);
  });

  it('rejects invalid XML with NOT_SUBMITTED', async () => {
    const { status, body } = await submit(sampleInvoice().replaceAll('currencyID="JO"', 'currencyID="JOD"'));
    assert.equal(status, 400);
    assert.equal(body.EINV_STATUS, 'NOT_SUBMITTED');
    assert.deepEqual(codes(body), ['JOF-AMT-002']);
  });

  it('rejects resubmitting an accepted invoice', async () => {
    const xml = sampleInvoice({ uuid: randomUUID() });
    await submit(xml);
    assert.ok(codes((await submit(xml)).body).includes('JOF-STA-001'));
    assert.deepEqual(codes((await submit(sampleInvoice({ uuid: randomUUID() }))).body), ['JOF-STA-002']);
  });

  it('accepts a return only for an accepted original', async () => {
    const ghost = { id: 'INV-X', uuid: randomUUID(), payable: samplePayable() };
    assert.deepEqual(codes((await submit(sampleCreditNote(ghost))).body), ['JOF-STA-003']);
  });

  it('supports multiple partial returns until every quantity is returned', async () => {
    const original = await acceptedOriginal();
    const first = await submit(sampleCreditNote(original, { id: 'R1', lines: [oneWidget, book] }));
    assert.equal(first.status, 200, JSON.stringify(first.body.JOFOTARA_KIT.findings));
    const second = await submit(sampleCreditNote(original, { id: 'R2', lines: [oneWidget] }));
    assert.equal(second.status, 200);
    const third = await submit(sampleCreditNote(original, { id: 'R3', lines: [oneWidget] }));
    assert.deepEqual(codes(third.body), ['JOF-STA-005']);
    assert.match(third.body.EINV_RESULTS.ERRORS[0].EINV_MESSAGE, /after 2 already returned, but only 2 were sold/);
  });

  it('requires original line numbers, names, prices and tax on return lines', async () => {
    const original = await acceptedOriginal();
    assert.deepEqual(codes((await submit(sampleCreditNote(original, { lines: [{ ...book, id: 9 }] }))).body), ['JOF-STA-009']);
    assert.deepEqual(codes((await submit(sampleCreditNote(original, { lines: [{ ...book, price: 2 }] }))).body), ['JOF-STA-009']);
  });

  it('requires the return to mirror the original type name', async () => {
    const original = await acceptedOriginal({ paymentTerms: 'receivable', customer: { id: '99887766', name: 'Buyer' } });
    assert.deepEqual(codes((await submit(sampleCreditNote(original, { lines: [book] }))).body), ['JOF-STA-007']);
    const ok = await submit(sampleCreditNote(original, { paymentTerms: 'receivable', customer: { id: '99887766', name: 'Buyer' }, lines: [book] }));
    assert.equal(ok.status, 200);
  });

  it('handles income invoices and income returns', async () => {
    const original = await acceptedOriginal({ track: 'income' });
    const ret = await submit(sampleCreditNote(original, { track: 'income', lines: [oneWidget] }));
    assert.equal(ret.status, 200, JSON.stringify(ret.body.JOFOTARA_KIT.findings));
    assert.ok(codes((await submit(sampleCreditNote(original, { id: 'R-S', lines: [book] }))).body).includes('JOF-STA-007'));
  });
});
