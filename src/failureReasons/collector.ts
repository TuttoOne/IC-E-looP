import { HubspotClient } from '../hubspot/client.js';
import { DEAL_PIPELINE_LABEL, LeadStatus } from '../hubspot/pipeline.js';

export interface FailureReason {
  source: 'deal' | 'contact';
  reason: string;
  companyName?: string;
}

/** Raisons d'échec récentes: deals "Lost" (closed_lost_reason) et contacts déqualifiés (hs_lead_status). */
export async function collectFailureReasons(hubspot: HubspotClient): Promise<FailureReason[]> {
  const { pipelineId, stageId: lostStageId } = await hubspot.findDealPipelineStage(DEAL_PIPELINE_LABEL, 'Lost');

  const lostDeals = await hubspot.searchObjects(
    'deals',
    [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: pipelineId }, { propertyName: 'dealstage', operator: 'EQ', value: lostStageId }] }],
    ['dealname', 'closed_lost_reason']
  );
  const dealReasons: FailureReason[] = lostDeals
    .filter((d) => d.properties?.closed_lost_reason)
    .map((d) => ({ source: 'deal' as const, reason: d.properties.closed_lost_reason, companyName: d.properties.dealname }));

  const unqualifiedStatuses = [LeadStatus.UNQUALIFIED, LeadStatus.BAD_TIMING, LeadStatus.UNRESPONSIVE];
  const unqualifiedContacts = await hubspot.searchObjects(
    'contacts',
    [{ filters: [{ propertyName: 'hs_lead_status', operator: 'IN', values: unqualifiedStatuses }] }],
    ['company', 'hs_lead_status']
  );
  const contactReasons: FailureReason[] = unqualifiedContacts.map((c) => ({
    source: 'contact' as const,
    reason: c.properties?.hs_lead_status,
    companyName: c.properties?.company,
  }));

  return [...dealReasons, ...contactReasons];
}

export function summarizeFailureReasons(reasons: FailureReason[]): string {
  if (!reasons.length) return "Aucune raison d'échec récente trouvée dans HubSpot.";
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `- ${reason}: ${count}`)
    .join('\n');
}
