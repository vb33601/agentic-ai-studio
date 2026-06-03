import { create } from "zustand";

export interface WorkspaceFile {
  id: string;
  name: string;
  path: string;
  content: string;
  language: string;
  isDirty: boolean;
}

export type WorkspaceTab = "chat" | "code" | "preview" | "terminal" | "files" | "deploy";

interface WorkspaceStore {
  activeTab: WorkspaceTab;
  files: WorkspaceFile[];
  activeFileId: string | null;
  previewUrl: string | null;
  projectId: string | null;
  isBuilding: boolean;
  buildLog: string[];

  setActiveTab: (tab: WorkspaceTab) => void;
  setActiveFileId: (id: string | null) => void;
  setPreviewUrl: (url: string | null) => void;
  setProjectId: (id: string | null) => void;
  setIsBuilding: (building: boolean) => void;
  addBuildLog: (line: string) => void;
  clearBuildLog: () => void;
  addFile: (file: WorkspaceFile) => void;
  updateFile: (id: string, updates: Partial<WorkspaceFile>) => void;
  removeFile: (id: string) => void;
  setFiles: (files: WorkspaceFile[]) => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  activeTab: "chat",
  files: [],
  activeFileId: null,
  previewUrl: null,
  projectId: null,
  isBuilding: false,
  buildLog: [],

  setActiveTab: (tab) => set({ activeTab: tab }),
  setActiveFileId: (id) => set({ activeFileId: id }),
  setPreviewUrl: (url) => set({ previewUrl: url }),
  setProjectId: (id) => set({ projectId: id }),
  setIsBuilding: (building) => set({ isBuilding: building }),
  addBuildLog: (line) => set((s) => ({ buildLog: [...s.buildLog, line] })),
  clearBuildLog: () => set({ buildLog: [] }),
  addFile: (file) => set((s) => ({ files: [...s.files.filter((f) => f.path !== file.path), file] })),
  updateFile: (id, updates) =>
    set((s) => ({ files: s.files.map((f) => (f.id === id ? { ...f, ...updates } : f)) })),
  removeFile: (id) => set((s) => ({ files: s.files.filter((f) => f.id !== id) })),
  setFiles: (files) => set({ files }),
}));
