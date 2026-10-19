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
