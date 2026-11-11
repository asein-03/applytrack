import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('capturePicker', Object.freeze({
  sources: () => ipcRenderer.invoke('apply:capture-sources'),
  choose: (id: string | null) => ipcRenderer.invoke('apply:capture-select', id),
}));
