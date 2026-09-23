import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RULE_MAP, RULES } from './rules.ts';
import type { RuleId } from './rules.ts';
import { TEMPLATES, toRequestBody } from './templates.ts';
import type { TemplateName } from './templates.ts';
import { validate } from './validate.ts';

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

/** MCP server exposing the validator, templates and rule catalog to AI agents. */
export function createMcpServer(version: string): McpServer {
  const server = new McpServer({ name: 'jofotara-kit', version });

  server.registerTool('validate_invoice', {
    title: 'Validate JoFotara invoice',
    description:
      'Validate a JoFotara (Jordan ISTD e-invoicing) document before sending it. Accepts raw UBL 2.1 XML, the ' +
      '{"invoice": "<base64>"} request body, or bare base64. Returns ok/errors/warnings and every finding with rule id, ' +
      'path, confidence (verified/reported/inferred) and the exact fix. Run it on every XML you generate.',
    inputSchema: { input: z.string().describe('XML, JSON request body, or base64') },
  }, async ({ input }) => text(validate(input)));

  server.registerTool('get_template', {
    title: 'Get JoFotara sample document',
    description:
      'Return a sample document in the exact shape accepted by the live JoFotara API. Copy its element order, ' +
      'attributes and formatting; only values change. sales = 388/012 with VAT, income = 388/011 without TaxTotal.',
    inputSchema: {
      name: z.enum(Object.keys(TEMPLATES) as [TemplateName, ...TemplateName[]]),
      format: z.enum(['xml', 'request-body']).default('xml'),
    },
  }, async ({ name, format }) => {
    const xml = TEMPLATES[name]();
    return text(format === 'xml' ? xml : toRequestBody(xml));
  });

  server.registerTool('list_rules', {
    title: 'List JoFotara validation rules',
    description: 'List every rule the validator checks: id, severity, confidence, title and fix.',
    inputSchema: {},
  }, async () => text(RULES));

  server.registerTool('explain_rule', {
    title: 'Explain a JoFotara rule',
    description: 'Explain one rule id (e.g. JOF-AMT-001) from a validation finding: what it checks, how sure we are, how to fix it.',
    inputSchema: { id: z.string().describe('Rule id such as JOF-RET-002') },
  }, async ({ id }) => {
    const rule = RULE_MAP[id.trim().toUpperCase() as RuleId];
    return rule ? text(rule) : { ...text(`Unknown rule "${id}". Call list_rules for valid ids.`), isError: true };
  });

  return server;
}

export async function serveMcpStdio(version: string) {
  await createMcpServer(version).connect(new StdioServerTransport());
}
