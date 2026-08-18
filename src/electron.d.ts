interface FileItem {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

interface ElectronAPI {
  openFile: () => Promise<{ filePath: string | null }>;
  saveFile: (content: string) => Promise<{ filePath: string | null }>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  getSession: () => Promise<unknown>;
  setSession: (state: unknown) => void;
  showMessageBox: (options: {
    type: string;
    title: string;
    message: string;
    buttons: string[];
    cancelId: number;
  }) => Promise<{ response: number }>;
  onFileDrop: (callback: (filePath: string) => void) => void;
  openFiles: () => Promise<{ filePaths: string[] }>;
  openDirectory: () => Promise<{ filePaths: string[] }>;
  readDirectory: (dirPath: string) => Promise<FileItem[]>;
  statBatch: (paths: string[]) => Promise<FileItem[]>;
}

interface Window {
  electronAPI?: ElectronAPI;
}