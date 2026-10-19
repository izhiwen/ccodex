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
  it("counts warnings naming the chat after the resume by method, shows no text, and counts the rest apart", async () => {
    const { resumeWarnings } = await import("../../src/mcp/gatewayReply.js");
    const messages = [
      { method: "warning", params: { threadId: "T", message: "before" } },
      { method: "warning", params: { message: "no id" } },
      { method: "warning", params: { threadId: "U", message: "other chat" } },
      { method: "warning", params: { threadId: "T", message: "token=SENTINEL-SECRET https://x.test/?key=SENTINEL-KEY" } },
      { method: "configWarning", params: { threadId: "T", summary: "SENTINEL-SUMMARY" } },
    ];
    const text = resumeWarnings(messages, "T", 1);
    expect(text).toBe("warnings naming this chat after the resume: warning×1, configWarning×1 (text not shown); 2 other warning(s) not naming this chat");
    expect(text).not.toMatch(/SENTINEL|before|no id|other chat/);
  });
});

describe("checkHoldersAnswer", () => {
  it("accepts only an answer for the asked chat, in the gateway scope, with well-formed items", async () => {
    const { checkHoldersAnswer } = await import("../../src/mcp/gatewayReply.js");
    const item = { connectionId: "c", clientName: "codex_desktop", openedAt: "2026-10-19T00:00:00.000Z", self: false };
    expect(checkHoldersAnswer({ threadId: "T", scope: "gateway", connections: [item] }, "T")).toEqual({ holders: [{ clientName: "codex_desktop", openedAt: item.openedAt }] });
    for (const [answer, reason] of [
      [{ threadId: "U", scope: "gateway", connections: [] }, "threadId differs"],
      [{ threadId: "T", connections: [] }, "scope"],
      [{ threadId: "T", scope: "gateway", connections: [123] }, "connections[0] is not an object"],
      [{ threadId: "T", scope: "gateway", connections: [{ ...item, self: "no" }] }, "self"],
      [{ threadId: "T", scope: "gateway", connections: [{ ...item, openedAt: "SENTINEL" }] }, "openedAt"],
    ] as const) {
      const checked = checkHoldersAnswer(answer, "T") as { malformed?: string };
      expect(checked.malformed).toContain(reason);
      expect(checked.malformed).not.toContain("SENTINEL");
    }
    const odd = checkHoldersAnswer({ threadId: "T", scope: "gateway", connections: [{ ...item, clientName: "x SENTINEL token=1" }] }, "T") as any;
    expect(odd.holders[0].clientName).toBeNull();
  });
});
