import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, session, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startServer } from '../server/runtime.js';
import type { CloudActor } from '../server/cloud.js';
import type { DesktopCommand, DesktopState } from '../shared/desktop.js';
import { NativeReminderDelivery } from './reminder-delivery.js';
import { createNativeCredentialStorage } from './secure-storage.js';
import { externalUrl, isTrustedPage } from './security.js';

app.setName('ApplyTrack');
app.setAppUserModelId('com.applytrack.desktop');
if (process.env.APPLY_DESKTOP_DATA_DIR) app.setPath('userData', resolve(process.env.APPLY_DESKTOP_DATA_DIR));
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
const origin = 'http://localhost:5173';
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let services: Awaited<ReturnType<typeof startServer>> | null = null;
let quitting = false;
let readyForCommands = false;
let pendingCommand: DesktopCommand | null = null;
let authStorage: Awaited<ReturnType<typeof createNativeCredentialStorage>> | null = null;
let reminderDelivery: NativeReminderDelivery | null = null;
let unsubscribeBinding: (() => void) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let picker: { window: BrowserWindow; sources: Electron.DesktopCapturerSource[]; resolve: (value: Electron.DesktopCapturerSource | null) => void } | null = null;

function showWindow() { if (!window || window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
function command(value: DesktopCommand) {
  showWindow();
  if (readyForCommands && window && !window.isDestroyed()) window.webContents.send('apply:command', value);
  else pendingCommand = value;
}
function trusted(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isTrustedPage(event.senderFrame.url, origin)) throw new Error('This request is not available outside ApplyTrack.');
}
function state(): DesktopState {
  return { platform: process.platform, version: app.getVersion(), openAtLogin: app.getLoginItemSettings().openAtLogin,
    notificationsSupported: Notification.isSupported(), notificationError: reminderDelivery?.notificationError ?? null };
}
function activeUser() { return services?.store.getMeta<string>('activeCloudUser') ?? null; }
function currentSession() {
  if (!services) return null;
  const user = activeUser();
  if (services.cloud.enabled) return user ? services.cloud.runtimeFor({ id: user } as CloudActor).getSession() : null;
  return services.store.getSession();
}
function updateTray() {
  if (!tray || !services) return;
  const tracking = currentSession();
  const signedIn = !services.cloud.enabled || !!activeUser();
  const text = tracking ? tracking.screenEnabled ? tracking.browserEnabled ? 'Browser and screen tracking on' : 'Screen tracking on' : tracking.browserEnabled ? 'Browser tracking on' : 'Tracking paused' : 'Tracking paused';
  tray.setToolTip(`ApplyTrack · ${text}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: text, enabled: false },
    { label: 'Open ApplyTrack', click: showWindow },
    { type: 'separator' },
    { label: tracking ? 'Pause tracking' : 'Start tracking…', enabled: signedIn, click: () => {
      if (tracking) { services?.stopTracking(); command({ type: 'stop-tracking' }); updateTray(); }
      else command({ type: 'start-tracking' });
    } },
    { label: 'View tasks and reminders', enabled: signedIn, click: () => command({ type: 'show-tasks' }) },
    { type: 'separator' },
    { label: 'Quit ApplyTrack', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
  ]));
}
async function poll() { updateTray(); await reminderDelivery?.poll(); }
async function chooseSource(): Promise<Electron.DesktopCapturerSource | null> {
  if (!window || picker) return null;
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 420, height: 240 }, fetchWindowIcons: false });
  if (!window || window.isDestroyed()) return null;
  return new Promise(resolveChoice => {
    const selection = new BrowserWindow({ parent: window!, modal: true, width: 760, height: 620, title: 'Choose what to share', backgroundColor: '#f7f7f7', autoHideMenuBar: true,
      webPreferences: { preload: join(__dirname, 'picker-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    picker = { window: selection, sources, resolve: resolveChoice };
    selection.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    selection.webContents.on('will-navigate', event => event.preventDefault());
    selection.once('closed', () => { if (picker?.window === selection) { const current = picker; picker = null; current.resolve(null); } });
    void selection.loadFile(join(__dirname, 'source-picker.html')).catch(() => selection.close());
  });
}
function registerIpc() {
  ipcMain.handle('apply:auth:get', (event, key) => { trusted(event); if (!authStorage) throw new Error('Secure account storage is unavailable.'); return authStorage.getItem(key); });
  ipcMain.handle('apply:auth:set', (event, key, value) => { trusted(event); if (!authStorage) throw new Error('Secure account storage is unavailable.'); return authStorage.setItem(key, value); });
  ipcMain.handle('apply:auth:remove', (event, key) => { trusted(event); if (!authStorage) throw new Error('Secure account storage is unavailable.'); return authStorage.removeItem(key); });
  ipcMain.handle('apply:account-browser', async (event, mode) => { trusted(event); if (mode !== 'signup' && mode !== 'reset') throw new Error('Choose an account action.'); await shell.openExternal(`${origin}/?auth=${mode}`); });
  ipcMain.handle('apply:state', event => { trusted(event); return state(); });
  ipcMain.handle('apply:login', (event, value) => { trusted(event); if (typeof value !== 'boolean') throw new Error('Choose whether ApplyTrack opens at login.'); app.setLoginItemSettings({ openAtLogin: value }); return state(); });
  ipcMain.handle('apply:test-notification', async event => { trusted(event); return await reminderDelivery?.testNotification() ?? { shown: false, error: 'Desktop reminders are not ready.' }; });
  ipcMain.handle('apply:ready', event => { trusted(event); readyForCommands = true; if (pendingCommand) { window!.webContents.send('apply:command', pendingCommand); pendingCommand = null; } });
  ipcMain.handle('apply:capture-sources', event => {
    if (!picker || event.sender !== picker.window.webContents || event.senderFrame !== picker.window.webContents.mainFrame) throw new Error('No screen selection is active.');
    return picker.sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }));
  });
  ipcMain.handle('apply:capture-select', (event, id) => {
    if (!picker || event.sender !== picker.window.webContents || event.senderFrame !== picker.window.webContents.mainFrame) throw new Error('No screen selection is active.');
    const current = picker;
    const selected = id === null ? null : current.sources.find(source => source.id === id);
    if (selected === undefined) throw new Error('Choose an available screen or window.');
    picker = null; current.resolve(selected); current.window.close();
  });
}
async function launch() {
  const root = app.getAppPath();
  const config = JSON.parse(readFileSync(join(__dirname, 'cloud-config.json'), 'utf8')) as { url: string; publishableKey: string };
  process.env.SUPABASE_URL ??= config.url;
  process.env.SUPABASE_PUBLISHABLE_KEY ??= config.publishableKey;
  process.env.APP_ORIGIN = origin;
  authStorage = await createNativeCredentialStorage(join(app.getPath('userData'), 'runtime'), process.env.SUPABASE_URL || '');
  services = await startServer({ rootDir: root, dataDir: join(app.getPath('userData'), 'runtime'), port: 4318, uiPort: 5173, production: true, protectRuntime: true });
  if (process.platform === 'darwin') { try { Notification.removeGroup('apply-reminders'); } catch { /* History may be unavailable before OS permission is granted. */ } }
  reminderDelivery = new NativeReminderDelivery({
    reminders: services.reminders, currentOwner: () => services?.cloud.enabled ? activeUser() : 'local',
    actor: () => services!.cloud.enabled ? services!.cloud.activeActor() : Promise.resolve(null),
    supported: () => Notification.isSupported(),
    create: ({ id, title, body, reminder }) => new Notification({ id, groupId: 'apply-reminders', title, body,
      ...(reminder && process.platform === 'darwin' ? { actions: [{ type: 'button' as const, text: 'Snooze 1 hour' }] } : {}),
    }),
    open: applicationId => command(applicationId ? { type: 'open-application', applicationId } : { type: 'show-tasks' }),
  });
  unsubscribeBinding = services.cloud.onBindingChanged(() => { pendingCommand = null; picker?.window.close(); reminderDelivery?.syncOwner(); updateTray(); });
  registerIpc();
  const browserSession = session.fromPartition('persist:applytrack');
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => contents === window?.webContents && details.isMainFrame && isTrustedPage(requestingOrigin, origin) && ['display-capture', 'clipboard-sanitized-write'].includes(permission));
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && details.isMainFrame === true && isTrustedPage(details.requestingUrl, origin) && ['display-capture', 'clipboard-sanitized-write'].includes(permission)));
  browserSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!request.frame || request.frame !== window?.webContents.mainFrame || !isTrustedPage(request.securityOrigin, origin) || !request.userGesture || request.audioRequested || !request.videoRequested) { callback(null); return; }
    void chooseSource().then(source => callback(source ? { video: source } : null)).catch(() => callback(null));
  }, { useSystemPicker: true });
  window = new BrowserWindow({ title: 'ApplyTrack', width: 1440, height: 960, minWidth: 800, minHeight: 600, backgroundColor: '#f7f7f7', show: false,
    icon: join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, plugins: true, webSecurity: true, backgroundThrottling: false, session: browserSession },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { const safe = externalUrl(url); if (safe) void shell.openExternal(safe); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!isTrustedPage(url, origin)) { event.preventDefault(); const safe = externalUrl(url); if (safe) void shell.openExternal(safe); } });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) readyForCommands = false; });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  window.once('ready-to-show', showWindow);
  window.webContents.on('render-process-gone', () => { services?.stopTracking(); readyForCommands = false; updateTray(); });
  const icon = nativeImage.createFromPath(join(__dirname, 'tray.png')).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon); tray.on('double-click', showWindow); updateTray();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'ApplyTrack', submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }] : []),
    { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { label: 'Show dashboard', click: showWindow }] },
  ]));
  powerMonitor.on('suspend', () => { services?.stopTracking(); if (readyForCommands) window?.webContents.send('apply:command', { type: 'stop-tracking' }); updateTray(); });
  powerMonitor.on('resume', () => { void poll(); });
  await window.loadURL(origin);
  timer = setInterval(() => { void poll(); }, 15_000);
  void poll();
}
app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('window-all-closed', () => { /* The menu-bar app keeps reminders and active tracking available. */ });
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true; clearInterval(timer);
  picker?.window.close();
  unsubscribeBinding?.(); reminderDelivery?.dispose(); tray?.destroy();
  void (services?.stop() ?? Promise.resolve()).finally(() => app.quit());
});
if (ownsInstance) void app.whenReady().then(launch).catch(async error => {
  const message = error?.message === 'Secure system credential storage is unavailable. Unlock your keychain and reopen ApplyTrack.' ? error.message : error?.code === 'EADDRINUSE' ? 'Another copy of ApplyTrack is using the app connection. Quit it, then open ApplyTrack again.' : 'ApplyTrack could not start. Reopen the app or reinstall it.';
  await dialog.showMessageBox({ type: 'error', title: 'ApplyTrack could not start', message });
  app.quit();
});
