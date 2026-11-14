import { zValidator as nativeZValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { limitedBodyBytes } from "./json-body-budget";

/** Match the existing bulk-import ceiling; individual routes may enforce less. */
export const JSON_VALIDATION_MAX_BYTES = 4 * 1024 * 1024;
export const JSON_VALIDATION_TIMEOUT_MS = 10_000;

/** Preserve native inference, hooks, options and non-JSON validators, but bound
 * the original upload before Hono buffers/parses it. No request clone or tee.
 * Budget exceptions must occur outside native validator's malformed-JSON catch. */
export const zValidator: typeof nativeZValidator = ((...args: Parameters<typeof nativeZValidator>) => {
  const validate = nativeZValidator(...args);
  if (args[0] !== "json") return validate;
  return async (c: Parameters<typeof validate>[0], next: Parameters<typeof validate>[1]) => {
    let bytes: Uint8Array | null;
    try { bytes = await limitedBodyBytes(c.req.raw, JSON_VALIDATION_MAX_BYTES, JSON_VALIDATION_TIMEOUT_MS); }
    catch (error) {
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(400, { message: "Malformed JSON in request body" });
    }
    // Hono 4's runtime cache stores promises, although its public declaration
    // lists resolved values. Seed bounded bytes; native decoding/error behavior
    // stays authoritative. Do not trust a previous parse as proof of budgeting.
    const buffer = bytes ? bytes.buffer as ArrayBuffer : new ArrayBuffer(0);
    c.req.bodyCache = { arrayBuffer: Promise.resolve(buffer) } as unknown as typeof c.req.bodyCache;
    return validate(c, next);
  };
}) as typeof nativeZValidator;
