import type { WorkspaceFile } from "@/store/workspace";

/** Download helpers shared by the Files and Deploy tabs. */

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function isImageFile(file: WorkspaceFile): boolean {
  return file.language === "image" || /^(https?:|data:image)/.test(file.content);
}

async function imageBlob(file: WorkspaceFile): Promise<Blob> {
  const res = await fetch(file.content);
  return res.blob();
}

function withImageExt(name: string, mime: string): string {
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)) return name;
  const ext = mime.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return `${name.replace(/\.[^.]*$/, "")}.${ext}`;
}

/** Download a single workspace file (image files as real bytes). */
export async function downloadFile(file: WorkspaceFile) {
  if (isImageFile(file)) {
    try {
      const blob = await imageBlob(file);
      triggerDownload(blob, withImageExt(file.name, blob.type));
      return;
    } catch {
      /* fall back to text */
    }
  }
  triggerDownload(new Blob([file.content], { type: "text/plain;charset=utf-8" }), file.name);
}

/**
 * Download the whole project as a .zip, with a generated Dockerfile + DEPLOY.md
 * added (if not already present) so it runs on any platform / language stack.
 */
export async function downloadProjectZip(files: WorkspaceFile[], name = "project") {
  if (files.length === 0) return;
  const [{ default: JSZip }, { generateDockerfile, deployReadme }] = await Promise.all([
    import("jszip"),
    import("./dockerfile"),
  ]);
  const zip = new JSZip();
  await Promise.all(
    files.map(async (f) => {
      if (isImageFile(f)) {
        try {
          zip.file(f.path, await imageBlob(f));
          return;
        } catch {
          /* store reference */
        }
      }
      zip.file(f.path, f.content);
    })
  );
  const { stack, dockerfile } = generateDockerfile(files);
  if (!files.some((f) => /(^|\/)Dockerfile$/.test(f.path))) zip.file("Dockerfile", dockerfile);
  if (!files.some((f) => /(^|\/)DEPLOY\.md$/i.test(f.path))) zip.file("DEPLOY.md", deployReadme(stack));

  const blob = await zip.generateAsync({ type: "blob" });
  triggerDownload(blob, `${name}.zip`);
}
