import { HubspotClient, businessDomain } from './client.js';

/** Nom réel du pipeline deals du portail 1POINT6 (ne pas en créer un nouveau). */
export const DEAL_PIPELINE_LABEL = '1POINT6 Sales Pipeline';
export const DEAL_STAGE_ON_CREATE = 'Discovery';

/** Valeurs réelles de la propriété contact hs_lead_status (portail 1POINT6). */
export const LeadStatus = {
  NEW: 'NEW',
  ATTEMPTED_TO_CONTACT: 'ATTEMPTED_TO_CONTACT',
  CONNECTED: 'CONNECTED',
  OPEN_DEAL: 'OPEN_DEAL',
  BAD_TIMING: 'BAD_TIMING',
  UNQUALIFIED: 'UNQUALIFIED',
  UNRESPONSIVE: 'UNRESPONSIVE',
} as const;

export interface QualifiedLead {
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  jobTitle?: string;
  linkedinUrl?: string;
  companyName?: string;
  /** Résumé du signal sourcé (Sillage) qui a déclenché ce lead — tracé sur le deal. */
  sourceSignal: string;
}

export interface PushResult {
  contactId: string;
  companyId: string | null;
  dealId: string;
}

/**
 * Crée/met à jour Contact + Company + Deal pour un lead qualifié, en réutilisant le pipeline
 * et le Lead Status déjà en place côté HubSpot (les workflows existants prennent le relais
 * pour l'envoi de communication — ce service ne fait que déposer le lead au bon endroit).
 */
export async function pushQualifiedLead(hubspot: HubspotClient, lead: QualifiedLead): Promise<PushResult> {
  const domain = businessDomain(lead.email);

  let companyId: string | null = null;
  if (domain) {
    const matches = await hubspot.searchCompaniesByDomain(domain);
    companyId = matches[0]?.id ?? null;
    if (!companyId && lead.companyName) {
      companyId = await hubspot.createCompany({ name: lead.companyName, domain });
    }
  }

  const { id: contactId } = await hubspot.upsertContact({
    firstname: lead.firstName,
    lastname: lead.lastName,
    email: lead.email,
    mobilephone: lead.phone,
    jobtitle: lead.jobTitle,
    hs_linkedin_url: lead.linkedinUrl,
    hs_lead_status: LeadStatus.NEW,
  });
  if (companyId) await hubspot.associateContactToCompany(contactId, companyId);

  const { pipelineId, stageId } = await hubspot.findDealPipelineStage(DEAL_PIPELINE_LABEL, DEAL_STAGE_ON_CREATE);
  const dealId = await hubspot.createDeal({
    dealname: `${lead.companyName ?? lead.email} — ${lead.sourceSignal}`,
    pipeline: pipelineId,
    dealstage: stageId,
  });
  await hubspot.associateDeal(dealId, 'contact', contactId);
  if (companyId) await hubspot.associateDeal(dealId, 'company', companyId);

  return { contactId, companyId, dealId };
}
