import { createConnection } from "node:net";
import WebSocket from "ws";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

type Message = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MARK = /\s*✳️\s*$/u;

/** A failure to reach the gateway or its thread, after which the caller may fall back to `codex exec`. */
export class GatewayUnavailable extends Error {}

type Gateway = { request: (method: string, params: object) => Promise<Message>; messages: Message[]; isClosed: () => boolean; close: () => void };

/** Opens CCodex's own socket as an app-like client and initializes it. */
async function connectGateway(socketPath: string): Promise<Gateway> {
  const socket = new WebSocket("ws://ccodex/rpc", { createConnection: () => createConnection(socketPath), perMessageDeflate: false });
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  } catch (error) {
    throw new GatewayUnavailable(error instanceof Error ? error.message : String(error));
  }
  const messages: Message[] = [];
  const waiting = new Map<number, { resolve: (value: Message) => void; reject: (error: Error) => void }>();
  let closed = false;
  const fail = (error: Error) => { closed = true; for (const entry of waiting.values()) entry.reject(error); waiting.clear(); };
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Message;
    if (message.method !== undefined && message.id !== undefined) {
      // The gateway asks the app's client for approvals; this client is no user, so it declines.
      socket.send(JSON.stringify({ id: message.id, result: { decision: "decline", action: "decline" } }));
      return;
    }
    if (message.method !== undefined) { messages.push(message); return; }
    const entry = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) entry?.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else entry?.resolve(message.result);
  });
  socket.once("close", () => fail(new Error("CCodex gateway closed the connection.")));
  let next = 0;
  const request = (method: string, params: object): Promise<Message> => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("CCodex gateway closed the connection."));
    const id = ++next;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const close = () => { socket.removeAllListeners(); socket.terminate(); };
  try {
    await request("initialize", { clientInfo: { name: "ccodex_mcp", title: "CCodex MCP", version: "1" }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: "initialized" }));
  } catch (error) {
    close();
    throw error;
  }
  return { request, messages, isClosed: () => closed, close };
}

/** Waiting for a reply ends before the MCP client's own limit (codex's default tool timeout is an hour). */
export const REPLY_WAIT_MS = 50 * 60_000;

