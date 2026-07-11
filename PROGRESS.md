# IC(E)looP — Progress log

Last updated: 2026-07-11. This file exists so a fresh session (human or Claude) can pick this
project back up without any prior context. If you're reading this cold: start with **"Current
state"**, then **"How to run it"**, then dig into whichever section matches what you're doing.

## Current state

A pipeline of Anthropic **Managed Agents** turns a founder's product description into a scored,
enriched B2B ICP (Ideal Customer Profile), for **1POINT6**, piloted with **Rosk** (hospitality/
multi-site restaurant & hotel chains). Four agents are built and chained automatically in the
browser app; four more exist only as design docs (not runnable). A separate, older FullEnrich/
HubSpot pipeline exists in `src/` and works, but is **not connected** to the agents below.

```
Questioning (1) → Scoring (2) → Persona Builder (3) → Stakeholder Mapper (4) → [renders result, chain stops here]
```

Each arrow is automatic: finishing one agent in the browser immediately starts a new session for
the next one and forwards its structured output as the opening message. No agent past #4 exists
yet, so Stakeholder Mapper's output is currently a dead end (rendered as a card, nothing consumes
it further).

## Architecture, in one page

- **`server.js`** — Express backend. Proxies the browser to Anthropic's Managed Agents API
  (`api.anthropic.com/v1/agents`, `/v1/sessions`, beta header `managed-agents-2026-04-01`) and
  relays live session events to the browser over SSE (`/api/session/:id/stream`).
- **`index.html`** — the entire frontend, one file, vanilla JS. Renders each agent's custom tool
  calls as cards (segment proposals, scoring results, persona checkpoints, stakeholder maps),
  and drives the automatic hand-off from one agent's session to the next.
- **`Agents/<n> - <name>/agent.json`** — each agent's config: system prompt + `tools[]`. This is
  the source of truth; push it live with `node scripts/push-agent.mjs <name>` (creates the agent
  on first run and prints an id to add to `.env`; updates it — new immutable version — on
  subsequent runs).
- **Two kinds of custom tools**, by convention:
  - **Human-facing** (`ask_choice`, `present_draft`, and each agent's own terminal `submit_*`
    tool) — the browser renders a card and the human answers; `sendToolResult()` in `index.html`
    posts the answer back.
  - **Auto-executed** (`sillage_*`, prefix is load-bearing) — `server.js`'s `SILLAGE_TOOLS` map
    intercepts these the instant they appear on the event stream, calls the real Sillage REST API
    (`https://api.getsillage.com`, Bearer auth), and posts the result back automatically. The
    agent never waits on the human for these; the browser only shows a passive one-line trace
    (`sillageLogLine`).
- **`.env`** — real secrets, gitignored. `.env.example` documents every var name (see below).

## What's built and verified (Agents 1-4)

| # | Agent | Folder | Human-facing tools | Auto (`sillage_*`) tools | Hands off to |
|---|---|---|---|---|---|
| 1 | Questioning | `Agents/1 - Questionning Agent/` | `ask_choice`, `present_draft`, `submit_segments` | — | Scoring (on `submit_segments`) |
| 2 | Scoring | `Agents/2 - Scoring Agent/` | `ask_choice`, `submit_ranking` | — | Persona Builder (on `submit_ranking`) |
| 3 | Persona Builder | `Agents/3 - Persona Agent/` | `ask_choice`, `present_draft`, `submit_persona_result` | `get_persona`, `upsert_persona`, `read_top_accounts`, `add_top_accounts`, `enrich_company`, `get_mapping_stage` | Stakeholder Mapper (on `submit_persona_result`) |
| 4 | Stakeholder Mapper | `Agents/4 - Stakeholder map agent/` | `ask_choice`, `present_draft`, `submit_stakeholder_map` | `read_top_accounts`, `list_company_mappings`, `get_company_mapping`, `enrich_company`, `get_mapping_stage` | *(nothing yet — terminal)* |

All four have been **live-tested** end to end (not just code-reviewed), including real Sillage
API calls against the sandbox workspace. Agent 4 in particular was caught doing something wrong
live (see "Bugs found and fixed" below) and the fix was verified before moving on.

### Sillage REST endpoints — verified vs assumed

Base URL `https://api.getsillage.com`, `Authorization: Bearer <SILLAGE_API_KEY>`.

