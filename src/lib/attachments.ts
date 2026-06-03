import type { FileUIPart } from "ai";

export function isImage(file: File): boolean {
  return file.type.startsWith("image/");
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Turn an image File into a multimodal file part for vision models. */
export async function imageToFilePart(file: File): Promise<FileUIPart> {
  return {
    type: "file",
    mediaType: file.type,
    filename: file.name,
    url: await fileToDataUrl(file),
  };
}

export interface ParsedDoc {
  name: string;
  text: string;
  truncated: boolean;
  chars: number;
}

/** Extract text from a document via the server parse route. */
export async function parseDocument(file: File): Promise<ParsedDoc> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/parse", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Failed to read ${file.name}`);
  return { name: data.name, text: data.text, truncated: data.truncated, chars: data.chars };
}

/** Compose the extracted document text into a prompt context block. */
export function buildDocContext(docs: ParsedDoc[]): string {
  if (docs.length === 0) return "";
  const blocks = docs
    .map((d) => `### ${d.name}${d.truncated ? " (truncated)" : ""}\n\`\`\`\n${d.text}\n\`\`\``)
    .join("\n\n");
  return `\n\n---\nAttached document content:\n${blocks}`;
}
