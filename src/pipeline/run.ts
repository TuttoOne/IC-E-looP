/* Orchestrateur: ICP -> Sillage (écoute + signaux) -> Full Enrich (détails + bonne personne)
   -> CRM tsplus-outreach (Prospect). Les étapes "Failure reasons" / "Refine ICP" sont un job
   séparé (npm run refine-icp), volontairement pas ré-exécuté à chaque run.
   Usage: npm run pipeline [-- --dry-run] */

import { env } from '../config/env.js';
import { loadIcp } from '../config/icp.js';
import { SillageClient, type SillageSignal } from '../sillage/client.js';
import { FullEnrichClient } from '../fullenrich/client.js';
import { TsplusCrmClient } from '../crm/client.js';
import { pushQualifiedLead, type QualifiedLead } from '../crm/pipeline.js';

const DRY_RUN = process.argv.includes('--dry-run');

function isRightPerson(signal: SillageSignal, targetJobTitles: string[]): boolean {
  if (!targetJobTitles.length || !signal.contactJobTitle) return true;
  const title = signal.contactJobTitle.toLowerCase();
  return targetJobTitles.some((t) => title.includes(t.toLowerCase()));
}

async function main() {
  const icp = await loadIcp();
  if (!icp.industries.length && !icp.problemSignals.length) {
    console.error("ICP vide ou incomplet — lancer d'abord `npm run interrogate`.");
    process.exitCode = 1;
    return;
  }

  const sillage = new SillageClient(env.sillageApiKey, env.sillageApiBase);
  const fullEnrich = new FullEnrichClient(env.fullEnrichApiKey);
  const crm = new TsplusCrmClient({
    baseUrl: env.crmApiBase,
    username: env.crmUsername,
    password: env.crmPassword,
  });

  console.log(`ICP: ${icp.summary || '(pas de résumé)'}`);
  console.log(DRY_RUN ? '--dry-run: aucune écriture CRM ne sera faite.\n' : 'Mode réel: des prospects seront créés dans le CRM.\n');

  const [problemDiscussions, triggerSignals] = await Promise.all([
    sillage.findProblemDiscussions(icp),
    sillage.findTriggerSignals(icp),
  ]);
  const signals = [...problemDiscussions, ...triggerSignals];
  console.log(`Sillage: ${problemDiscussions.length} discussions autour du problème, ${triggerSignals.length} signaux déclencheurs.`);

  let pushed = 0;
  let skipped = 0;

  for (const signal of signals) {
    if (!signal.contactLinkedinUrl) {
      console.log(`- ${signal.companyName}: pas de contact LinkedIn identifié, ignoré.`);
      skipped++;
      continue;
    }
    if (!isRightPerson(signal, icp.targetJobTitles)) {
      console.log(`- ${signal.companyName}: contact hors cible (${signal.contactJobTitle}), ignoré.`);
      skipped++;
      continue;
    }

    let enriched;
    try {
      enriched = await fullEnrich.enrich({
        linkedinUrl: signal.contactLinkedinUrl,
        firstName: signal.contactFirstName ?? undefined,
        lastName: signal.contactLastName ?? undefined,
        companyName: signal.companyName,
      });
    } catch (err) {
      console.log(`- ${signal.companyName}: échec Full Enrich (${(err as Error).message}), ignoré.`);
      skipped++;
      continue;
    }

    const email = enriched.workEmails[0];
    if (!email) {
      console.log(`- ${signal.companyName}: pas d'email pro trouvé, ignoré.`);
      skipped++;
      continue;
    }

    const lead: QualifiedLead = {
      firstName: signal.contactFirstName ?? undefined,
      lastName: signal.contactLastName ?? undefined,
      email,
      phone: enriched.phones[0],
      jobTitle: signal.contactJobTitle ?? undefined,
      linkedinUrl: signal.contactLinkedinUrl,
      companyName: signal.companyName,
      sourceSignal: signal.description,
    };

    if (DRY_RUN) {
      console.log(`- [dry-run] serait pushé: ${lead.email} @ ${lead.companyName} (${signal.description})`);
      pushed++;
      continue;
    }

    const result = await pushQualifiedLead(crm, lead, { sequenceId: env.crmSequenceId });
    const verb = result.created ? 'créé' : 'déjà présent';
    console.log(`- pushé: ${lead.email} -> prospect ${result.prospectId} (${verb})${result.enrolled ? ', enrôlé' : ''}`);
    pushed++;
  }

  console.log(`\nTerminé: ${pushed} lead(s) ${DRY_RUN ? '(dry-run) ' : ''}poussé(s), ${skipped} ignoré(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
