import { afterEach, describe, expect, it, vi } from "vitest";
import { configureEmail, sendEmail, setMailTransport } from "./email";

const msg = { to: "a@example.com", subject: "s", html: "<p>x</p>", text: "x", headers: { "List-Unsubscribe": "<https://x/u>" } };

describe("sendEmail through the Cloudflare binding", () => {
  afterEach(() => { setMailTransport(undefined); vi.restoreAllMocks(); });

  it("does not log verification or reset-password bearer links when email delivery is disabled", async () => {
    setMailTransport(undefined);
    configureEmail({ WEB_ORIGIN: "http://localhost:8787" } as never);
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sensitive = { ...msg, to: "private-address@example.test",
      subject: "Verify your Montral email",
      text: "Verify email: http://localhost:8787/api/auth/verify-email?token=top-secret-only-for-the-recipient",
      html: "<a href='https://example.test/reset-password/bearer-token'>Reset password</a>" };
    // Development signup previews can remain functional without configured mail,
    // but must NEVER print tokens, addresses or message content.
    await expect(sendEmail(sensitive)).resolves.toBeUndefined();
    await expect(sendEmail(sensitive, true)).rejects.toThrow("Email provider is not configured");
    const output = [...logged.mock.calls, ...warned.mock.calls].flat().join(" ");
    expect(output).toContain("Email provider unavailable");
    for (const fragment of ["top-secret", "bearer-token", "private-address", "verify-email", "reset-password", sensitive.subject]) {
      expect(output).not.toContain(fragment);
    }
  });

  it("required delivery succeeds when the actual transport is configured", async () => {
    const transport = vi.fn(async (_message: Record<string, unknown>) => ({}));
    setMailTransport(transport);
    configureEmail({ EMAIL_FROM: "alerts@example.test", WEB_ORIGIN: "https://example.test" } as never);
    await expect(sendEmail(msg, true)).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0]).toMatchObject({ to: msg.to, subject: msg.subject });
  });

  it("passes custom headers along", async () => {
    const send = vi.fn(async (_m: Record<string, unknown>) => ({}));
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await sendEmail(msg);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ headers: msg.headers });
  });

  it("sends again without the headers when the binding refuses them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async (m: Record<string, unknown>) => { if (m.headers) throw new Error("unknown field headers"); return {}; });
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await sendEmail(msg);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).not.toHaveProperty("headers");
  });

  it.each([["E_HEADER_NOT_ALLOWED", "message"], ["invalid_headers", "rejected"]])("recognises the header error code %s", async (code, message) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async (m: Record<string, unknown>) => { if (m.headers) throw Object.assign(new Error(message === "message" ? code : message), { code }); return {}; });
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await sendEmail(msg);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).not.toHaveProperty("headers");
  });

  it("never prints a token echoed in a custom-header rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = "synthetic-unsubscribe-bearer-not-for-logs";
    const send = vi.fn(async (m: Record<string, unknown>) => {
      if (m.headers) throw new Error(`invalid headers: https://example.test/unsubscribe?token=${secret}`);
      return {};
    });
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.test", WEB_ORIGIN: "https://example.test" } as never);
    await sendEmail(msg, true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    expect(warn).toHaveBeenCalledWith("email binding refused custom headers, retrying without headers");
  });

  it("does not send a second time when the failure has nothing to do with the headers", async () => {
    const send = vi.fn(async () => { throw new Error("timeout while sending"); });
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await expect(sendEmail(msg)).rejects.toThrow("timeout");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    "timeout while waiting for header response after upstream acceptance",
    "SMTP accepted message but the proxy header exchange timed out",
    "connection reset after header write",
    "error in X-Header while streaming message content",
  ])("never retries an ambiguous provider error mentioning header: %s", async message => {
    const send = vi.fn(async () => { throw new Error(message); });
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.test", WEB_ORIGIN: "https://example.test" } as never);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(sendEmail(msg, true)).rejects.toThrow(message);
    expect(send).toHaveBeenCalledTimes(1);
    expect(warnings).not.toHaveBeenCalled();
  });

  it("never retries a generic error code that incidentally contains HEADER", async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error("upstream disconnected"), { code: "HEADER_PIPELINE_TIMEOUT" }); });
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.test", WEB_ORIGIN: "https://example.test" } as never);
    await expect(sendEmail(msg, true)).rejects.toThrow("upstream disconnected");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["Unsupported custom headers", "header not supported", "invalid headers"]) (
    "retries once on a clear header-schema rejection: %s", async message => {
      const send = vi.fn(async (m: Record<string, unknown>) => { if (m.headers) throw new Error(message); });
      configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.test", WEB_ORIGIN: "https://example.test" } as never);
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(sendEmail(msg, true)).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][0]).not.toHaveProperty("headers");
      expect(warnings).toHaveBeenCalledWith("email binding refused custom headers, retrying without headers");
    },
  );

  it("still fails when the message is refused without headers too", async () => {
    const send = vi.fn(async (m: Record<string, unknown>) => { throw new Error(m.headers ? "invalid headers" : "rejected"); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    configureEmail({ EMAIL: { send }, EMAIL_FROM: "alerts@example.com", WEB_ORIGIN: "https://x" } as never);
    await expect(sendEmail(msg)).rejects.toThrow("rejected");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
