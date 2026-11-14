// Exports need response headers the generated client hides (Content-Disposition for the file name, and
// X-Harmonize-Skipped-One-Sided for the EITL pairs file), so they use a plain fetch against the same /api path.

import { getExportHarmonizeRunUrl } from "@workspace/api-client-react";
import {
  errorMessage,
  filenameFromDisposition,
  skippedFromHeader,
  type ExportFormat,
  type ExportTable,
} from "@/lib/harmonize";

export interface ExportFile {
  blob: Blob;
  filename: string;
  /** Flagged items the EITL pairs file could not hold (eitl_pairs only; null otherwise). */
  skipped: number | null;
}

export class ExportError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ExportError";
    this.status = status;
  }
}

/** The same URL the generated client calls (no base path prefix), with the job id encoded. */
export function exportUrl(jobId: string, table: ExportTable, format: ExportFormat): string {
  return getExportHarmonizeRunUrl(encodeURIComponent(jobId), { table, format });
}

/** Fetch one export. A non-2xx answer throws ExportError carrying the server's message as written. */
export async function fetchExport(
  jobId: string,
  table: ExportTable,
  format: ExportFormat,
  opts: { env?: string; fetchImpl?: typeof fetch } = {},
): Promise<ExportFile> {
  const headers: Record<string, string> = {};
  if (opts.env) headers["X-Biomapper-Env"] = opts.env;
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(exportUrl(jobId, table, format), { headers });
  } catch (err) {
    throw new ExportError(errorMessage(err), 0);
  }
  if (!res.ok) {
    let data: unknown = null;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    throw new ExportError(errorMessage({ data, status: res.status }, `The download failed (HTTP ${res.status}).`), res.status);
  }
  // Under a wrong path the site's own page answers 200 with HTML; that is never an export.
  if ((res.headers.get("Content-Type") ?? "").toLowerCase().includes("text/html")) {
    throw new ExportError("The server answered with a web page instead of the file. The download was not saved.", res.status);
  }
  const blob = await res.blob();
  const filename =
    filenameFromDisposition(res.headers.get("Content-Disposition")) ?? `harmonize_${table}.${format}`;
  const skipped = table === "eitl_pairs" ? skippedFromHeader(res.headers.get("X-Harmonize-Skipped-One-Sided")) : null;
  return { blob, filename, skipped };
}

/** Hand a fetched file to the browser as a download. */
export function saveFile(file: ExportFile): void {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
