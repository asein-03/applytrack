import { Buffer } from 'node:buffer';
export type GmailPart = { mimeType?: string; filename?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: Array<{ name: string; value: string }> };
const MAX_BODY_BYTES = 64_000;
const MAX_MIME_PARTS = 200;
type BodyBudget = { bytes: number; parts: number };

export function extractBody(part: GmailPart, depth = 0): string {
  return extractPart(part, depth, { bytes: MAX_BODY_BYTES, parts: MAX_MIME_PARTS });
}
function decodePart(value: string | undefined, budget: BodyBudget): string {
  if (typeof value !== 'string' || !budget.bytes) return '';
  const bytes = Buffer.from(value.slice(0, Math.ceil(budget.bytes / 3) * 4), 'base64url').subarray(0, budget.bytes);
  budget.bytes -= bytes.length;
  return bytes.toString('utf8');
}
function extractPart(part: GmailPart, depth: number, budget: BodyBudget): string {
  if (depth > 20 || !part || typeof part !== 'object' || !budget.parts || !budget.bytes) return '';
  budget.parts--;
  if (part.filename) return '';
  if (part.mimeType === 'text/plain') return decodePart(part.body?.data, budget);
  const children = Array.isArray(part.parts) ? part.parts.slice(0, MAX_MIME_PARTS) : [];
  if (part.mimeType === 'multipart/alternative') {
    for (const child of children) {
      if (!budget.parts || !budget.bytes) break;
      if (child?.mimeType === 'text/plain') { const text = extractPart(child, depth + 1, budget); if (text.trim()) return text; }
    }
    for (const child of children) {
      if (!budget.parts || !budget.bytes) break;
      if (child?.mimeType === 'text/plain') continue;
      const text = extractPart(child, depth + 1, budget); if (text.trim()) return text;
    }
    return '';
  }
  const texts: string[] = [];
  for (const child of children) {
    if (!budget.parts || !budget.bytes) break;
    const text = extractPart(child, depth + 1, budget); if (text) texts.push(text);
  }
  if (texts.length) return texts.join('\n');
  if (part.mimeType === 'text/html') return htmlText(decodePart(part.body?.data, budget));
  return '';
}

function htmlText(html: string): string {
  const lower = html.toLowerCase();
  const text: string[] = [];
  const links: string[] = [];
  let cursor = 0; let quotes = 0; let raw: string | null = null;
  while (cursor < html.length) {
    if (raw) {
      let end = lower.indexOf(`</${raw}`, cursor);
      while (end >= 0 && !/[\s/>]/.test(lower[end + raw.length + 2] || '')) end = lower.indexOf(`</${raw}`, end + raw.length + 2);
      if (end < 0) break;
      cursor = end; raw = null;
    }
    const start = html.indexOf('<', cursor);
    if (!quotes) text.push(html.slice(cursor, start < 0 ? html.length : start));
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) break;
      cursor = end + 3; continue;
    }
    let end = start + 1; let quote = '';
    for (; end < html.length; end++) {
      const character = html[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === html.length) break;
    cursor = end + 1;
    const tag = html.slice(start + 1, end);
    const match = /^\s*(\/?)\s*([a-z][a-z0-9]*)\b/i.exec(tag);
    if (!match) continue;
    const closing = !!match[1]; const name = match[2].toLowerCase();
    if (name === 'script' || name === 'style') { if (!closing) raw = name; continue; }
    if (name === 'blockquote') { quotes = Math.max(0, quotes + (closing ? -1 : 1)); continue; }
    if (quotes) continue;
    if (name === 'a') {
      if (closing) { const link = links.pop(); if (link) text.push(` ${link}`); }
      else {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
        const value = href?.[1] ?? href?.[2] ?? '';
        links.push(/^https:\/\/[^\s<>"']+$/i.test(value) ? value : '');
      }
    }
    if (name === 'br' || (closing && ['p', 'div', 'li'].includes(name))) text.push('\n');
    else if (name !== 'a') text.push(' ');
  }
  return text.join('').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

