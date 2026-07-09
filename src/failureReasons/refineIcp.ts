/* "Refine ICP" — agrège les raisons d'échec HubSpot puis relance l'Interrogation engine
   avec ce contexte, pour proposer des ajustements d'ICP à valider par l'utilisateur
   (jamais de modification silencieuse de l'ICP). */

import { env } from '../config/env.js';
import { HubspotClient } from '../hubspot/client.js';
import { collectFailureReasons, summarizeFailureReasons } from './collector.js';
import { runInterrogation } from '../interrogationEngine/dialogue.js';

async function main() {
  const hubspot = new HubspotClient(env.hubspotToken);
  const reasons = await collectFailureReasons(hubspot);
  const summary = summarizeFailureReasons(reasons);
  console.log('Raisons d\'échec récentes:\n' + summary + '\n');
  await runInterrogation(
    `Voici les raisons d'échec les plus fréquentes sur les leads/deals récents:\n${summary}\n` +
      "Propose des ajustements d'ICP en tenant compte de ces échecs, en les discutant avec l'utilisateur."
  );
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