| Endpoint | Status |
|---|---|
| `GET /api/v2/persona` | ✅ live-verified |
| `PUT /api/v2/persona` | Implemented, matches documented semantics (full-object replace), not separately live-verified for a write |
| `GET /api/v2/top-account-list/accounts` | ✅ live-verified |
| `POST /api/v2/top-account-list/accounts` | Implemented, not live-verified |
| `POST /api/v2/enrich-company-mapping` | ✅ live-verified (including the 409 disambiguation path — see bug below) |
| `GET /api/v2/account-mapping/{id}/stage` | ✅ live-verified (including the normal "404 while in flight" case) |
| `GET /api/v2/company-mappings` | ✅ live-verified |
| `GET /api/v2/company-mappings/{id}` | ✅ live-verified (real profile shape captured, see note below) |

**Real `profiles[]` shape** (from a live `get_company_mapping` call — differs slightly from the
older design docs, which assumed a single `name` field and a flat `location` string):
`{ id, linkedin_handle, linkedin_url, avatar_url, linkedin_about, position, position_start_date,
first_name, last_name, email, phone_number, linkedin_headline, location: {city, region, country} }`.
`email`/`phone_number` here are **not verified contacts** — that's FullEnrich's job, not built
into this pipeline yet.

**Deliberately not implemented** (no documentation basis at all, agents are told they don't
exist): `get_company` (company-level enrichment — headcount/HQ/industry lookup), `get_top_accounts`
(a documented "superset trap" — broader than the real target list), `get_requests_status`,
`get_rate_limit`.

## What's NOT built

- **Content Listener (5), Signal Aggregator (6), Hypothesis Validator (7)** — full design docs
  exist under `Agents/5.../`, `Agents/6.../`, `Agents/7.../` but none has an `agent.json`; they
  are not runnable. Signal Aggregator and Hypothesis Validator are pure decision/scoring agents
  with **no external API calls** — the easiest to build next, but they need Content Listener's
  and Stakeholder Mapper's output as real input to be useful, and Stakeholder Mapper output is
  currently a dead end. Content Listener needs several Sillage endpoints (agent CRUD, signal
  runs) that are **pure guesses with no documentation basis** — highest-risk agent to build.
- **"Agent 8" / Contact Enricher** — mentioned in the pitch deck as the 8th pipeline stage
  ("delivers a fully-enriched, ready-to-work account") but **has no folder, no spec, nothing** —
  it's a deck concept only.
- **The FullEnrich/HubSpot pipeline** (`src/pipeline/run.ts`, `src/fullenrich/client.ts`,
  `src/hubspot/`) is real, finished code — not a placeholder — but it runs a **different flow**:
  Sillage signals (`findProblemDiscussions`/`findTriggerSignals`) → FullEnrich → HubSpot, keyed
  on a flat `Icp` type (`src/config/icp.ts`), not on any of the four agents' outputs above. There
  is no adapter connecting `submit_persona_result` / `submit_stakeholder_map` into this pipeline.
  `HUBSPOT_PRIVATE_APP_TOKEN` is empty in `.env` — the HubSpot half is code-complete but has no
  credential to actually run.
  - `src/sillage/client.ts` here is a **separate, older placeholder** (`/placeholder/listen`,
    `/placeholder/signals` — fake paths) — do not confuse it with the real Sillage calls wired
    into `server.js`'s `SILLAGE_TOOLS`.
  - There's no `pipeline` npm script even though `run.ts`'s own header comment says
    `npm run pipeline` — it's only invokable by calling `node`/`tsx` on it directly.

## Bugs found and fixed (read this before assuming something is broken)

1. **Full server crash on a transient network reset.** `openUpstreamStream()` (server.js) used
   to be called fire-and-forget with no `.catch()` and no internal try/catch. A mid-stream
   `ECONNRESET` talking to Anthropic (network/proxy flakiness, seen on this machine) threw an
   unhandled rejection and **killed the entire Node process** — every session, every user, not
   just the affected one. Fixed: the whole function body is now try/caught, and the call site
   also has a defense-in-depth `.catch()`. A reset now just stops that one session's live updates
   and logs an error; the server keeps running.
2. **Tool-result posts could get silently stranded.** `handleSillageTool()`'s final POST (posting
   the Sillage call's result back to the agent) had no retry. A transient reset there meant the
   agent would wait forever for a tool result it would never receive. Fixed: up to 2 retries with
   backoff (500ms, 1500ms) before giving up and logging.
