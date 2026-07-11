// scripts/push-agent.mjs
// Pushes an agent's JSON config from the repo to the Managed Agents API.
// If the env var for that agent isn't set yet, creates a brand-new agent
// instead and prints the id to add to .env. Otherwise each push creates a
// new immutable version of the existing agent; new sessions pick it up
// automatically.
//
// Usage:
//   npm run push-agent                      -> agent Questioning (défaut)
//   node scripts/push-agent.mjs scoring     -> agent Scoring
//   node scripts/push-agent.mjs persona     -> agent Persona Builder

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(root, ".env") });

const AGENTS = {
  questioning: {
    envVar: "AGENT_ID",
    file: join("Agents", "1 - Questionning Agent", "agent.json"),
  },
  scoring: {
    envVar: "SCORING_AGENT_ID",
    file: join("Agents", "2 - Scoring Agent", "agent.json"),
  },
  persona: {
    envVar: "PERSONA_AGENT_ID",
    file: join("Agents", "3 - Persona Agent", "agent.json"),
  },
  stakeholder: {
    envVar: "STAKEHOLDER_AGENT_ID",
    file: join("Agents", "4 - Stakeholder map agent", "agent.json"),
  },
};

const target = process.argv[2] || "questioning";
if (!AGENTS[target]) {
  console.error(`Agent inconnu : "${target}". Choix possibles : ${Object.keys(AGENTS).join(", ")}`);
  process.exit(1);
}

const { envVar, file } = AGENTS[target];
const agentId = process.env[envVar];
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(`ANTHROPIC_API_KEY doit être défini dans .env`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(join(root, file), "utf8"));

const headers = {
  "Content-Type": "application/json",
  "x-api-key": process.env.ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "managed-agents-2026-04-01",
};

async function call(url, options) {
  const r = await fetch(url, { headers, ...options });
  const data = await r.json();
  if (!r.ok) {
    console.error(`Erreur API (${r.status}) :`, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

if (!agentId) {
  const created = await call("https://api.anthropic.com/v1/agents", {
    method: "POST",
    body: JSON.stringify(config),
  });
  console.log(`Agent "${created.name}" créé (${created.id}).`);
  console.log(`Ajoute ceci à .env : ${envVar}=${created.id}`);
} else {
  const url = `https://api.anthropic.com/v1/agents/${agentId}`;
  const current = await call(url, { method: "GET" });
  const updated = await call(url, {
    method: "POST",
    body: JSON.stringify({ ...config, version: current.version }),
  });
  console.log(`Agent "${updated.name}" (${agentId}) mis à jour.`);
  console.log(`Version : ${current.version} → ${updated.version}`);
}
