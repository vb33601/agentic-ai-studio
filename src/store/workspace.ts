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
  /** Selected app folder for preview/deploy when a chat has multiple apps. */
  selectedAppDir: string | null;
  /** The end-to-end implementation plan for the current build (from the prompt
   *  engine), kept so the deploy flow can verify the app against it. */
  implementationPlan: string | null;
  isBuilding: boolean;
  buildLog: string[];

  setActiveTab: (tab: WorkspaceTab) => void;
  setActiveFileId: (id: string | null) => void;
  setPreviewUrl: (url: string | null) => void;
  setSelectedAppDir: (dir: string | null) => void;
  setImplementationPlan: (plan: string | null) => void;
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
  selectedAppDir: null,
  implementationPlan: null,
  isBuilding: false,
  buildLog: [],

  setActiveTab: (tab) => set({ activeTab: tab }),
  setActiveFileId: (id) => set({ activeFileId: id }),
  setPreviewUrl: (url) => set({ previewUrl: url }),
  setSelectedAppDir: (dir) => set({ selectedAppDir: dir }),
  setImplementationPlan: (plan) => set({ implementationPlan: plan }),
  setProjectId: (id) => set({ projectId: id }),
  setIsBuilding: (building) => set({ isBuilding: building }),
  addBuildLog: (line) => set((s) => ({ buildLog: [...s.buildLog, line] })),
  clearBuildLog: () => set({ buildLog: [] }),
  addFile: (file) =>
    set((s) => {
      const idx = s.files.findIndex((f) => f.path === file.path);
      if (idx === -1) return { files: [...s.files, file] };
      // Don't clobber a file the user is actively editing.
      if (s.files[idx].isDirty) return { files: s.files };
      // Replace in place, keeping the existing id so editor tabs/selection hold.
      const next = s.files.slice();
      next[idx] = { ...file, id: s.files[idx].id };
      return { files: next };
    }),
  updateFile: (id, updates) =>
    set((s) => ({ files: s.files.map((f) => (f.id === id ? { ...f, ...updates } : f)) })),
  removeFile: (id) => set((s) => ({ files: s.files.filter((f) => f.id !== id) })),
  setFiles: (files) => set({ files }),
}));
