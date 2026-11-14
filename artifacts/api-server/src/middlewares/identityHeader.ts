import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getAuth } from "@clerk/express";

/** The trusted identity header the Python API reads to scope data per user. */
export const IDENTITY_HEADER = "x-clerk-user-id";

/**
 * identityHeaderMiddleware: makes `x-clerk-user-id` server-authoritative for everything
 * mounted after it.
 *
 * It rewrites `req.headers` before any proxy runs. http-proxy copies `req.headers` when it
 * builds the outgoing request, so the rewrite reaches the upstream on every request. A
 * `proxyReq` hook is not safe for this: http-proxy 1.18.1 skips the `proxyReq` event when the
 * outgoing request carries an `Expect` header, which would let a client-supplied value through.
 *
 * The client's value is always dropped. When Clerk is enabled and the request is signed in,
 * the header is set to the Clerk user id. When Clerk is disabled, `getAuth` is never called
 * (it throws without `clerkMiddleware`), so the upstream sees no identity header at all.
 */
export function identityHeaderMiddleware(clerkEnabled: boolean): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    delete req.headers[IDENTITY_HEADER];
    if (clerkEnabled) {
      const userId = getAuth(req)?.userId;
      if (userId) {
        req.headers[IDENTITY_HEADER] = userId;
      }
    }
    next();
  };
}
