import { get, set, del } from "idb-keyval";

export interface OriginalData {
  parsedRows: Record<string, string>[];
  selectedColumn: string;
  columns: string[];
}

const KEY_PREFIX = "biomapper-original-";
const LAST_JOB_KEY = "biomapper-last-job-id";

export async function saveOriginalData(
  jobId: string,
  data: OriginalData,
): Promise<void> {
  // Clean up previous job's data to prevent unbounded growth.
  const prevJobId = await get<string>(LAST_JOB_KEY);
  if (prevJobId && prevJobId !== jobId) {
    await del(`${KEY_PREFIX}${prevJobId}`);
  }
  await set(`${KEY_PREFIX}${jobId}`, data);
  await set(LAST_JOB_KEY, jobId);
}

export async function loadOriginalData(
  jobId: string,
): Promise<OriginalData | undefined> {
  return get<OriginalData>(`${KEY_PREFIX}${jobId}`);
}

export async function deleteOriginalData(jobId: string): Promise<void> {
  await del(`${KEY_PREFIX}${jobId}`);
}