const waited = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} seconds` : `${Math.round(ms / 60_000)} minutes`);

type TurnOptions = { signal?: AbortSignal; busy?: boolean; waitMs?: number };

/**
 * Starts a turn and waits for it: resolves with the turn's final agent message; a failed turn is an error, whatever it
 * said. A prompt sent to a busy chat joins the turn it is running, which may go on for hours, so it resolves with the
 * chat's first reply after the prompt; past `waitMs` it resolves with what the chat has said since, noting it is still
 * working.
 */
async function runTurn(gateway: Gateway, threadId: string, prompt: string, model: unknown, options: TurnOptions = {}): Promise<string> {
  const { request, messages, isClosed } = gateway;
  const from = messages.length;
  const turnId = (await request("turn/start", { threadId, input: [{ type: "text", text: prompt }], ...(typeof model === "string" && model ? { model } : {}) })).turn?.id;
  const deadline = Date.now() + (options.waitMs ?? REPLY_WAIT_MS);
  const ofThread = (m: Message, type: string) => m.method === "item/completed" && m.params?.threadId === threadId && m.params?.item?.type === type;
  // CCodex shows a Claude chat's MCP calls as agent messages of its own; they are not the chat's words.
  const spoken = (m: Message) => ofThread(m, "agentMessage") && !String(m.params.item.text ?? "").startsWith("◆ CCodex │");
  const asked = () => messages.slice(from).find((m) => ofThread(m, "userMessage") && JSON.stringify(m.params.item.content ?? "").includes(JSON.stringify(prompt.slice(0, 60)).slice(1, -1)));
  // The turn our prompt is in: a Claude chat also completes turns of its own (background tasks reporting back).
  const ours = () => asked()?.params?.turnId ?? turnId;
  // Replies after our prompt: in a joined turn, earlier messages answer something else.
  const replies = () => {
    const recent = messages.slice(from);
    const at = recent.indexOf(asked() as Message);
    return recent.slice(at + 1).filter(spoken).map((m) => String(m.params.item.text ?? ""));
  };
  let end: Message | undefined;
  while (!(end = messages.find((m) => m.method === "turn/completed" && m.params?.threadId === threadId && (!ours() || m.params?.turn?.id === ours())))) {
    if (options.signal?.aborted) {
      await request("turn/interrupt", { threadId, ...(turnId ? { turnId } : {}) }).catch(() => undefined);
      throw new Error("Cancelled.");
    }
    if (isClosed()) throw new Error("CCodex gateway closed the connection.");
    if (options.busy && replies().length) return `${replies()[0]}\n\n[CCodex: the chat was busy; this is its first reply after your message, and it is still working on its turn.]`;
    if (Date.now() > deadline) {
      const said = replies().join("\n\n");
      return `${said ? `${said}\n\n` : ""}[CCodex: your message was delivered; no final reply within ${waited(options.waitMs ?? REPLY_WAIT_MS)}, the chat is still working.]`;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (end.params?.turn?.status === "failed") throw new Error(String(end.params?.turn?.error?.message ?? "The turn failed."));
  const turn = end.params?.turn?.id;
  const said = messages.filter((m) => spoken(m) && (!turn || !m.params.turnId || m.params.turnId === turn));
  const final = said.filter((m) => m.params.item.phase === "final_answer").at(-1) ?? said.at(-1);
  return final?.params.item.text ?? "";
}

/** The gateway's id for a Claude model given as `claude:haiku`, `haiku` or a full id such as `claude-haiku-5-5`; undefined for anything else. */
export function claudeModelId(model: unknown): string | undefined {
  const name = typeof model === "string" ? model.trim() : "";
  if (/^claude:./u.test(name)) return name;
  if (/^claude-/u.test(name)) return `claude:${name}`;
  return /^(opus|sonnet|haiku|fable)$/iu.test(name) ? `claude:${name.toLowerCase()}` : undefined;
}

export type StartOptions = { prompt: string; model: string; cwd?: string; sandbox?: string; approvalPolicy?: string; name?: string; archive?: boolean; signal?: AbortSignal; onThread?: (threadId: string) => void };

/**
 * Runs a prompt in a new chat on a Claude model, which `codex exec` cannot do: the chat is created through the gateway
 * like one made in the app. Claude chats have no sandbox, only permission modes: `danger-full-access` runs it with all
 * tools allowed and anything else in don't-ask mode, where tools not already allowed (shell, edits) are denied. It is archived afterwards unless `archive` is false, so sub-agent runs do not pile up in
 * the sidebar; the thread id still works with `codex-reply`.
 */
export async function startViaGateway(socketPath: string, options: StartOptions): Promise<{ threadId: string; content: string }> {
  const gateway = await connectGateway(socketPath);
  try {
    const started = await gateway.request("thread/start", {
      model: options.model,
      cwd: options.cwd ?? process.cwd(),
      approvalPolicy: options.approvalPolicy ?? "never",
      sandbox: options.sandbox ?? "read-only",
      ephemeral: false,
    });
    const threadId = String(started.thread?.id ?? "");
    if (!threadId) throw new Error("CCodex gateway did not return a thread id.");
    options.onThread?.(threadId);
    if (options.name) await gateway.request("thread/name/set", { threadId, name: options.name }).catch(() => undefined);
    try {
      return { threadId, content: await runTurn(gateway, threadId, options.prompt, options.model, { signal: options.signal, waitMs: Number.POSITIVE_INFINITY }) };
    } finally {
      if (options.archive !== false) await gateway.request("thread/archive", { threadId }).catch(() => undefined);
    }
  } finally {
    gateway.close();
  }
}

/** Archives chats (best effort), for sub-agent chats left behind by a server that was killed mid-call. */
export async function archiveViaGateway(socketPath: string, threadIds: string[]): Promise<string[]> {
  const gateway = await connectGateway(socketPath);
  const archived: string[] = [];
  try {
    for (const threadId of threadIds) {
      try { await gateway.request("thread/archive", { threadId }); archived.push(threadId); } catch { /* gone or already archived */ }
    }
  } finally {
    gateway.close();
  }
  return archived;
}

const WARNING_METHODS = new Set(["warning", "configWarning", "guardianWarning"]);
const WARNING_LIMIT = 3;
const WARNING_CHARS = 160;
const HOLDERS_WAIT_MS = 5_000;

/** A bounded, single-line excerpt with the home directory shortened: diagnostics, not a transcript. */
function excerpt(text: unknown, chars = WARNING_CHARS): string {
  const flat = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " ").replaceAll(homedir(), "~").trim();
  return flat.length > chars ? `${flat.slice(0, chars)}…` : flat;
}

/** Warnings stock sent for this chat after `from` (the resume): only those naming the chat count; others are counted. */
export function resumeWarnings(messages: Message[], threadId: string, from: number): string {
  const warnings = messages.slice(from).filter((message) => WARNING_METHODS.has(String(message.method)));
  const own = warnings.filter((message) => message.params?.threadId === threadId);
  const unattributed = warnings.length - own.length;
  const shown = own.slice(0, WARNING_LIMIT)
    .map((message) => `${message.method}: ${excerpt(message.params?.message ?? message.params?.summary)}`);
  const more = own.length > WARNING_LIMIT ? ` (+${own.length - WARNING_LIMIT} more)` : "";
  const others = unattributed ? `; ${unattributed} warning(s) without this chat's id, not attributed to it` : "";
  return `warning excerpts for this chat after the resume: ${shown.length ? shown.join(" | ") : "none"}${more}${others}`;
}

