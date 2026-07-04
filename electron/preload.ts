import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (content: string) => ipcRenderer.invoke('dialog:saveFile', content),
  readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('file:write', filePath, content),
  showMessageBox: (options: { type: string; title: string; message: string; buttons: string[]; cancelId: number }) =>
    ipcRenderer.invoke('dialog:showMessageBox', options),
  onFileDrop: (callback: (filePath: string) => void) => {
    ipcRenderer.on('file:drop', (_event, filePath) => callback(filePath));
  },
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  readDirectory: (dirPath: string) => ipcRenderer.invoke('fs:readDirectory', dirPath),
  statBatch: (paths: string[]) => ipcRenderer.invoke('fs:statBatch', paths),
});