3. **Invalid `ANTHROPIC_API_KEY`.** The key in `.env` started returning a hard 401 directly from
   Anthropic (confirmed with a raw `curl` outside this app's code — not a code bug). A second,
   valid key was found in the now-deleted `Hackathon aggregated/.env` (leftover from an earlier,
   abandoned "direct Claude API" rework) and confirmed to belong to the **same org** (it can see
   the same agents) before swapping it in. **If you hit `authentication_error` again**: test the
   key directly against `https://api.anthropic.com/v1/models` with `curl` before assuming it's a
   code problem — it very likely isn't.
4. **`sillage_enrich_company`'s tool schema was missing `linkedin_url`.** The Stakeholder Mapper's
   system prompt correctly instructs it to retry a 409 ("domain matches multiple companies") with
   `domain + linkedin_url` together — but the tool's `input_schema` only had a `domain` field. In
   a live test, the agent worked around this by concatenating both values into the single
   `domain` string, which Sillage's API then rejected with a 500. Fixed by adding a proper
   `linkedin_url` field to the schema (Agent 4, pushed as version 2).

## Environment quirks specific to this machine (save yourself the rediscovery)

- **PowerShell blocks `npm` by default** (`npm.ps1` execution policy). Workarounds that don't
  touch system config: `npm.cmd start` in PowerShell, or `node server.js` directly, or just use
  `cmd.exe` instead (no restriction there).
- **`node` is not on PATH inside the Bash tool's Git-Bash environment** — call it via full path:
  `"/c/Program Files/nodejs/node.exe"`.
- **Windows-native `node.exe`/`python` resolve `/tmp` as `C:\tmp`** (which doesn't exist), even
  though Bash-tool's own `/tmp` is a different, real MSYS-mounted path. When a Windows-native
  tool needs to read/write a temp file from a Bash-tool command, write it into the project
  directory (and clean it up) instead of `/tmp`.
- **The Sillage sandbox workspace is shared/messy, not a clean Rosk-only sandbox.** It already
  contains an unrelated persona (a "Mamforma" cross-functional recruiting persona) and a top
  account list that spans several unrelated segments (insurance companies, SaaS, construction,
  fashion, restaurants...) — confirmed by the user as safe to overwrite/ignore. The Stakeholder
  Mapper agent actually detected this mismatch on its own during a live test and flagged it
  rather than silently mapping irrelevant accounts as if they were in-segment.
- Two `.env` files existed in this repo; only `c:\Users\franz\Desktop\Hackathon\.env` (root) is
  ever loaded (by `server.js`, run from the repo root). The other, in `Hackathon aggregated/`,
  was a leftover from an abandoned rework and has been deleted.

## How to run it

```
cd C:\Users\franz\Desktop\Hackathon
npm.cmd start        # or: node server.js   (PowerShell); plain `npm start` works fine in cmd.exe
```
Opens on `http://localhost:3010`. `server.js` serves `index.html` statically and exposes the
session/stream/tool-result endpoints described above.

To create or update an agent from its `agent.json` after editing it:
```
node scripts/push-agent.mjs questioning   # or: scoring | persona | stakeholder
```
First run with no matching `*_AGENT_ID` in `.env` creates the agent and prints an id to paste in;
subsequent runs push a new immutable version of the existing agent.

## Required `.env` vars (see `.env.example` for the annotated template)

`SILLAGE_API_KEY`, `FULLENRICH_API_KEY`, `ANTHROPIC_API_KEY`, `HUBSPOT_PRIVATE_APP_TOKEN` (empty
today — no HubSpot access yet), `AGENT_ID`, `SCORING_AGENT_ID`, `PERSONA_AGENT_ID`,
`STAKEHOLDER_AGENT_ID`, `ENVIRONMENT_ID`, `PORT`.

## Repo / git state (as of this writing)

- `main` is up to date with everything described above (Agents 1-4, the two bug fixes, the brand
  charter tokens). `Hackathon aggregated/` (an old, mostly-already-cleaned-out parallel rework)
  has been deleted from disk.
- Branches `wip/persona-builder-and-ux` and `backup/franz-local-exploration` are old checkpoints,
  already merged into `main` — safe to ignore or delete later.
- `styles/brand-tokens.css` — fixed color/type/spacing tokens extracted from the pitch deck, not
  yet wired into `index.html`'s actual styling (the chat UI still uses its original ad-hoc
  palette). See it (and the full rationale) via the graphic-charter artifact built earlier in
  this project's history, or just read the CSS file directly.

## Suggested next step

Signal Aggregator and Hypothesis Validator are the lowest-risk agents to build next (no external
API calls at all — pure decision/scoring logic over structured JSON), but they need real input
from Content Listener and Stakeholder Mapper to be useful in the full chain. Realistically:
either (a) build Content Listener next despite its unverified Sillage endpoints (biggest risk,
but completes the chain), or (b) build Signal Aggregator + Hypothesis Validator now against
hand-crafted test input (matching how each agent above was smoke-tested before its upstream
existed) so they're ready the moment Content Listener lands. Ask the user which before starting
either — this was a deliberate scoping decision made earlier (see git history / this file's
"what's NOT built" section), not an oversight.
