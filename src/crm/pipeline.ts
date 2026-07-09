import { TsplusCrmClient, type Prospect } from './client.js';

/** Tag d'origine posé sur source_list — permet de filtrer/mesurer ce que IC(E)looP a déposé. */
export const SOURCE_LIST = 'IC(E)looP';
/** Statut initial d'un prospect déposé (le backend prend le relais ensuite). */
export const INITIAL_STATUS = 'new';

export interface QualifiedLead {
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  jobTitle?: string;
  linkedinUrl?: string;
  companyName?: string;
  /** Résumé du signal sourcé (Sillage) qui a déclenché ce lead — tracé dans les notes. */
  sourceSignal: string;
}

export interface PushResult {
  prospectId: number;
  created: boolean;
  enrolled: boolean;
}

/** Options de livraison. Par défaut : créer le prospect uniquement (le brief impose une validation
    humaine avant tout envoi). L'enrôlement en séquence est opt-in. */
export interface DeliverOptions {
  /** Si défini, le prospect est enrôlé dans cette séquence après création. */
  sequenceId?: number;
  /** 'manual' (défaut) = enrôlé mais rien n'est envoyé sans action humaine. */
  sendMode?: 'manual' | 'auto';
}

/**
 * Dépose un lead qualifié dans le CRM tsplus-outreach.
 *
 * Différences avec l'ancienne version HubSpot :
 *  - Pas d'objet Company : `company` est un champ texte libre sur le prospect.
 *  - Pas d'objet Deal : il n'existe pas côté tsplus. Le "dépôt dans le pipeline" = création du prospect,
 *    plus (optionnel) un enrôlement en séquence.
 *  - Le téléphone (FullEnrich) n'a pas de champ dédié sur le prospect -> stocké dans les notes.
 *  - Dédup par email côté client (pas d'upsert : ProspectUpdate ne touche pas les champs contact),
 *    donc un prospect existant est réutilisé tel quel, jamais écrasé.
 */
export async function pushQualifiedLead(
  crm: TsplusCrmClient,
  lead: QualifiedLead,
  options: DeliverOptions = {}
): Promise<PushResult> {
  const existing = await crm.findProspectByEmail(lead.email);

  let prospect: Prospect;
  let created: boolean;
  if (existing) {
    prospect = existing;
    created = false;
  } else {
    const notes = [`Signal source (Sillage): ${lead.sourceSignal}`, lead.phone ? `Tél: ${lead.phone}` : null]
      .filter(Boolean)
      .join('\n');
    prospect = await crm.createProspect({
      first_name: lead.firstName ?? null,
      last_name: lead.lastName ?? null,
      email: lead.email,
      title: lead.jobTitle ?? null,
      company: lead.companyName ?? null,
      linkedin_url: lead.linkedinUrl ?? null,
      source_list: SOURCE_LIST,
      status: INITIAL_STATUS,
      notes,
    });
    created = true;
  }

  let enrolled = false;
  if (options.sequenceId) {
    await crm.enroll(options.sequenceId, [prospect.id], options.sendMode ?? 'manual');
    enrolled = true;
  }

  return { prospectId: prospect.id, created, enrolled };
}