export type HoldersOutcome =
  | { outcome: "ok"; connections: Array<{ clientName: string | null; openedAt: string | null }> }
  | { outcome: "unsupported" | "timeout" | "closed" | "malformed" | "error"; detail: string };

/** The gateway's connected clients holding a stock chat, read-only (no resume, turn or unsubscribe). Failures are
 *  told apart only as far as the answer shows: an explicit method-not-found, no answer in time, a closed
 *  connection, an answer of the wrong shape, or another error (its code and a bounded message, cause unknown). */
export async function queryHolders(gateway: Gateway, threadId: string, waitMs = HOLDERS_WAIT_MS): Promise<HoldersOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("no answer"), { kind: "timeout" })), waitMs);
  });
  try {
    const found: Message = await Promise.race([gateway.request("ccodex/thread/holders", { threadId }), timeout]);
    if (!found || !Array.isArray(found.connections)) return { outcome: "malformed", detail: excerpt(JSON.stringify(found ?? null)) };
    return {
      outcome: "ok",
      connections: found.connections.filter((holder: Message) => holder && !holder.self)
        .map((holder: Message) => ({ clientName: typeof holder.clientName === "string" ? holder.clientName : null, openedAt: typeof holder.openedAt === "string" ? holder.openedAt : null })),
    };
  } catch (error: any) {
    if (error?.kind === "timeout") return { outcome: "timeout", detail: `no answer within ${waitMs} ms` };
    if (gateway.isClosed()) return { outcome: "closed", detail: "the gateway closed the connection" };
    if (error?.code === -32601) return { outcome: "unsupported", detail: "method not found" };
    return { outcome: "error", detail: `code ${error?.code ?? "none"}: ${excerpt(error?.message)}` };
  } finally {
    clearTimeout(timer);
  }
}

export function describeHolders(found: HoldersOutcome): string {
  if (found.outcome === "ok") {
    const names = found.connections.map((holder) => `${holder.clientName ?? "unnamed"} (connected ${holder.openedAt ?? "unknown"})`);
    return `gateway clients holding the chat: ${names.length ? names.join(", ") : "none known to the gateway"} (subscribers outside the gateway are not visible)`;
  }
  return `gateway clients holding the chat: not known (${found.outcome}: ${found.detail})`;
}

/** A chat given as a thread id or a title (the ✳️ mark ignored; of several chats of the title, the one used last). */
async function resolveChat(request: Gateway["request"], chat: string): Promise<string> {
  let threadId = chat.trim();
  if (!UUID.test(threadId)) {
    const wanted = threadId.replace(MARK, "").toLowerCase();
    const found = ((await request("thread/list", { searchTerm: threadId.replace(MARK, ""), limit: 50 })).data ?? [])
      .filter((thread: Message) => String(thread.name ?? "").replace(MARK, "").toLowerCase() === wanted);
    if (!found.length) throw new GatewayUnavailable(`No chat is titled "${chat}".`);
    // Old copies keep a role's title (a chat from before CCodex, an earlier chat of the role): the one used last is the role's.
    threadId = found.sort((left: Message, right: Message) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))[0].id;
  }
  return threadId;
}

