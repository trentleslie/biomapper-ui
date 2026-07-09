import { useEffect, useRef, useState } from "react";

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 1500;

export interface BenchmarkProgress {
  status: "pending" | "processing" | "complete" | "error";
  completed?: number;
  total?: number;
  errorMessage?: string | null;
  runId?: string;
}

/** Streams benchmark run progress (mapping -> scoring -> complete) via SSE. */
export function useBenchmarkStream(runId: string, enabled: boolean = true) {
  const [progress, setProgress] = useState<BenchmarkProgress | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !runId) return;

    function connect(retryCount: number) {
      if (!mountedRef.current) return;
      const es = new EventSource(`/api/benchmark/stream/${runId}`);
      esRef.current = es;

      es.addEventListener("progress", (e) => {
        if (!mountedRef.current) return;
        try {
          const data: BenchmarkProgress = JSON.parse((e as MessageEvent).data);
          setProgress(data);
          if (data.status === "complete") {
            setDone(true);
            es.close();
          } else if (data.status === "error") {
            setError(data.errorMessage ?? "Benchmark run failed");
            setDone(true);
            es.close();
          }
        } catch (err) {
          console.error("[benchmark SSE] parse error", err);
        }
      });

      es.onerror = () => {
        es.close();
        if (!mountedRef.current) return;
        if (retryCount < MAX_RETRIES) {
          const delay = BASE_RETRY_MS * Math.pow(2, retryCount);
          retryTimerRef.current = setTimeout(() => connect(retryCount + 1), delay);
        } else {
          setError("Connection to benchmark service lost after multiple retries");
          setDone(true);
        }
      };
    }

    connect(0);
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      esRef.current?.close();
    };
  }, [runId, enabled]);

  return { progress, done, error };
}
