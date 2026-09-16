import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
const rendererSessions = new Map<number, unknown>();

function createWindow() {
  const sessionId = randomUUID();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, '../webview2/logo.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const webContentsId = mainWindow.webContents.id;

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    console.error('[electron-lifecycle] render-process-gone', {
      at: new Date().toISOString(),
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  mainWindow.on('unresponsive', () => {
    console.error('[electron-lifecycle] window-unresponsive', {
      at: new Date().toISOString(),
    });
  });

  mainWindow.webContents.once('destroyed', () => {
    rendererSessions.delete(webContentsId);
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    url.searchParams.set('mdvSession', sessionId);
    mainWindow.loadURL(url.toString());
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'), {
      query: { mdvSession: sessionId },
    });
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: 打开文件对话框
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [
      { name: 'Markdown 文件', extensions: ['md', 'mdx', 'markdown', 'mdown', 'mkd', 'qmd', 'rmd', 'mdc'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { filePath: null };
  }
  return { filePath: result.filePaths[0] };
});

// IPC: 保存文件对话框 + 写入(仅在还没有文件路径时才会被调用)
ipcMain.handle('dialog:saveFile', async (_event, content: string, suggestedName?: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    filters: [
      { name: 'Markdown 文件', extensions: ['md'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    defaultPath: suggestedName || 'untitled.md',
  });
  if (result.canceled || !result.filePath) {
    return { filePath: null };
  }
  fs.writeFileSync(result.filePath, content, 'utf-8');
  return { filePath: result.filePath };
});

// IPC: 读取文件
ipcMain.handle('file:read', async (_event, filePath: string) => {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content;
});

// IPC: 写入文件
ipcMain.handle('file:write', async (_event, filePath: string, content: string) => {
  fs.writeFileSync(filePath, content, 'utf-8');
});

ipcMain.handle('session:get', event => rendererSessions.get(event.sender.id) ?? null);

ipcMain.on('session:set', (event, state: unknown) => {
  rendererSessions.set(event.sender.id, state);
});

// IPC: 消息对话框
ipcMain.handle('dialog:showMessageBox', async (_event, options: { type: 'none' | 'info' | 'error' | 'question' | 'warning'; title: string; message: string; buttons: string[]; cancelId: number }) => {
  const result = await dialog.showMessageBox(mainWindow!, options);
  return result;
});

// IPC: 打开多文件对话框
ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown 文件', extensions: ['md', 'mdx', 'markdown', 'mdown', 'mkd', 'qmd', 'rmd', 'mdc'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return { filePaths: [] };
  return { filePaths: result.filePaths };
});

// IPC: 打开目录对话框（多选）
ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'multiSelections'],
  });
  if (result.canceled || result.filePaths.length === 0) return { filePaths: [] };
  return { filePaths: result.filePaths };
});

// IPC: 读取目录内容
ipcMain.handle('fs:readDirectory', async (_event, dirPath: string) => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries.map(entry => ({
    path: path.join(dirPath, entry.name),
    name: entry.name,
    type: entry.isDirectory() ? 'directory' : 'file',
  }));
});

// IPC: 批量获取文件/目录信息
ipcMain.handle('fs:statBatch', async (_event, paths: string[]) => {
  return paths.map(p => {
    try {
      const stat = fs.statSync(p);
      return {
        path: p,
        name: path.basename(p),
        type: stat.isDirectory() ? 'directory' : 'file',
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
});