/**
 * Read-only diagnostics of a chat through the gateway: its stored cwd, status and model (`thread/read` without turns),
 * whether it is loaded, and the gateway's connected clients holding it. Nothing resumes, starts, steers or unsubscribes
 * the chat. Stock's own subscribers outside the gateway are not visible, and why stock keeps a directory is not known.
 */
export async function holdersViaGateway(socketPath: string, chat: string, waitMs = HOLDERS_WAIT_MS): Promise<Message> {
  const gateway = await connectGateway(socketPath);
  try {
    const threadId = await resolveChat(gateway.request, chat);
    const read: Message = await gateway.request("thread/read", { threadId, includeTurns: false });
    const loaded: Message = await gateway.request("thread/loaded/list", {});
    const holders = await queryHolders(gateway, threadId, waitMs);
    return {
      threadId,
      cwd: read.thread?.cwd ?? null,
      status: read.thread?.status?.type ?? null,
      model: read.thread?.model ?? null,
      loaded: Array.isArray(loaded.data) ? loaded.data.includes(threadId) : null,
      holders,
      scope: "Only the gateway's own connected clients are visible; stock's other subscribers and its reasons for keeping a directory are not.",
    };
  } finally {
    gateway.close();
  }
}

/** What can be told about a kept cwd without changing anything: neither part is exhaustive, and stock does not say why. */
async function cwdDiagnostics(gateway: Gateway, threadId: string, from: number): Promise<string> {
  return `${resumeWarnings(gateway.messages, threadId, from)}. ${describeHolders(await queryHolders(gateway, threadId))}.`;
}

function sameDir(actual: unknown, wanted: string): boolean {
  if (typeof actual !== "string") return false;
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolvePath(path); } };
  return real(actual) === real(wanted);
}

/**
 * Sends a prompt to a chat through CCodex's own socket, as the Codex app does: a chat the app has open (it has an
 * active writer, which `codex exec resume` cannot take), a busy chat (the prompt joins its running turn) and a chat
 * now on a Claude model (the gateway routes it to the Claude session) all get it. `chat` is a thread id or a title.
 */
export async function replyViaGateway(socketPath: string, chat: string, prompt: string, waitMs = REPLY_WAIT_MS,
  options: { cwd?: string } = {}): Promise<{ threadId: string; content: string }> {
  const gateway = await connectGateway(socketPath);
  const { request } = gateway;
  try {
    const threadId = await resolveChat(request, chat);
    let resumed: Message;
    let from = 0;
    try {
      from = gateway.messages.length;
      resumed = await request("thread/resume", { threadId, excludeTurns: true, ...(options.cwd ? { cwd: options.cwd } : {}) });
    } catch (error) {
      throw new GatewayUnavailable(error instanceof Error ? error.message : String(error));
    }
    // Stock applies a resume's cwd (and reloads the project config and MCP servers there) only when it loads the chat
    // again, i.e. when no other client has it open; otherwise it keeps the chat's own directory. A turn-level cwd would
    // move the turns without the MCP servers, so it is not sent: the message is held back instead.
    if (options.cwd && !sameDir(resumed.cwd ?? resumed.thread?.cwd, options.cwd)) {
      const kept = resumed.cwd ?? resumed.thread?.cwd ?? "its own directory";
      const facts = `[CCodex: requested cwd ${options.cwd}; chat reports cwd ${kept}; model ${resumed.model ?? "unknown"}; status ${resumed.thread?.status?.type ?? "unknown"}.`
        + ` ${await cwdDiagnostics(gateway, threadId, from)}]`;
      throw new Error(String(resumed.model ?? "").startsWith("claude")
        ? `Not sent: Claude chats cannot move to another directory, so the chat stays in ${kept}. ${facts}`
        // Observed, not exhaustive: a client still subscribed to the chat makes stock keep its directory; stock's reasons
        // for not applying a resume's cwd were not read from its source.
        : `Not sent: the app server kept the chat in ${kept} instead of ${options.cwd}. Why is not reported; one cause seen in tests is another client still subscribed to the chat (one that opened or resumed it and is connected), other causes are not ruled out. ${facts}`);
    }
    // A `turn/start` without a model would complete a model switch someone left pending on the chat (the app sends the
    // model with each turn); naming the chat's own model keeps it on the provider it is on.
    return { threadId, content: await runTurn(gateway, threadId, prompt, resumed.model, { busy: resumed.thread?.status?.type === "active", waitMs }) };
  } finally {
    gateway.close();
  }
}
