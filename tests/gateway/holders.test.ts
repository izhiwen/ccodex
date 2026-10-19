import { afterEach, describe, expect, it } from "vitest";
import { replyViaGateway } from "../../src/mcp/gatewayReply.js";
import { startTestGateway, type TestGateway } from "./harness.js";

let gateway: TestGateway | undefined;
afterEach(async () => { await gateway?.stop(); gateway = undefined; });

describe("ccodex/thread/holders", () => {
  it("lists the gateway's connected clients that resumed a stock thread and have not let go", async () => {
    gateway = await startTestGateway();
    const desktop = await gateway.connect("codex_desktop");
    const remote = await gateway.connect("codex-backend");
    const asker = await gateway.connect("diag");
    const id = (await desktop.request("thread/start", { cwd: "/tmp", model: "gpt-test" })).thread.id;
    const names = async () => (await asker.request("ccodex/thread/holders", { threadId: id })).connections
      .filter((holder: any) => !holder.self).map((holder: any) => holder.clientName).sort();
    await desktop.request("thread/resume", { threadId: id, excludeTurns: true });
    await remote.request("thread/resume", { threadId: id, excludeTurns: true });
    expect(await names()).toEqual(["codex-backend", "codex_desktop"]);
    const reader = await gateway.connect("reader");
    await reader.request("thread/read", { threadId: id });
    expect(await names()).toEqual(["codex-backend", "codex_desktop"]);
    await remote.request("thread/unsubscribe", { threadId: id });
    expect(await names()).toEqual(["codex_desktop"]);
    desktop.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await names()).toEqual([]);
    // Asking does not make the asker a holder.
    expect((await asker.request("ccodex/thread/holders", { threadId: id })).connections).toEqual([]);
  });

  it("names the holders when codex-reply's cwd is not applied, and sends nothing", async () => {
    gateway = await startTestGateway();
    const desktop = await gateway.connect("codex_desktop");
    const id = (await desktop.request("thread/start", { cwd: "/tmp", model: "gpt-test" })).thread.id;
    await desktop.request("thread/resume", { threadId: id, excludeTurns: true });
    await expect(replyViaGateway(gateway.config.publicSocket, id, "hi", 2000, { cwd: "/" }))
      .rejects.toThrow(/gateway clients holding the chat: codex_desktop/);
  });
});

describe("resumeWarnings", () => {
  it("attributes only warnings naming the chat after the resume, bounded, and counts the rest", async () => {
    const { resumeWarnings } = await import("../../src/mcp/gatewayReply.js");
    const messages = [
      { method: "warning", params: { threadId: "T", message: "before" } },
      { method: "warning", params: { message: "no id" } },
      { method: "warning", params: { threadId: "U", message: "other chat" } },
      ...[1, 2, 3, 4].map((n) => ({ method: "warning", params: { threadId: "T", message: `w${n} ${"x".repeat(300)}` } })),
    ];
    const text = resumeWarnings(messages, "T", 1);
    expect(text).not.toContain("before");
    expect(text).not.toContain("no id");
    expect(text).not.toContain("other chat");
    expect(text.match(/warning: w\d/g)).toHaveLength(3);
    expect(text).toContain("(+1 more)");
    expect(text).toContain("2 warning(s) without this chat's id");
    expect(text).not.toContain("x".repeat(161));
  });
});
