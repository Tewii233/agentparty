// party history / party_history（#151）：默认必须是"最近 N 条"，不是频道最开头 N 条。
// 命令级测试断言语义（读回来的 seq 落在尾部还是头部），不断言请求 query string 长什么样：
// 后者是实现细节，换一个语义等价的哨兵实现（例如把 before=MAX_SAFE_INTEGER 换成
// 「先探 head 再 before=head+1」）语义完全不变，断言 query string 就会把测试无辜带红
// （见频道公告 seq 374，契约①）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { run } from "../src/commands/history";
import { messagesQuery, TAIL_BEFORE } from "../src/rest";
import { paginateMessages } from "./rest-mock";

let home: string;
let oldHome: string | undefined;
let restServer: ReturnType<typeof Bun.serve> | null = null;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
let stdout: string[] = [];
let stderr: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-history-"));
  oldHome = process.env.AGENTPARTY_HOME;
  process.env.AGENTPARTY_HOME = home;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ server: "https://ap.test", token: "ap_tok" }));
  stdout = [];
  stderr = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
  else process.env.AGENTPARTY_HOME = oldHome;
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  restServer?.stop(true);
  restServer = null;
});

// 这个 describe 块继续断言查询串本身——这不是「断言形状」的反例：messagesQuery 本身就是
// 被测单元，它的输出（查询串）就是它的语义，直接断言输出没有钉死任何上游实现细节。
// 与下面命令级测试的区别是：命令级测试断言的是「调用方读到了什么」，不应该关心命令内部
// 拼了什么查询串——那是调用 messagesQuery/fetchRecentMessages 的实现细节。
describe("messagesQuery 纯函数（#151）", () => {
  test("默认 tail：before=TAIL_BEFORE，不发 since", () => {
    const q = messagesQuery({ limit: 100, before: TAIL_BEFORE });
    expect(q).toContain(`before=${TAIL_BEFORE}`);
    expect(q).not.toContain("since=");
  });

  test("显式 since=0：从头读，不发 before", () => {
    const q = messagesQuery({ since: 0, limit: 100 });
    expect(q).toContain("since=0");
    expect(q).not.toContain("before=");
  });

  test("since=5", () => {
    expect(messagesQuery({ since: 5, limit: 100 })).toContain("since=5");
  });

  test("before=50：不发 since", () => {
    const q = messagesQuery({ before: 50, limit: 100 });
    expect(q).toContain("before=50");
    expect(q).not.toContain("since=");
  });

  test("before 与 since 同时传：before 优先，且不发 since（防服务端歧义）", () => {
    const q = messagesQuery({ since: 5, before: 50, limit: 100 });
    expect(q).toContain("before=50");
    expect(q).not.toContain("since=");
  });

  test("completion=true → completion=1", () => {
    expect(messagesQuery({ limit: 100, completion: true })).toContain("completion=1");
  });

  test("before=0 视为未提供，走 since 语义", () => {
    const q = messagesQuery({ since: 3, before: 0, limit: 100 });
    expect(q).toContain("since=3");
    expect(q).not.toContain("before=");
  });
});

// 拦截 fetch，按 paginateMessages 的真实分页语义回复一条合成 seq 序列——这样命令级测试
// 就能断言「读回来的 seq 是哪一段」，而不必看请求 query string 长什么样。
function interceptMessages(allMessages: { seq: number }[]): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const q = Object.fromEntries(url.searchParams.entries());
    return Response.json({ messages: paginateMessages(allMessages, q) });
  }) as typeof fetch;
}

// party history 默认走 --json，逐行解析 NDJSON 拿到实际读回的 seq 列表用于语义断言。
function seqsFromStdout(): number[] {
  return stdout.map((line) => (JSON.parse(line) as { seq: number }).seq);
}

describe("party history 参数解析（#151）", () => {
  test("--since 与 --before 同时给出 → exit 1，且不发请求", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      throw new Error("history 不应在 flag 冲突时打网络请求");
    }) as typeof fetch;
    const code = await run(["dev", "--since", "5", "--before", "10"]);
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("--since and --before are mutually exclusive");
  });

  test("默认（无 since/before）→ 读回来的是最近 N 条（尾部）", async () => {
    // 合成 seq 1..12，--limit 5：读回来的必须是尾部 8..12，不含 1..7。
    const allMessages = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1 }));
    interceptMessages(allMessages);
    const code = await run(["dev", "--limit", "5", "--json"]);
    expect(code).toBe(0);
    expect(seqsFromStdout()).toEqual([8, 9, 10, 11, 12]);
  });

  test("显式 --since 0 → 读回来的是最早 N 条（头部）", async () => {
    const allMessages = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1 }));
    interceptMessages(allMessages);
    const code = await run(["dev", "--since", "0", "--limit", "5", "--json"]);
    expect(code).toBe(0);
    expect(seqsFromStdout()).toEqual([1, 2, 3, 4, 5]);
  });

  test("--before <seq> → 读回来的是 seq<before 的最后 N 条（反向分页）", async () => {
    const allMessages = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1 }));
    interceptMessages(allMessages);
    const code = await run(["dev", "--before", "6", "--limit", "3", "--json"]);
    expect(code).toBe(0);
    expect(seqsFromStdout()).toEqual([3, 4, 5]);
  });
});

describe("party_history（MCP，#151）", () => {
  test("默认（无 since/before）→ 返回的 seq 是尾部，对得上工具描述里的 recent", async () => {
    // 合成 seq 1..12，limit 5：返回的 messages 的 seq 必须是尾部 8..12。
    const allMessages = Array.from({ length: 12 }, (_, i) => ({
      type: "msg",
      seq: i + 1,
      sender: { name: "alice", kind: "agent" },
      kind: "message",
      body: `m${i + 1}`,
      mentions: [],
      reply_to: null,
      state: null,
      note: null,
      status: null,
      ts: (i + 1) * 1000,
    }));
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/messages" && req.method === "GET") {
          const q = Object.fromEntries(url.searchParams.entries());
          return Response.json({ messages: paginateMessages(allMessages, q) });
        }
        if (url.pathname === "/api/me") {
          return Response.json({ name: "me", email: null, kind: "agent", role: "member", owner: null });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }));

    const indexPath = join(import.meta.dir, "..", "src", "index.ts");
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", indexPath, "mcp", "--channel", "dev"],
      env: { ...process.env, AGENTPARTY_HOME: home },
      stderr: "pipe",
    });
    const client = new Client({ name: "agentparty-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "party_history", arguments: { limit: 5 } });
      expect(result.isError).not.toBe(true);
      const data = result.structuredContent as { messages: { seq: number }[] };
      expect(data.messages.map((m) => m.seq)).toEqual([8, 9, 10, 11, 12]);
    } finally {
      await client.close();
    }
  }, 15_000);
});
