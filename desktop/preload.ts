import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAuthStorage, DesktopBridge, DesktopCommand } from '../shared/desktop.js';

const bridge: DesktopBridge = {
  authStorage: Object.freeze<DesktopAuthStorage>({
    getItem: key => ipcRenderer.invoke('apply:auth:get', key),
    setItem: (key, value) => ipcRenderer.invoke('apply:auth:set', key, value),
    removeItem: key => ipcRenderer.invoke('apply:auth:remove', key),
  }),
  getState: () => ipcRenderer.invoke('apply:state'),
  openAccountInBrowser: mode => ipcRenderer.invoke('apply:account-browser', mode),
  setOpenAtLogin: value => ipcRenderer.invoke('apply:login', value),
  testNotification: () => ipcRenderer.invoke('apply:test-notification'),
  onCommand(callback) {
    const listener = (_event: unknown, command: DesktopCommand) => callback(command);
    ipcRenderer.on('apply:command', listener);
    void ipcRenderer.invoke('apply:ready');
    return () => ipcRenderer.removeListener('apply:command', listener);
  },
};
contextBridge.exposeInMainWorld('applyDesktop', Object.freeze(bridge));
