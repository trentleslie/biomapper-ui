import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { setEnvHeaderGetter } from "@workspace/api-client-react";

type Env = "production" | "dev";

interface EnvContextValue {
  env: Env;
  setEnv: (env: Env) => void;
}

const STORAGE_KEY = "biomapper_api_env";
const VALID_ENVS: Set<string> = new Set(["production", "dev"]);

function readStoredEnv(): Env {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_ENVS.has(stored)) {
      return stored as Env;
    }
  } catch {
    // localStorage unavailable
  }
  return "production";
}

const EnvContext = createContext<EnvContextValue | null>(null);

export function EnvProvider({ children }: { children: ReactNode }) {
  const [env, setEnvState] = useState<Env>(readStoredEnv);

  const setEnv = (newEnv: Env) => {
    setEnvState(newEnv);
    try {
      localStorage.setItem(STORAGE_KEY, newEnv);
    } catch {
      // localStorage unavailable
    }
  };

  useEffect(() => {
    setEnvHeaderGetter(() => env);
    return () => setEnvHeaderGetter(null);
  }, [env]);

  return (
    <EnvContext.Provider value={{ env, setEnv }}>
      {children}
    </EnvContext.Provider>
  );
}

export function useEnv(): EnvContextValue {
  const ctx = useContext(EnvContext);
  if (!ctx) {
    throw new Error("useEnv must be used within an EnvProvider");
  }
  return ctx;
}
