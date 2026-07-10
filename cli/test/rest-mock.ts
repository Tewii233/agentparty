// bun.serve 的 rest mock 服务器，测试 invite/webhook/channel 用
export interface RestRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface RestMock {
  url: string;
  requests: RestRequest[];
  stop(): void;
}

// handler 返回 Response 则覆盖默认行为，返回 undefined 走默认
export type RestHandler = (req: RestRequest) => Response | undefined;

export function startRestMock(handler?: RestHandler): RestMock {
  const requests: RestRequest[] = [];
  // 有状态 webhook 存储：add 后 list 能查到
  const webhooks = new Map<string, { name: string; url: string; filter: string }[]>();
  const roles = new Map<string, { name: string; role: string; responsibility: string | null; assigned_by: string; assigned_at: number }[]>();
  const perms = new Map<string, {
    charter_write: string;
    charter_write_agents: string;
    charter_write_agent_allowlist: string[];
    members_list: string;
    members_list_agents: string;
    members_list_agent_allowlist: string[];
  }>();
  const joinLinks = new Map<
    string,
    { code: string; channel_slug: string; created_by: string; created_at: number; expires_at: number | null; max_uses: number | null; uses: number; revoked_at: number | null }[]
  >();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const raw = await req.text();
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // 非 json
      }
      const r: RestRequest = {
        method: req.method,
        path: u.pathname,
        query: Object.fromEntries(u.searchParams.entries()),
        headers: Object.fromEntries(req.headers.entries()),
        body,
      };
      requests.push(r);
      const custom = handler?.(r);
      if (custom) return custom;

      if (r.method === "POST" && r.path === "/api/tokens") {
        const b = body as { name: string; role: string };
        // 确定性明文 token，方便快照
        return Response.json({ token: `ap_${b.name}_secret`, name: b.name, role: b.role });
      }
      if (r.method === "DELETE" && r.path.startsWith("/api/tokens/")) {
        return new Response(null, { status: 204 });
      }
      if (r.method === "POST" && r.path === "/api/channels") {
        return Response.json({ ok: true });
      }
      if (r.method === "GET" && r.path === "/api/channels") {
        return Response.json({ channels: [] });
      }
      if (r.method === "GET" && /^\/api\/channels\/[^/]+\/presence$/.test(r.path)) {
        return Response.json({ presence: [] });
      }
      if (r.method === "POST" && /^\/api\/channels\/[^/]+\/messages$/.test(r.path)) {
        return Response.json({ seq: 1 });
      }
      if (r.method === "GET" && r.path === "/api/me") {
        return Response.json({
          name: "agent",
          email: null,
          kind: "agent",
          role: "agent",
          owner: null,
          channel_scope: null,
          caps: { send: true, create_channel: false, mint_agents: false, scoped_to: null },
        });
      }
      if (r.method === "POST" && /^\/api\/channels\/[^/]+\/kick$/.test(r.path)) {
        return Response.json({ ok: true });
      }
      if (r.method === "POST" && /^\/api\/channels\/[^/]+\/reset-guard$/.test(r.path)) {
        return Response.json({ ok: true });
      }
      if (r.method === "PUT" && /^\/api\/channels\/[^/]+\/completion-gate$/.test(r.path)) {
        const b = body as { gate: "off" | "reviewer"; policy?: "sender" | "owner" };
        return Response.json({ gate: b.gate, policy: b.policy ?? "sender" });
      }
      if (r.method === "PUT" && /^\/api\/channels\/[^/]+\/loop-guard$/.test(r.path)) {
        const b = body as { enabled: boolean; limit?: number };
        return Response.json({ enabled: b.enabled, limit: b.enabled ? b.limit : null });
      }
      if (r.method === "PUT" && /^\/api\/channels\/[^/]+\/workflow-guard$/.test(r.path)) {
        const b = body as { enabled: boolean; limit?: number };
        return Response.json({ enabled: b.enabled, limit: b.enabled ? b.limit : null });
      }
      if (r.method === "PUT" && /^\/api\/channels\/[^/]+\/visibility$/.test(r.path)) {
        const b = body as { visibility: "public" | "private" };
        return Response.json({ visibility: b.visibility });
      }
      if (r.method === "POST" && /^\/api\/channels\/[^/]+\/messages\/[1-9]\d*\/review$/.test(r.path)) {
        const b = body as { action: "approve" | "reject"; reason?: string };
        const seq = Number(r.path.match(/\/messages\/([1-9]\d*)\/review$/)?.[1]);
        return Response.json({
          message: {
            type: "msg",
            seq,
            sender: { name: "worker", kind: "agent" },
            kind: "message",
            body: "final",
            mentions: [],
            reply_to: 1,
            state: null,
            note: null,
            status: null,
            completion_artifact: {
              kind: "final_synthesis",
              kickoff_seq: 1,
              replies_count: 0,
              timeout: false,
              related_issues: [],
              related_prs: [],
            },
            completion_review: {
              state: b.action === "approve" ? "approved" : "rejected",
              policy: "sender",
              reason: b.reason,
            },
            ts: 123,
          },
          reply: {
            type: "msg",
            seq: seq + 1,
            sender: { name: "reviewer", kind: "agent" },
            kind: "message",
            body: b.action === "approve" ? `review approved #${seq}` : `@worker review rejected #${seq}: ${b.reason}`,
            mentions: b.action === "approve" ? [] : ["worker"],
            reply_to: seq,
            state: null,
            note: null,
            status: null,
            ts: 124,
          },
        });
      }
      const roleMatch = r.path.match(/^\/api\/channels\/([^/]+)\/roles(?:\/([^/]+))?$/);
      if (roleMatch) {
        const slug = decodeURIComponent(roleMatch[1]!);
        const list = roles.get(slug) ?? [];
        if (r.method === "GET" && !roleMatch[2]) {
          return Response.json({ roles: list });
        }
        if (r.method === "PUT" && roleMatch[2]) {
          const name = decodeURIComponent(roleMatch[2]);
          const role = (body as { role: string }).role;
          const next = { name, role, responsibility: (body as { responsibility?: string }).responsibility ?? null, assigned_by: "owner", assigned_at: 123 };
          roles.set(slug, [...list.filter((r) => r.name !== name), next]);
          return Response.json(next);
        }
        if (r.method === "DELETE" && roleMatch[2]) {
          const name = decodeURIComponent(roleMatch[2]);
          roles.set(
            slug,
            list.filter((r) => r.name !== name),
          );
          return Response.json({ ok: true });
        }
      }
      const joinMatch = r.path.match(/^\/api\/channels\/([^/]+)\/join-links(?:\/([^/]+))?$/);
      if (joinMatch) {
        const slug = decodeURIComponent(joinMatch[1]!);
        const list = joinLinks.get(slug) ?? [];
        if (r.method === "POST" && !joinMatch[2]) {
          const b = body as { expires_in_sec?: number; max_uses?: number };
          const code = `jl_${list.length + 1}`;
          const link = {
            code,
            channel_slug: slug,
            created_by: "owner",
            created_at: 123,
            expires_at: b.expires_in_sec === undefined ? null : 123 + b.expires_in_sec * 1000,
            max_uses: b.max_uses ?? null,
            uses: 0,
            revoked_at: null,
          };
          joinLinks.set(slug, [...list, link]);
          return Response.json({ ...link, url: `${u.origin}/join/${code}` }, { status: 201 });
        }
        if (r.method === "GET" && !joinMatch[2]) {
          return Response.json({ links: list });
        }
        if (r.method === "DELETE" && joinMatch[2]) {
          const code = decodeURIComponent(joinMatch[2]);
          joinLinks.set(
            slug,
            list.map((link) => (link.code === code ? { ...link, revoked_at: 456 } : link)),
          );
          return Response.json({ ok: true });
        }
      }
      const memberMatch = r.path.match(/^\/api\/channels\/([^/]+)\/members(?:\/(.+))?$/);
      if (memberMatch) {
        if (r.method === "GET" && !memberMatch[2]) {
          return Response.json({ members: [] });
        }
        if (r.method === "DELETE" && memberMatch[2]) {
          return Response.json({ ok: true });
        }
      }
      const permsMatch = r.path.match(/^\/api\/channels\/([^/]+)\/perms$/);
      if (permsMatch) {
        const slug = decodeURIComponent(permsMatch[1]!);
        const current = perms.get(slug) ?? {
          charter_write: "moderators",
          charter_write_agents: "moderators",
          charter_write_agent_allowlist: [],
          members_list: "members",
          members_list_agents: "members",
          members_list_agent_allowlist: [],
        };
        if (r.method === "GET") {
          return Response.json({ permissions: current });
        }
        if (r.method === "PUT") {
          const next = { ...current, ...(body as Record<string, unknown>) };
          perms.set(slug, next as typeof current);
          return Response.json({ permissions: next });
        }
      }
      if (r.method === "GET" && /^\/api\/channels\/[^/]+\/messages$/.test(r.path)) {
        return Response.json({ messages: [] });
      }
      if (r.method === "GET" && /^\/api\/channels\/[^/]+\/search$/.test(r.path)) {
        return Response.json({ hits: [] });
      }
      if (r.method === "GET" && /^\/api\/channels\/[^/]+\/wake-deliveries$/.test(r.path)) {
        return Response.json({ deliveries: [] });
      }
      const wh = r.path.match(/^\/api\/channels\/([^/]+)\/webhooks(?:\/([^/]+))?$/);
      if (wh) {
        const slug = decodeURIComponent(wh[1]!);
        const list = webhooks.get(slug) ?? [];
        if (r.method === "POST" && !wh[2]) {
          const b = body as { name: string; url: string; filter: string };
          list.push({ name: b.name, url: b.url, filter: b.filter });
          webhooks.set(slug, list);
          return Response.json({ ok: true });
        }
        if (r.method === "GET" && !wh[2]) {
          return Response.json({ webhooks: list });
        }
        if (r.method === "DELETE" && wh[2]) {
          const name = decodeURIComponent(wh[2]);
          webhooks.set(
            slug,
            list.filter((w) => w.name !== name),
          );
          return new Response(null, { status: 204 });
        }
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop() {
      server.stop(true);
    },
  };
}

