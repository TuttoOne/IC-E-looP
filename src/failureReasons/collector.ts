import { TsplusCrmClient } from '../crm/client.js';

export interface FailureReason {
  source: 'prospect';
  reason: string;
  companyName?: string;
}

/**
 * Raisons d'échec récentes, lues sur le CRM tsplus-outreach.
 *
 * tsplus n'a pas d'objet Deal ni de "closed_lost_reason". La raison explicite consignée par un
 * humain vit dans le champ `feedback` du prospect. On ne garde QUE les prospects avec un feedback
 * non vide — conforme au brief : capter les raisons uniquement là où elles existent réellement,
 * jamais inférées du silence.
 */
export async function collectFailureReasons(crm: TsplusCrmClient): Promise<FailureReason[]> {
  const prospects = await crm.listProspects({}, 500);
  return prospects
    .filter((p) => (p.feedback ?? '').trim().length > 0)
    .map((p) => ({
      source: 'prospect' as const,
      reason: (p.feedback as string).trim(),
      companyName: p.company ?? undefined,
    }));
}

export function summarizeFailureReasons(reasons: FailureReason[]): string {
  if (!reasons.length) return "Aucune raison d'échec récente trouvée dans le CRM.";
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `- ${reason}: ${count}`)
    .join('\n');
}
