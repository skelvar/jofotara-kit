import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createMockServer } from '../src/mock.ts';
import { sampleCreditNote, sampleInvoice, toRequestBody } from '../src/templates.ts';

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

describe('mock server', () => {
  it('accepts a valid invoice and returns a QR string', async () => {
    const uuid = randomUUID();
    const { status, body } = await submit(sampleInvoice({ uuid }));
    assert.equal(status, 200);
    assert.equal(body.EINV_STATUS, 'SUBMITTED');
    assert.equal(body.EINV_RESULTS.status, 'PASS');
    assert.equal(body.EINV_INV_UUID, uuid);
    assert.match(Buffer.from(body.EINV_QR, 'base64').toString(), /^JOFOTARA-KIT MOCK\|NOT A TAX DOCUMENT/);
  });

  it('requires credentials', async () => {
    assert.equal((await submit(sampleInvoice(), {})).status, 401);
    const wrong = await submit(sampleInvoice(), { 'Client-Id': 'id', 'Secret-Key': 'nope' });
    assert.deepEqual(codes(wrong.body), ['JOF-AUTH-002']);
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

  it('accepts a credit note only for an accepted original', async () => {
    const original = { id: 'INV-001', uuid: randomUUID(), payable: 27.04 };
    assert.deepEqual(codes((await submit(sampleCreditNote(original))).body), ['JOF-STA-003']);
    await submit(sampleInvoice({ uuid: original.uuid }));
    const { status, body } = await submit(sampleCreditNote(original));
    assert.equal(status, 200);
    assert.equal(body.EINV_STATUS, 'SUBMITTED');
    const list = await (await fetch(`${base}/_kit/invoices`)).json();
    assert.equal(list.length, 2);
  });

  it('tracks partial returns and rejects over-returns', async () => {
    const original = { id: 'INV-P', uuid: randomUUID(), payable: 27.04 };
    await submit(sampleInvoice({ id: original.id, uuid: original.uuid }));
    const widget = [{ name: 'Widget', qty: 2, price: 10, discount: 1, taxRate: 16 }];
    const first = await submit(sampleCreditNote(original, { id: 'R1', lines: widget }));
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.EINV_RESULTS.WARNINGS.map((w: any) => w.EINV_CODE), ['JOF-STA-006']);
    const again = await submit(sampleCreditNote(original, { id: 'R2', lines: widget }));
    assert.deepEqual(codes(again.body), ['JOF-STA-005']);
  });

  it('rejects a return on a different track than the original', async () => {
    const original = { id: 'INV-T', uuid: randomUUID(), payable: 27.04 };
    await submit(sampleInvoice({ id: original.id, uuid: original.uuid }));
    const incomeReturn = sampleCreditNote(original, { track: 'income', lines: [{ name: 'Widget', qty: 1, price: 27.04 }] });
    assert.deepEqual(codes((await submit(incomeReturn)).body), ['JOF-STA-007']);
  });
});
