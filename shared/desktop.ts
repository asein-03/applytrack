export interface DesktopState {
  platform: string;
  version: string;
  openAtLogin: boolean;
  notificationsSupported: boolean;
  notificationError: string | null;
}
export type DesktopCommand = { type: 'start-tracking' | 'stop-tracking' | 'show-tasks' } | { type: 'open-application'; applicationId: string };
export interface DesktopAuthStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
export interface DesktopBridge {
  authStorage: DesktopAuthStorage;
  getState(): Promise<DesktopState>;
  openAccountInBrowser(mode: 'signup' | 'reset'): Promise<void>;
  setOpenAtLogin(value: boolean): Promise<DesktopState>;
  testNotification(): Promise<{ shown: boolean; error?: string }>;
  onCommand(callback: (command: DesktopCommand) => void): () => void;
}
declare global { interface Window { applyDesktop?: DesktopBridge; } }
