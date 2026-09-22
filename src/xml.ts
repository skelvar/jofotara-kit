import { DOMParser } from '@xmldom/xmldom';
import type { Element } from '@xmldom/xmldom';

export type El = Element;

export const NS = {
  inv: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
} as const;

export function parseXml(xml: string): { root?: El; error?: string } {
  let error: string | undefined;
  try {
    const doc = new DOMParser({
      onError: (level, message) => {
        if (level !== 'warning') error ??= message;
      },
    }).parseFromString(xml, 'text/xml');
    const root = doc.documentElement ?? undefined;
    return error || !root ? { error: error ?? 'empty document' } : { root };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function qnameOf(el: El): string | undefined {
  const prefix = el.namespaceURI === NS.cbc ? 'cbc' : el.namespaceURI === NS.cac ? 'cac' : undefined;
  return prefix && `${prefix}:${el.localName}`;
}

/** Direct element children, optionally filtered by `cac:Name` / `cbc:Name` (namespace-aware, prefix-agnostic). */
export function kids(el: El | undefined, qname?: string): El[] {
  const out: El[] = [];
  for (let n = el?.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!qname || qnameOf(n as El) === qname)) out.push(n as El);
  }
  return out;
}

/** First element along a `cac:A/cbc:B` path of direct children. */
export function at(el: El | undefined, path: string): El | undefined {
  return path.split('/').reduce<El | undefined>((cur, q) => cur && kids(cur, q)[0], el);
}

export function descendants(el: El): El[] {
  return kids(el).flatMap((k) => [k, ...descendants(k)]);
}

export const text = (el?: El): string => el?.textContent?.trim() ?? '';

export function pathOf(el: El): string {
  const parts: string[] = [];
  for (let e: El | null = el; e; e = e.parentNode?.nodeType === 1 ? (e.parentNode as El) : null) {
    const parent = e.parentNode?.nodeType === 1 ? (e.parentNode as El) : undefined;
    const same = parent ? kids(parent).filter((s) => s.tagName === e!.tagName) : [e];
    parts.unshift(same.length > 1 ? `${e.tagName}[${same.indexOf(e) + 1}]` : e.tagName);
  }
  return '/' + parts.join('/');
}
