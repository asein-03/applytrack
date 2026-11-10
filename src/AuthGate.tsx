import { createContext, Fragment, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { ArrowLeft, Check, EnvelopeSimple, WarningCircle } from '@phosphor-icons/react';
import { clearWorkspaceContext, getCloudClient, loadCloudConfig, prepareAccountWorkspace, type CloudConfig } from './cloud';
import './auth.css';

interface Account { enabled: boolean; email: string | null; signOut: (() => Promise<void>) | null; }
const AccountContext = createContext<Account>({ enabled: false, email: null, signOut: null });
export const useCloudAccount = () => useContext(AccountContext);

function AuthShell({ children }: { children: ReactNode }) {
  return <main className="auth-shell"><a className="brand auth-brand" href="/" aria-label="Apply"><span className="brand-mark"><Check size={22} weight="bold" /></span><span>Apply</span></a><div className="auth-panel">{children}</div></main>;
}

function AuthForm({ client, onSession, initialError }: { client: SupabaseClient; onSession: (session: Session) => void; initialError: string }) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [sent, setSent] = useState<'confirmation' | 'reset' | null>(null);
  function changeMode(next: typeof mode) { setMode(next); setPassword(''); setError(''); setSent(null); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (mode === 'signin') {
        const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        if (!data.session) throw new Error('Sign-in did not create a session. Try again.');
        onSession(data.session);
      } else if (mode === 'signup') {
        const { data, error } = await client.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` } });
        if (error) throw error;
        setPassword('');
        if (data.session) onSession(data.session); else setSent('confirmation');
      } else {
        const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}${window.location.pathname}` });
        if (error) throw error;
        setSent('reset');
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not complete this request. Try again.'); }
    finally { setBusy(false); }
  }
  if (sent) return <><span className="auth-state-icon"><EnvelopeSimple size={25} /></span><h1>Check your email</h1><p className="auth-intro">{sent === 'confirmation' ? 'Confirm your email address to finish creating your account.' : 'Follow the password reset link to choose a new password.'}</p><p className="auth-email" role="status">{email.trim()}</p><button className="button primary auth-submit" onClick={() => changeMode('signin')}>Back to sign in</button></>;
  return <><h1>{mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create an account' : 'Reset your password'}</h1><p className="auth-intro">{mode === 'reset' ? 'We’ll send a reset link to your email address.' : 'Keep your applications, documents and updates in your account.'}</p><form className="auth-form" onSubmit={submit}>
    <label className="field"><span>Email</span><input type="email" name="email" autoComplete="email" autoFocus value={email} onChange={event => setEmail(event.target.value)} required disabled={busy} /></label>
    {mode !== 'reset' && <div className="field"><label htmlFor="auth-password">Password</label><input id="auth-password" type="password" name="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} minLength={mode === 'signup' ? 8 : undefined} required disabled={busy} aria-describedby={mode === 'signup' ? 'auth-password-help' : undefined} />{mode === 'signup' && <span className="auth-field-help" id="auth-password-help">At least 8 characters.</span>}</div>}
    {mode === 'signin' && <button type="button" className="text-button auth-forgot" onClick={() => changeMode('reset')} disabled={busy}>Forgot password?</button>}
    {error && <p className="auth-error" role="alert"><WarningCircle size={17} />{error}</p>}
    <button className="button primary auth-submit" disabled={busy}>{busy ? 'Working…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}</button>
  </form><div className="auth-alternative">{mode === 'signin' ? <><span>New to Apply?</span><button className="text-button" onClick={() => changeMode('signup')} disabled={busy}>Create an account</button></> : <button className="text-button" onClick={() => changeMode('signin')} disabled={busy}><ArrowLeft size={14} />Back to sign in</button>}</div></>;
}

function RecoveryForm({ client, onComplete }: { client: SupabaseClient; onComplete: () => void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (password !== confirmation) { setError('The passwords do not match.'); return; }
    setBusy(true);
    try { const { error } = await client.auth.updateUser({ password }); if (error) throw error; onComplete(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not update your password.'); }
    finally { setBusy(false); }
  }
  return <><h1>Choose a new password</h1><p className="auth-intro">Use at least 8 characters.</p><form className="auth-form" onSubmit={submit}><label className="field"><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={password} onChange={event => setPassword(event.target.value)} required autoFocus disabled={busy} /></label><label className="field"><span>Confirm new password</span><input type="password" autoComplete="new-password" minLength={8} value={confirmation} onChange={event => setConfirmation(event.target.value)} required disabled={busy} /></label>{error && <p className="auth-error" role="alert">{error}</p>}<button className="button primary auth-submit" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button></form></>;
}

class SessionRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function sessionRequest(method: 'POST' | 'DELETE', token: string, session?: Session) {
  const response = await fetch('/api/cloud/session', { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(session ? { body: JSON.stringify({ accessToken: token, refreshToken: session.refresh_token }) } : {}) });
  if (!response.ok) { const error = await response.json().catch(() => null); throw new SessionRequestError(error?.error || 'Could not connect your account to this device. Try again.', response.status); }
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [boundUser, setBoundUser] = useState<string | null>(null);
  const [bindingError, setBindingError] = useState('');
  const [bindAttempt, setBindAttempt] = useState(0);
  const [recovery, setRecovery] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('type') === 'recovery');
  const [authError, setAuthError] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('error_description') || '');
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const logoutRef = useRef(false);
  const logoutBusyRef = useRef(false);
  const lastSession = useRef<Session | null>(null);
  const bindingQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    setLoadError('');
    void loadCloudConfig(attempt > 0).then(async value => {
      if (!active) return;
      setConfig(value);
      if (!value.enabled || !value.configured) { setAuthReady(true); return; }
      const client = getCloudClient()!;
      const { data: listener } = client.auth.onAuthStateChange((event, nextSession) => {
        if (!active) return;
        if (event === 'PASSWORD_RECOVERY') setRecovery(true);
        setSession(nextSession);
      });
      unsubscribe = () => listener.subscription.unsubscribe();
      const { data, error } = await client.auth.getSession();
      if (!active) return;
      if (error) setAuthError(error.message);
      setSession(data.session); setAuthReady(true);
    }).catch(error => { if (active) setLoadError(error instanceof Error ? error.message : 'Could not load account settings.'); });
    return () => { active = false; unsubscribe?.(); };
  }, [attempt]);

  useEffect(() => {
    if (!config?.enabled || !authReady || logoutRef.current) return;
    let active = true;
    if (!session) {
      setBoundUser(null); setBindingError('');
      const previous = lastSession.current; lastSession.current = null;
      if (previous) {
        clearWorkspaceContext();
        bindingQueue.current = bindingQueue.current.catch(() => undefined).then(() => sessionRequest('DELETE', previous.access_token));
        void bindingQueue.current.catch(() => { if (active) setAuthError('You are signed out. The device connection could not be closed. Sign in again to stop tracking.'); });
      }
      return () => { active = false; };
    }
    lastSession.current = session;
    if (recovery) return;
    setBindingError('');
    bindingQueue.current = bindingQueue.current.catch(() => undefined).then(async () => {
      if (!active || logoutRef.current) return;
      await sessionRequest('POST', session.access_token, session);
      if (!active || logoutRef.current) return;
      prepareAccountWorkspace(session.user.id); setBoundUser(session.user.id);
    });
    void bindingQueue.current.catch(error => { if (active && !logoutRef.current) { setBoundUser(null); setBindingError(error instanceof Error ? error.message : 'Could not open your workspace.'); } });
    return () => { active = false; };
  }, [config?.enabled, authReady, session?.access_token, recovery, bindAttempt]);

  async function signOut() {
    if (logoutBusyRef.current) return;
    logoutRef.current = true; logoutBusyRef.current = true;
    setLogoutPending(true); setLogoutBusy(true); setLogoutError(''); setBoundUser(null);
    clearWorkspaceContext();
    try {
      await bindingQueue.current.catch(() => undefined);
      const client = getCloudClient()!;
      const { data } = await client.auth.getSession();
      const token = data.session?.access_token || lastSession.current?.access_token;
      let warning = '';
      if (token) {
        try { await sessionRequest('DELETE', token); }
        catch (error) {
          if (!data.session && error instanceof SessionRequestError && error.status === 401) warning = 'Signed out of this browser. The tracking connection could not be closed. Sign in again to stop tracking.';
          else throw error;
        }
      }
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
      lastSession.current = null; setSession(null); setRecovery(false); setBindingError(''); setAuthError(warning); setLogoutPending(false);
      logoutRef.current = false;
    } catch (error) { setLogoutError(error instanceof Error ? error.message : 'Could not finish signing out. Try again.'); }
    finally { logoutBusyRef.current = false; setLogoutBusy(false); }
  }

  if (loadError) return <AuthShell><h1>Account service unavailable</h1><p className="auth-intro" role="alert">{loadError}</p><button className="button primary auth-submit" onClick={() => setAttempt(value => value + 1)}>Try again</button></AuthShell>;
  if (!config || !authReady) return <AuthShell><div className="auth-loading" role="status">Loading your account…</div></AuthShell>;
  if (!config.enabled) return <AccountContext.Provider value={{ enabled: false, email: null, signOut: null }}>{children}</AccountContext.Provider>;
  if (!config.configured) return <AuthShell><span className="auth-state-icon"><WarningCircle size={26} /></span><h1>Cloud setup required</h1><p className="auth-intro">Account storage is not configured yet. Your workspace will be available when setup is complete.</p><button className="button secondary auth-submit" onClick={() => setAttempt(value => value + 1)}>Check again</button></AuthShell>;
  if (logoutPending) return <AuthShell><h1>{logoutError ? 'Sign-out needs attention' : 'Signing out'}</h1><p className="auth-intro">{logoutError ? 'Screen capture has stopped. Retry to close the device connection and finish signing out.' : 'Stopping tracking and closing your device connection.'}</p>{logoutError && <p className="auth-error" role="alert">{logoutError}</p>}{logoutError && <button className="button primary auth-submit" disabled={logoutBusy} onClick={() => void signOut()}>{logoutBusy ? 'Working…' : 'Try again'}</button>}</AuthShell>;
  if (!session) return <AuthShell><AuthForm key={authError} client={getCloudClient()!} onSession={setSession} initialError={authError} /></AuthShell>;
  if (recovery) return <AuthShell><RecoveryForm client={getCloudClient()!} onComplete={() => setRecovery(false)} /></AuthShell>;
  if (bindingError) return <AuthShell><h1>Could not open your workspace</h1><p className="auth-intro" role="alert">{bindingError}</p><button className="button primary auth-submit" onClick={() => setBindAttempt(value => value + 1)}>Try again</button><button className="text-button auth-secondary-action" onClick={() => void signOut()}>Sign out</button></AuthShell>;
  if (boundUser !== session.user.id) return <AuthShell><div className="auth-loading" role="status">Opening your workspace…</div></AuthShell>;
  return <AccountContext.Provider value={{ enabled: true, email: session.user.email || null, signOut }}><Fragment key={session.user.id}>{children}</Fragment></AccountContext.Provider>;
}
