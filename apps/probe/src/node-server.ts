import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { TLSSocket } from "node:tls";
import { handleProbe } from "./handler";
import { handleManagedProbeEnrollment, type ManagedProbeEnrollmentReceiverConfig } from "./managed-enrollment-receiver";
import { send, toRequest } from "./node-adapter";

/** Node probe server. Existing startup remains HTTP; managed enrollment requires an explicitly configured HTTPS listener. */
export function createProbeServer(o: {
  secret: string | undefined;
  previousSecret?: string;
  previousExpiresAt?: string;
  region?: string;
  /** Dormant unless explicitly injected by a caller; default application startup never supplies this option. */
  managedEnrollment?: ManagedProbeEnrollmentReceiverConfig;
  /** A managed receiver must terminate TLS in this process; forwarded-proto headers are never trusted. */
  managedEnrollmentTls?: { key: string | Buffer; cert: string | Buffer };
}): HttpServer | HttpsServer {
  if (o.managedEnrollment && !o.managedEnrollmentTls) {
    throw new Error("Managed probe enrollment requires a TLS listener");
  }
  if (o.managedEnrollment && o.managedEnrollment.credentialStore.regionId !== o.managedEnrollment.region) {
    throw new Error("Managed probe enrollment store identity does not match receiver region");
  }
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const request = await toRequest(req);
      if (request === "too-large") {
        res.statusCode = 413;
        res.end('{"error":"Request too large"}');
        return;
      }
      const pathname = new URL(request.url).pathname;
      if (/^\/api\/probe\/[^/]+\/enroll$/.test(pathname)) {
        const result = o.managedEnrollment
          ? await handleManagedProbeEnrollment(request, o.managedEnrollment, req.socket instanceof TLSSocket && req.socket.encrypted)
          : new Response('{"error":"Enrollment unavailable"}', { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
        await send(res, result);
        return;
      }
      await send(res, await handleProbe(request, o));
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.statusCode = 500;
      res.end('{"error":"Probe failed"}');
    }
  };
  const server = o.managedEnrollmentTls
    ? createHttpsServer(o.managedEnrollmentTls, handleRequest)
    : createHttpServer(handleRequest);
  // a check request is a few hundred bytes: a client that dribbles one in is not a scheduler
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}
