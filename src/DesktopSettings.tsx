import { useEffect, useState } from 'react';
import { Bell, Desktop, WarningCircle } from '@phosphor-icons/react';
import type { DesktopState } from '../shared/desktop';

export default function DesktopSettings() {
  const [state, setState] = useState<DesktopState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  useEffect(() => { if (!window.applyDesktop) return; let active = true; const load = () => { void window.applyDesktop!.getState().then(value => { if (active) setState(value); }).catch(() => { if (active) setError('Desktop settings could not be loaded.'); }); }; load(); const timer = setInterval(load, 30_000); return () => { active = false; clearInterval(timer); }; }, []);
  if (!window.applyDesktop) return null;
  async function openAtLogin(value: boolean) {
    setBusy(true); setError('');
    try { setState(await window.applyDesktop!.setOpenAtLogin(value)); }
    catch { setError('Could not change the login setting. Try again.'); }
    finally { setBusy(false); }
  }
  async function testNotification() {
    setBusy(true); setError(''); setMessage('');
    try { const result = await window.applyDesktop!.testNotification(); if (!result.shown) throw new Error(result.error || 'Notifications could not be shown.'); setMessage('Test notification sent.'); setState(await window.applyDesktop!.getState()); }
    catch (error) { setError(error instanceof Error ? error.message : 'Notifications could not be shown.'); }
    finally { setBusy(false); }
  }
  return <section className="cn-section desktop-settings" aria-labelledby="desktop-settings-heading"><div className="cn-section-heading"><div><h2 id="desktop-settings-heading">Desktop app</h2><p>Closing the window keeps ApplyTrack in the menu bar. Quit the app to stop tracking.</p></div><Desktop size={22} /></div><div className="cn-group"><label className="desktop-login-row"><span><strong>Open at login</strong><span>Open ApplyTrack when you sign in to this computer.</span></span><input type="checkbox" role="switch" checked={state?.openAtLogin ?? false} disabled={busy || !state} onChange={event => void openAtLogin(event.target.checked)} /></label><div className="desktop-notification-row"><button className="button secondary small" onClick={() => void testNotification()} disabled={busy || !state?.notificationsSupported}><Bell size={16} />{busy ? 'Working…' : 'Test notification'}</button><span>{message || `ApplyTrack ${state?.version ?? ''}`}</span></div>{(error || state?.notificationError) && <p className="desktop-error" role="alert"><WarningCircle size={17} />{error || state?.notificationError}</p>}</div></section>;
}
