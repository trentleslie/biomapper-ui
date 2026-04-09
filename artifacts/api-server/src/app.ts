import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const PYTHON_API_PORT = parseInt(process.env.PYTHON_API_PORT || "8000", 10);
const PYTHON_API_BASE = `http://localhost:${PYTHON_API_PORT}`;

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

// Clerk proxy must be before body parsers (streams raw bytes)
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: true }));

// Mount the map proxy BEFORE body parsers so the raw body stream is still intact.
// The SSE stream endpoint (/api/map/stream/*) requires unbuffered pass-through.
app.use(
  "/api/map",
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(clerkMiddleware());

app.use("/api", router);

export default app;
