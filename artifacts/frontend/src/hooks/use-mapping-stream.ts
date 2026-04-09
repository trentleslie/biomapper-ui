import { useEffect, useRef, useState } from "react";
import type { JobResult } from "@workspace/api-client-react";

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 1500;

export function useMappingStream(jobId: string) {
  const [jobState, setJobState] = useState<JobResult | null>(null);
  const [done, setDone] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!jobId) return;

    function connect(retryCount: number) {
      if (!mountedRef.current) return;

      const es = new EventSource(`/api/map/stream/${jobId}`);
      esRef.current = es;

      es.addEventListener("progress", (e) => {
        if (!mountedRef.current) return;
        try {
          const data: JobResult = JSON.parse((e as MessageEvent).data);
          setJobState(data);
          if (data.status === "complete" || data.status === "error") {
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
  }, [jobId]);

  return { jobState, done };
}
