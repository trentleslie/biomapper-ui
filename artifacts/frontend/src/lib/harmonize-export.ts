// Exports go through a raw fetch, not the generated client: the client returns only the body, and the page
// needs two response headers (Content-Disposition for the file name, X-Harmonize-Skipped-One-Sided for the EITL
// pairs file).

import { filenameFromDisposition } from "@/lib/harmonize";

export type ExportTable = "links" | "groups" | "review" | "unresolved" | "eitl_pairs";
export type ExportFormat = "csv" | "tsv" | "json";

export interface ExportResult {
  blob: Blob;
  filename: string;
  /** eitl_pairs only: flagged items the file cannot hold. null for the other tables. */
  skipped: number | null;
}

export class ExportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ExportError";
    this.status = status;
  }
}

/** The same path the generated client would use (it calls /api/... from the page's origin). */
export function exportUrl(jobId: string, table: ExportTable, format: ExportFormat): string {
  const q = new URLSearchParams({ table, format });
  return `/api/harmonize/runs/${encodeURIComponent(jobId)}/export?${q.toString()}`;
}

export async function fetchExport(jobId: string, table: ExportTable, format: ExportFormat): Promise<ExportResult> {
  const res = await fetch(exportUrl(jobId, table, format), { credentials: "same-origin" });
  if (!res.ok) {
    let message = `The download failed (HTTP ${res.status}).`;
    try {
      const body = await res.json();
      if (body && typeof body.detail === "string" && body.detail) message = body.detail;
    } catch {
      /* keep the generic message */
    }
    throw new ExportError(res.status, message);
  }
  const blob = await res.blob();
  const filename = filenameFromDisposition(res.headers.get("Content-Disposition"), `${table}.${format}`);
  const raw = res.headers.get("X-Harmonize-Skipped-One-Sided");
  const skipped = raw != null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
  return { blob, filename, skipped };
}

/** Hand a blob to the browser as a download. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
