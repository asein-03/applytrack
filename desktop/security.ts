export function isTrustedPage(value: string, origin: string): boolean {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; } catch { return false; }
}
export function externalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) return null;
    if (/[\x00-\x1f\x7f]/.test(value) || value.length > 8000) return null;
    if (url.protocol !== 'mailto:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
