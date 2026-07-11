// server.js
// Backend proxy for Claude Managed Agents.
// Keeps ANTHROPIC_API_KEY server-side and exposes a small set of
// endpoints the browser can call safely.
//
// Setup:
//   npm install express cors dotenv
//   Create a .env file with:
//     ANTHROPIC_API_KEY=sk-ant-...
//     AGENT_ID=agent_...      (your ICP Discovery Agent's id, from the console)
//     ENVIRONMENT_ID=env_...  (a Managed Agents environment id)
//   node server.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const API_BASE = "https://api.anthropic.com/v1";
const BETA_HEADER = "managed-agents-2026-04-01";
const SILLAGE_API_BASE = "https://api.getsillage.com";

function anthropicHeaders() {
  return {
    "Content-Type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": BETA_HEADER,
  };
}

function sillageHeaders() {
  return {
    Authorization: `Bearer ${process.env.SILLAGE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function sillageRequest(method, path, body) {
  const r = await fetch(`${SILLAGE_API_BASE}${path}`, {
    method,
    headers: sillageHeaders(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!r.ok) throw new Error(`Sillage ${method} ${path} -> HTTP ${r.status}: ${JSON.stringify(data)}`);
  return data;
}

// Real Sillage API calls the Persona Builder agent is allowed to trigger
// automatically (no human input needed — these are not ask_choice/present_draft).
const SILLAGE_TOOLS = {
  sillage_get_persona: () => sillageRequest("GET", "/api/v2/persona"),
  sillage_upsert_persona: (input) => sillageRequest("PUT", "/api/v2/persona", input),
  sillage_read_top_accounts: () => sillageRequest("GET", "/api/v2/top-account-list/accounts"),
  sillage_add_top_accounts: (input) =>
    sillageRequest("POST", "/api/v2/top-account-list/accounts", input),
  sillage_enrich_company: (input) =>
    sillageRequest("POST", "/api/v2/enrich-company-mapping", input),
  sillage_get_mapping_stage: (input) =>
    sillageRequest("GET", `/api/v2/account-mapping/${input.mapping_id}/stage`),
  sillage_list_company_mappings: (input) => {
    const qs = new URLSearchParams();
    if (input.page) qs.set("page", input.page);
    if (input.page_size) qs.set("page_size", input.page_size);
    const q = qs.toString();
    return sillageRequest("GET", `/api/v2/company-mappings${q ? `?${q}` : ""}`);
  },
  sillage_get_company_mapping: (input) =>
    sillageRequest("GET", `/api/v2/company-mappings/${input.mapping_id}`),
  sillage_get_setup_state: () => sillageRequest("GET", "/api/v2/setup-state"),
  sillage_get_agents: (input) =>
    input.agent_id
      ? sillageRequest("GET", `/api/v2/agents/${input.agent_id}`)
      : sillageRequest("GET", "/api/v2/agents"),
  sillage_create_agent: (input) => sillageRequest("POST", "/api/v2/agents", input),
  sillage_configure_agent: (input) => {
    const { agent_id, ...body } = input;
    return sillageRequest("PUT", `/api/v2/agents/${agent_id}`, body);
  },
  sillage_get_watchlists: () => sillageRequest("GET", "/api/v2/watchlists"),
  sillage_create_watchlist: (input) => sillageRequest("POST", "/api/v2/watchlists", input),
  sillage_add_watchlist_entities: (input) => {
    const { kind, watchlist_id, entities } = input;
    return sillageRequest("POST", `/api/v2/watchlists/${kind}/${watchlist_id}/entities`, { entities });
  },
  sillage_launch_signal_run: (input) =>
    sillageRequest("POST", "/api/v2/workspace/signal-runs", input),
  sillage_get_signal_run: (input) =>
    sillageRequest("GET", `/api/v2/workspace/signal-runs/${input.signal_request_id}`),
  sillage_query_signals: (input) => sillageRequest("POST", "/api/v2/contents/query", input),
  sillage_get_content: (input) =>
    sillageRequest("GET", `/api/v2/contents/${input.content_id}`),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Executes a sillage_* custom tool call for real and posts the result back
// to the session as a user.custom_tool_result — the Persona Builder agent
// never waits on the browser for these, only for ask_choice/present_draft.
// The post-back retries a couple of times on transient network errors
// (e.g. ECONNRESET) so a single blip doesn't strand the agent waiting
// forever on a tool result it will never receive.
async function handleSillageTool(sessionId, event) {
  const handler = SILLAGE_TOOLS[event.name];
  if (!handler) return;
  let resultText;
  try {
    const data = await handler(event.input || {});
    resultText = JSON.stringify(data);
  } catch (e) {
    resultText = `Error calling Sillage (${event.name}): ${e.message}`;
  }

  const backoffs = [0, 500, 1500];
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt]) await sleep(backoffs[attempt]);
    try {
      await fetch(`${API_BASE}/sessions/${sessionId}/events`, {
        method: "POST",
        headers: anthropicHeaders(),
        body: JSON.stringify({
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: event.id,
              content: [{ type: "text", text: resultText }],
            },
          ],
        }),
      });
      return;
    } catch (e) {
      if (attempt === backoffs.length - 1) {
        console.error("Failed to post Sillage tool result after retries", e);
      }
    }
  }
}

// Keep track of upstream SSE responses per session so we can pass through
// live events to whichever browser tab is listening.
const sessionStreams = new Map(); // sessionId -> Set of Express `res` (SSE clients)

function broadcast(sessionId, event) {
  const clients = sessionStreams.get(sessionId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
}

// 1. Create a session tied to your agent + environment
app.post("/api/session", async (req, res) => {
  try {
    const which = (req.body && req.body.agent) || "discovery";
    const agentId =
      which === "scoring"
        ? process.env.SCORING_AGENT_ID
        : which === "persona"
        ? process.env.PERSONA_AGENT_ID
        : which === "stakeholder"
        ? process.env.STAKEHOLDER_AGENT_ID
        : which === "listener"
        ? process.env.CONTENT_LISTENER_AGENT_ID
        : process.env.AGENT_ID;
    const title =
      which === "scoring"
        ? "ICP Scoring session"
        : which === "persona"
        ? "Persona Builder session"
        : which === "stakeholder"
        ? "Stakeholder Mapper session"
        : which === "listener"
        ? "Content Listener session"
        : "ICP Discovery session";
    const r = await fetch(`${API_BASE}/sessions`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        agent: agentId,
        environment_id: process.env.ENVIRONMENT_ID,
        title,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);

    sessionStreams.set(data.id, new Set());
    openUpstreamStream(data.id).catch((e) =>
      console.error("openUpstreamStream rejected unexpectedly", e)
    );
    res.json({ sessionId: data.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. Front-end subscribes here (SSE) to receive live agent events
app.get("/api/session/:id/stream", (req, res) => {
  const { id } = req.params;
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  if (!sessionStreams.has(id)) sessionStreams.set(id, new Set());
  sessionStreams.get(id).add(res);

  req.on("close", () => {
    sessionStreams.get(id)?.delete(res);
  });
});

// 3. Send a plain user message (kicks off / continues the conversation)
app.post("/api/session/:id/message", async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  try {
    const r = await fetch(`${API_BASE}/sessions/${id}/events`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4. Send back the result of a custom tool (present_draft / ask_choice)
app.post("/api/session/:id/tool-result", async (req, res) => {
  const { id } = req.params;
  const { toolUseId, text } = req.body;
  try {
    const r = await fetch(`${API_BASE}/sessions/${id}/events`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: toolUseId,
            content: [{ type: "text", text }],
          },
        ],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 5. Allow / deny a built-in or MCP tool call gated by a permission policy
app.post("/api/session/:id/tool-confirmation", async (req, res) => {
  const { id } = req.params;
  const { toolUseId, allow, denyMessage } = req.body;
  try {
    const r = await fetch(`${API_BASE}/sessions/${id}/events`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        events: [
          {
            type: "user.tool_confirmation",
            tool_use_id: toolUseId,
            result: allow ? "allow" : "deny",
            ...(denyMessage ? { deny_message: denyMessage } : {}),
          },
        ],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Opens the upstream SSE connection to Anthropic once per session and
// fans events out to every connected browser client for that session.
// Called fire-and-forget (no await at the call site) — everything in here
// must be caught internally, since an uncaught rejection from a
// fire-and-forget async call crashes the whole Node process, not just this
// one session (this is what a mid-stream ECONNRESET used to do).
async function openUpstreamStream(sessionId) {
  try {
    const r = await fetch(`${API_BASE}/sessions/${sessionId}/events/stream`, {
      method: "GET",
      headers: anthropicHeaders(),
    });

    if (!r.ok || !r.body) {
      console.error("Failed to open upstream stream", r.status, await r.text());
      return;
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop(); // keep the last partial chunk

      for (const chunk of chunks) {
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const event = JSON.parse(line.slice(5).trim());
          broadcast(sessionId, event);
          if (event.type === "agent.custom_tool_use" && SILLAGE_TOOLS[event.name]) {
            handleSillageTool(sessionId, event);
          }
        } catch {
          // ignore malformed / keep-alive lines
        }
      }
    }
  } catch (e) {
    // e.g. ECONNRESET mid-stream — this session's live updates stop, but the
    // rest of the server (and every other session) keeps running.
    console.error("Upstream stream for session", sessionId, "failed:", e);
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend proxy running on :${PORT}`));
