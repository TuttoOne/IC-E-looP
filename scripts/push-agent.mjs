// scripts/push-agent.mjs
// Pushes an agent's JSON config from the repo to the Managed Agents API.
// Each push creates a new immutable version; new sessions pick it up automatically.
//
// Usage:
//   npm run push-agent                      -> agent Questioning (défaut)
//   node scripts/push-agent.mjs scoring     -> agent Scoring

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
};

const target = process.argv[2] || "questioning";
if (!AGENTS[target]) {
  console.error(`Agent inconnu : "${target}". Choix possibles : ${Object.keys(AGENTS).join(", ")}`);
  process.exit(1);
}

const { envVar, file } = AGENTS[target];
const agentId = process.env[envVar];
if (!process.env.ANTHROPIC_API_KEY || !agentId) {
  console.error(`ANTHROPIC_API_KEY et ${envVar} doivent être définis dans .env`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(join(root, file), "utf8"));

const headers = {
  "Content-Type": "application/json",
  "x-api-key": process.env.ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "managed-agents-2026-04-01",
};
const url = `https://api.anthropic.com/v1/agents/${agentId}`;

async function call(options) {
  const r = await fetch(url, { headers, ...options });
  const data = await r.json();
  if (!r.ok) {
    console.error(`Erreur API (${r.status}) :`, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

const current = await call({ method: "GET" });
const updated = await call({
  method: "POST",
  body: JSON.stringify({ ...config, version: current.version }),
});

console.log(`Agent "${updated.name}" (${agentId}) mis à jour.`);
console.log(`Version : ${current.version} → ${updated.version}`);
