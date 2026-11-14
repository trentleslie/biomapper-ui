/**
 * Identity header tests: the real app.ts proxy wiring in front of a local stub upstream.
 *
 * Clerk is replaced by a stub so no network or real keys are involved: a request is "signed
 * in" as user U when it carries `Authorization: Bearer U`. With Clerk disabled the stub's
 * getAuth throws, exactly like the real one does without clerkMiddleware.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: (req: http.IncomingMessage) => {
    if (!process.env.CLERK_SECRET_KEY) {
      throw new Error("getAuth called without clerkMiddleware");
    }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    return { userId: m ? m[1] : null };
  },
}));

const warn = vi.fn();
vi.mock("../src/lib/logger", async () => {
  const { default: pino } = await import("pino");
  const logger = pino({ level: "silent" });
  logger.warn = warn as unknown as typeof logger.warn;
  return { logger };
});

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

let upstream: http.Server;
let seen: Seen[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  process.env.PYTHON_API_PORT = String((upstream.address() as AddressInfo).port);
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

let appServer: http.Server | undefined;

afterEach(async () => {
  seen = [];
  if (appServer) {
    appServer.closeAllConnections();
    await new Promise<void>((r) => appServer!.close(() => r()));
    appServer = undefined;
  }
});

async function startApp(clerkEnabled: boolean): Promise<number> {
  if (clerkEnabled) process.env.CLERK_SECRET_KEY = "sk_test_stub";
  else delete process.env.CLERK_SECRET_KEY;
  vi.resetModules();
  const { default: app } = await import("../src/app");
  appServer = http.createServer(app);
  await new Promise<void>((r) => appServer!.listen(0, "127.0.0.1", r));
  return (appServer.address() as AddressInfo).port;
}

type Reply = { status: number; body: string };

/** POST with a body. With `expectContinue`, the body is sent only after the 100 Continue. */
function post(
  port: number,
  path: string,
  headers: Record<string, string>,
  expectContinue: boolean,
): Promise<Reply> {
  const body = JSON.stringify({ hello: "world" });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          ...(expectContinue ? { expect: "100-continue" } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    if (expectContinue) {
      req.on("continue", () => req.end(body));
    } else {
      req.end(body);
    }
  });
}

// Every proxied route, with a path that the auth gate does not exempt.
const ROUTES = [
  ["/api/map/jobs", "/map/jobs"],
  ["/api/discovery/vocabularies", "/discovery/vocabularies"],
  ["/api/flags", "/flags"],
  ["/api/jobs", "/jobs"],
  ["/api/harmonize/runs", "/harmonize/runs"],
  ["/api/benchmark", "/benchmark"],
  ["/api/feedback", "/feedback"],
] as const;

describe("identity header, Clerk enabled", () => {
  for (const expectContinue of [false, true]) {
    const label = expectContinue ? "with Expect: 100-continue" : "without Expect";
    it.each(ROUTES)(`%s: a spoofed header is replaced by the server value (${label})`, async (route, upstreamPath) => {
      const port = await startApp(true);
      const reply = await post(
        port,
        route,
        { authorization: "Bearer user_real", "x-clerk-user-id": "user_victim" },
        expectContinue,
      );
      expect(reply.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe(upstreamPath);
      expect(seen[0].headers["x-clerk-user-id"]).toBe("user_real");
      expect(seen[0].body).toBe(JSON.stringify({ hello: "world" }));
    });
  }

  it.each(ROUTES)("%s: a spoofed header without a signed-in user still gets 401 and never reaches upstream", async (route) => {
    const port = await startApp(true);
    for (const expectContinue of [false, true]) {
      const reply = await post(port, route, { "x-clerk-user-id": "user_victim" }, expectContinue);
      expect(reply.status).toBe(401);
      expect(JSON.parse(reply.body)).toEqual({ detail: "Authentication required." });
    }
    expect(seen).toHaveLength(0);
  });

  it("an exempt demo path passes unauthenticated with the spoofed header stripped", async () => {
    const port = await startApp(true);
    for (const expectContinue of [false, true]) {
      const reply = await post(port, "/api/map/demo", { "x-clerk-user-id": "user_victim" }, expectContinue);
      expect(reply.status).toBe(200);
    }
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.url).toBe("/map/demo");
      expect(s.headers).not.toHaveProperty("x-clerk-user-id");
    }
  });
});

describe("identity header, Clerk disabled", () => {
  it.each(ROUTES)("%s: upstream sees no identity header and the process does not crash", async (route, upstreamPath) => {
    const port = await startApp(false);
    for (const expectContinue of [false, true]) {
      const reply = await post(port, route, { "x-clerk-user-id": "user_victim" }, expectContinue);
      expect(reply.status).toBe(200);
    }
    // A request with no header at all also goes through.
    const plain = await post(port, route, {}, false);
    expect(plain.status).toBe(200);
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s.url).toBe(upstreamPath);
      expect(s.headers).not.toHaveProperty("x-clerk-user-id");
    }
  });

  it("keeps the startup warning", async () => {
    warn.mockClear();
    await startApp(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CLERK_SECRET_KEY not set"));
  });
});
