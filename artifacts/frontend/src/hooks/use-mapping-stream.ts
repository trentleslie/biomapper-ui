import { useEffect, useRef, useState } from "react";
import type { JobResult } from "@workspace/api-client-react";

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 1500;

export interface StreamError {
  message: string;
  isDevEnvError: boolean;
}

type JobResultWithEnv = JobResult & { env?: string };

export function useMappingStream(jobId: string, enabled: boolean = true) {
  const [jobState, setJobState] = useState<JobResult | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<StreamError | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) return;
    if (!jobId) return;

    function connect(retryCount: number) {
      if (!mountedRef.current) return;

      const es = new EventSource(`/api/map/stream/${jobId}`);
      esRef.current = es;

      es.addEventListener("progress", (e) => {
        if (!mountedRef.current) return;
        try {
          const data: JobResultWithEnv = JSON.parse((e as MessageEvent).data);
          setJobState(data);
          if (data.status === "complete") {
            setDone(true);
            es.close();
          } else if (data.status === "error") {
            const isDevEnv = data.env === "dev";
            setError({
              message: (data as any).errorMessage ?? data.error_message ?? "Mapping failed",
              isDevEnvError: isDevEnv,
            });
            setDone(true);
            es.close();
          }
        } catch (err) {
          console.error("[SSE] Error parsing progress payload", err);
        }
      });

      es.onerror = () => {
        es.close();
        if (!mountedRef.current) return;

        if (retryCount < MAX_RETRIES) {
          const delay = BASE_RETRY_MS * Math.pow(2, retryCount);
          console.warn(`[SSE] Connection error — reconnecting in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
          retryTimerRef.current = setTimeout(() => connect(retryCount + 1), delay);
        } else {
          console.error("[SSE] Max retries exceeded, giving up on live stream");
          setError({
            message: "Connection to mapping service lost after multiple retries",
            isDevEnvError: false,
          });
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
  }, [jobId, enabled]);

  return { jobState, done, error };
}
