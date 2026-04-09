import { useEffect, useState } from "react";
import type { JobResult } from "@workspace/api-client-react";

export function useMappingStream(jobId: string) {
  const [jobState, setJobState] = useState<JobResult | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!jobId) return;

    const es = new EventSource(`/api/map/stream/${jobId}`);
    
    es.addEventListener("progress", (e) => {
      try {
        const data: JobResult = JSON.parse(e.data);
        setJobState(data);
        if (data.status === "complete" || data.status === "error") {
          setDone(true);
          es.close();
        }
      } catch (err) {
        console.error("Error parsing SSE data", err);
      }
    });

    es.addEventListener("error", (e) => {
      // In a real app we might differentiate between connection errors and stream errors
      // but for the spec we just close it.
      setDone(true);
      es.close();
    });

    es.onerror = () => { 
      setDone(true); 
      es.close(); 
    };

    return () => es.close();
  }, [jobId]);

  return { jobState, done };
}
