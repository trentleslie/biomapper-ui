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

/**
 * Shared onProxyReq handler — injects the authenticated Clerk user ID as a
 * trusted header for downstream Python services.  Any client-supplied value
 * is stripped first so the header is always server-authoritative.
 */
function onProxyReqInjectUser(
  proxyReq: import("http").ClientRequest,
  req: import("http").IncomingMessage,
  _res: import("http").ServerResponse,
) {
  proxyReq.removeHeader("X-Clerk-User-Id");
  const auth = getAuth(req as any);
  if (auth?.userId) {
    proxyReq.setHeader("X-Clerk-User-Id", auth.userId);
  }
}

// Mount the map proxy BEFORE body parsers so the raw body stream is still intact.
// The SSE stream endpoint (/api/map/stream/*) requires unbuffered pass-through.

// Auth gate that exempts demo-related paths:
// - POST /api/map/demo (start demo job, unauthenticated)
// - GET /api/map/stream/* (SSE streaming, needed for demo job progress)
// - GET /api/map/result/* (fetch completed results, needed for demo fallback)
const requireMapAuthUnlessDemoPath = (req: Request, res: Response, next: NextFunction): void => {
  // Skip auth for demo endpoint and stream/result endpoints
  // (stream/result are safe because job IDs are UUIDv4 and results are non-sensitive)
  const path = req.path; // path relative to mount point "/api/map"
  if (path === "/demo" || path.startsWith("/stream/") || path.startsWith("/result/")) {
    next();
    return;
  }
  if (!clerkEnabled) {
    next();
    return;
  }
  requireMapAuth(req, res, next);
};

app.use(
  "/api/map",
  requireMapAuthUnlessDemoPath,
  createProxyMiddleware({
    target: PYTHON_API_BASE,
    changeOrigin: true,
    // Express strips "/api/map" before handing to the middleware,
    // so we restore it for the Python FastAPI routes.
    pathRewrite: (path: string) => "/map" + path,
    on: {
      proxyReq: onProxyReqInjectUser,
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

// Flags endpoints — user-scoped, same auth gate as /api/map.
app.use(
  "/api/flags",
  ...(clerkEnabled ? [requireMapAuth] : []),
  createProxyMiddleware({
    target: PYTHON_API_BASE,
    changeOrigin: true,
    pathRewrite: (path: string) => "/flags" + path.replace(/^\/(?=\?|$)/, ""),
    on: {
      proxyReq: onProxyReqInjectUser,
      error: (_err, _req, res) => {
        if (!("headersSent" in res && res.headersSent)) {
          (res as express.Response)
            .status(502)
            .json({ detail: "Flags service unavailable. Please try again later." });
        }
      },
    },
  }),
);

// Jobs endpoints — user-scoped, same auth gate as /api/map.
app.use(
  "/api/jobs",
  ...(clerkEnabled ? [requireMapAuth] : []),
  createProxyMiddleware({
    target: PYTHON_API_BASE,
    changeOrigin: true,
    pathRewrite: (path: string) => "/jobs" + (path === "/" ? "" : path),
    on: {
      proxyReq: onProxyReqInjectUser,
      error: (_err, _req, res) => {
        if (!("headersSent" in res && res.headersSent)) {
          (res as express.Response)
            .status(502)
            .json({ detail: "Jobs service unavailable. Please try again later." });
        }
      },
    },
  }),
);

// Benchmark endpoints — user-scoped. STRICT auth on every path (incl. /stream and
// /result): benchmark runs store the curator's ground-truth dataset (sensitive), so
// unlike /api/map there is NO demo/stream/result exemption.
app.use(
  "/api/benchmark",
  ...(clerkEnabled ? [requireMapAuth] : []),
  createProxyMiddleware({
    target: PYTHON_API_BASE,
    changeOrigin: true,
    pathRewrite: (path: string) => "/benchmark" + (path === "/" ? "" : path),
    on: {
      proxyReq: onProxyReqInjectUser,
      error: (_err, _req, res) => {
        if (!("headersSent" in res && res.headersSent)) {
          (res as express.Response)
            .status(502)
            .json({ detail: "Benchmark service unavailable. Please try again later." });
        }
      },
    },
  }),
);

// Feedback endpoints — same auth gate as /api/map.
app.use(
  "/api/feedback",
  ...(clerkEnabled ? [requireMapAuth] : []),
  createProxyMiddleware({
    target: PYTHON_API_BASE,
    changeOrigin: true,
    pathRewrite: (path: string) => "/feedback" + path.replace(/^\/(?=\?|$)/, ""),
    on: {
      proxyReq: onProxyReqInjectUser,
      error: (_err, _req, res) => {
        if (!("headersSent" in res && res.headersSent)) {
          (res as express.Response)
            .status(502)
            .json({ detail: "Feedback service unavailable. Please try again later." });
        }
      },
    },
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
