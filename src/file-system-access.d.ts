interface FileSystemFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface FileSystemDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
  resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: FileSystemHandle;
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: string | ArrayBuffer | Blob): Promise<void>;
  close(): Promise<void>;
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  startIn?: FileSystemHandle;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  startIn?: FileSystemHandle;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

interface FileSystemHandle {
  readonly kind: "file" | "directory";
  readonly name: string;
}

interface DataTransferItem {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
}

interface Window {
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
}
