/* Create round-trip smoke test — exercises the REAL adapter (not curl):
   pushQualifiedLead() -> POST /api/prospects -> findProspectByEmail() to confirm it landed.
   Creates ONE clearly-marked test record (source_list="IC(E)looP", email iceloop-smoke-*@example.com).
   Run:  npx tsx scripts/crm-create-smoke.ts
   Needs CRM_* in .env. Create-only: no sequence enrollment. Cleanup notes printed at the end. */
import 'dotenv/config';
import { env } from '../src/config/env.js';
import { TsplusCrmClient } from '../src/crm/client.js';
import { pushQualifiedLead, SOURCE_LIST } from '../src/crm/pipeline.js';

async function main() {
  const crm = new TsplusCrmClient({
    baseUrl: env.crmApiBase,
    username: env.crmUsername,
    password: env.crmPassword,
  });

  const email = `iceloop-smoke-${Date.now()}@example.com`;
  console.log(`1) creating test prospect ${email} (source_list="${SOURCE_LIST}")`);

  const result = await pushQualifiedLead(crm, {
    firstName: 'ICE',
    lastName: 'Smoke',
    email,
    jobTitle: 'Adapter Test',
    companyName: 'IC(E)looP Smoke Test',
    sourceSignal: 'crm-create-smoke.ts write-path verification',
  });
  console.log(`   -> prospect id ${result.prospectId}, created=${result.created}`);
  if (!result.created) throw new Error('expected a fresh create (unique email collided?)');

  console.log('2) reading it back by email (dedup path)');
  const found = await crm.findProspectByEmail(email);
  if (!found || found.id !== result.prospectId) {
    throw new Error(`read-back failed: expected id ${result.prospectId}, got ${found?.id ?? 'null'}`);
  }
  console.log(`   -> found id ${found.id}, company="${found.company}", source_list="${found.source_list}"`);

  // Assert the fields we SET actually round-trip — a create that silently drops a field
  // (source_list did exactly this) must fail the test, not print GREEN. See PR #1 discussion.
  if (found.source_list !== SOURCE_LIST) {
    throw new Error(
      `source_list did not round-trip: sent "${SOURCE_LIST}", read back "${found.source_list}". ` +
        'Backend POST /api/prospects is dropping the field.'
    );
  }
  if (found.company !== 'IC(E)looP Smoke Test') {
    throw new Error(`company did not round-trip: read back "${found.company}".`);
  }

  console.log('\nWRITE PATH GREEN — create + read-back both work, source_list tag persists.');
  console.log(`Cleanup: this left one test prospect (id ${result.prospectId}, ${email}).`);
  console.log(`Delete it in the CRM UI, or filter source_list="${SOURCE_LIST}" to find IC(E)looP test rows.`);
}

main().catch((err) => {
  console.error('\nWRITE PATH FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
