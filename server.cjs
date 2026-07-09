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

function anthropicHeaders() {
  return {
    "Content-Type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": BETA_HEADER,
  };
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
    const scoring = req.body && req.body.agent === "scoring";
    const r = await fetch(`${API_BASE}/sessions`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        agent: scoring ? process.env.SCORING_AGENT_ID : process.env.AGENT_ID,
        environment_id: process.env.ENVIRONMENT_ID,
        title: scoring ? "ICP Scoring session" : "ICP Discovery session",
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);

    sessionStreams.set(data.id, new Set());
    openUpstreamStream(data.id);
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
async function openUpstreamStream(sessionId) {
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
      } catch {
        // ignore malformed / keep-alive lines
      }
    }
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend proxy running on :${PORT}`));
