export const GMAIL_TESTING = true;
export const GMAIL_AUTH_PAGE = 'https://asein-03.github.io/applytrack/auth/';

export function safeGmailAuthorizationUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value), trusted = new URL(GMAIL_AUTH_PAGE);
    const states = url.searchParams.getAll('state');
    if (url.origin !== trusted.origin || url.pathname !== trusted.pathname || url.username || url.password || url.hash ||
      [...url.searchParams].length !== 1 || states.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(states[0])) return null;
    return url.href;
  } catch { return null; }
}
