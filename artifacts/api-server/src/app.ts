import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const PYTHON_API_PORT = parseInt(process.env.PYTHON_API_PORT || "8000", 10);
const PYTHON_API_BASE = `http://localhost:${PYTHON_API_PORT}`;


// Clerk is optional — if no CLERK_SECRET_KEY is set, auth is skipped entirely
const clerkEnabled = !!process.env.CLERK_SECRET_KEY;

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

if (clerkEnabled) {
  // Clerk proxy must be before body parsers (streams raw bytes to Clerk FAPI)
  app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
}

app.use(cors({ credentials: true, origin: true }));

if (clerkEnabled) {
  // clerkMiddleware only reads headers/cookies — safe to mount before body parsers.
  // This populates auth state so getAuth() works for the map proxy auth guard below.
  app.use(clerkMiddleware());
} else {
  logger.warn("CLERK_SECRET_KEY not set — running without authentication");
}

/**
 * requireMapAuth — server-side gate for /api/map/* and /api/discovery/* routes.
 *
 * Requires the request to be from an authenticated Clerk user.
 */
const requireMapAuth = (req: Request, res: Response, next: NextFunction): void => {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ detail: "Authentication required." });
    return;
  }
  next();
};

// Mount the map proxy BEFORE body parsers so the raw body stream is still intact.
// The SSE stream endpoint (/api/map/stream/*) requires unbuffered pass-through.
app.use(
  "/api/map",
  ...(clerkEnabled ? [requireMapAuth] : []),
  createProxyMiddleware({
    target: PYTHON_API_BASE,
    changeOrigin: true,
    // Express strips "/api/map" before handing to the middleware,
    // so we restore it for the Python FastAPI routes.
    pathRewrite: (path: string) => "/map" + path,
    on: {
      error: (_err, _req, res) => {
        if (!("headersSent" in res && res.headersSent)) {
          (res as express.Response)
            .status(502)
            .json({ detail: "Entity linker service unavailable. Please try again later." });
        }
      },
    },
  }),
);

// Discovery endpoints — same auth gate as /api/map.
app.use(
  "/api/discovery",
  ...(clerkEnabled ? [requireMapAuth] : []),
  createProxyMiddleware({
    target: PYTHON_API_BASE,
    changeOrigin: true,
    pathRewrite: (path: string) => "/discovery" + path,
    on: {
      error: (_err, _req, res) => {
        if (!("headersSent" in res && res.headersSent)) {
          (res as express.Response)
            .status(502)
            .json({ detail: "Discovery service unavailable. Please try again later." });
        }
      },
    },
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
