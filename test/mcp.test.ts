import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.ts';
import { sampleInvoice } from '../src/templates.ts';

const client = new Client({ name: 'test', version: '0.0.0' });
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content[0].text, isError: res.isError };
};

describe('mcp server', () => {
  before(async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer('0.0.0').connect(serverSide);
    await client.connect(clientSide);
  });
  after(() => client.close());

  it('lists the four tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['explain_rule', 'get_template', 'list_rules', 'validate_invoice']);
  });

  it('validate_invoice returns the report', async () => {
    const ok = JSON.parse((await call('validate_invoice', { input: sampleInvoice() })).text);
    assert.equal(ok.ok, true);
    const bad = JSON.parse((await call('validate_invoice', { input: sampleInvoice().replaceAll('currencyID="JO"', 'currencyID="JOD"') })).text);
    assert.deepEqual(bad.findings.map((f: { rule: string }) => f.rule), ['JOF-AMT-002']);
  });

  it('get_template returns XML or a request body', async () => {
    assert.match((await call('get_template', { name: 'income-invoice' })).text, /name="011">388</);
    assert.ok(JSON.parse((await call('get_template', { name: 'invoice', format: 'request-body' })).text).invoice);
  });

  it('explain_rule explains known ids and errors on unknown ones', async () => {
    assert.equal(JSON.parse((await call('explain_rule', { id: 'jof-amt-001' })).text).id, 'JOF-AMT-001');
    assert.equal((await call('explain_rule', { id: 'NOPE' })).isError, true);
  });
});
