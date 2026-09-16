import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (content: string, suggestedName?: string) => ipcRenderer.invoke('dialog:saveFile', content, suggestedName),
  readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('file:write', filePath, content),
  getSession: () => ipcRenderer.invoke('session:get'),
  setSession: (state: unknown) => ipcRenderer.send('session:set', state),
  showMessageBox: (options: { type: 'none' | 'info' | 'error' | 'question' | 'warning'; title: string; message: string; buttons: string[]; cancelId: number }) =>
    ipcRenderer.invoke('dialog:showMessageBox', options),
  onFileDrop: (callback: (filePath: string) => void) => {
    ipcRenderer.on('file:drop', (_event, filePath) => callback(filePath));
  },
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  readDirectory: (dirPath: string) => ipcRenderer.invoke('fs:readDirectory', dirPath),
  statBatch: (paths: string[]) => ipcRenderer.invoke('fs:statBatch', paths),
});