/**
 * 按服务端真实语义（worker/src/do.ts `/internal/messages`）为合成消息流分页：
 * - before > 0 → 取 seq < before 的最后 limit 条（服务端 ORDER BY seq DESC LIMIT，再按 seq 升序输出）
 * - 否则       → 取 seq > since 的前 limit 条（升序）
 * 调用方传入的 all 必须已按 seq 升序排列。
 *
 * 命令级测试用它喂一条完整的 seq 序列，让 mock 按真实分页规则回复，从而可以断言命令输出里
 * 出现的 seq 落在哪个区间（语义），而不是断言请求 query string 长什么样（形状）——后者是
 * 实现细节，换一个语义等价的哨兵实现（例如把 before=MAX_SAFE_INTEGER 换成「先探 head 再
 * before=head+1」）就会把这类断言无辜带红。
 */
export function paginateMessages<T extends { seq: number }>(all: T[], q: Record<string, string>): T[] {
  const before = Number(q.before ?? "0");
  const since = Number(q.since ?? "0");
  const rawLimit = Number(q.limit ?? "100");
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 1000);
  if (Number.isFinite(before) && before > 0) {
    return all.filter((m) => m.seq < before).slice(-limit);
  }
  const sinceValue = Number.isFinite(since) ? since : 0;
  return all.filter((m) => m.seq > sinceValue).slice(0, limit);
}

/** RestHandler 工厂：GET /api/channels/:slug/messages 按 paginateMessages 的真实分页语义回复。 */
export function messagesRoute(allMessages: { seq: number }[]): RestHandler {
  return (req: RestRequest) => {
    if (req.method === "GET" && /^\/api\/channels\/[^/]+\/messages$/.test(req.path)) {
      return Response.json({ messages: paginateMessages(allMessages, req.query) });
    }
    return undefined;
  };
}
