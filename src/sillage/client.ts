/* Client Sillage (getsillage.com) — plateforme de détection de signaux d'achat B2B.
   Pas de doc API publique : les chemins/formats ci-dessous sont des PLACEHOLDERS à corriger
   dès que la doc/clé réelle est fournie. Le reste du pipeline dépend de cette interface,
   pas de l'implémentation exacte — un seul fichier à ajuster. */

import type { Icp } from '../config/icp.js';

export interface SillageSignal {
  companyName: string;
  companyDomain: string | null;
  contactLinkedinUrl: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactJobTitle: string | null;
  /** Résumé lisible du signal (ex: "levée de fonds Série A", "post LinkedIn sur le sujet X"). */
  description: string;
  kind: 'problem_discussion' | 'trigger';
}

export class SillageClient {
  constructor(
    private readonly apiKey: string,
    private readonly apiBase: string
  ) {}

  private async request(path: string, body: unknown): Promise<any> {
    const res = await fetch(this.apiBase + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Sillage ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  /** "Sillage to see if people are talking through the problem" — écoute sociale/web sur les problemSignals de l'ICP. */
  async findProblemDiscussions(icp: Icp): Promise<SillageSignal[]> {
    // TODO: remplacer /placeholder/listen par l'endpoint réel une fois la doc Sillage fournie.
    const json = await this.request('/placeholder/listen', {
      keywords: icp.problemSignals,
      industries: icp.industries,
      geographies: icp.geographies,
    });
    return (json.results ?? []).map(toSignal('problem_discussion'));
  }

  /** "Sillage to look for signals to trigger communication" — signaux d'achat (levée de fonds, embauche, etc.). */
  async findTriggerSignals(icp: Icp): Promise<SillageSignal[]> {
    // TODO: remplacer /placeholder/signals par l'endpoint réel une fois la doc Sillage fournie.
    const json = await this.request('/placeholder/signals', {
      triggerTypes: icp.triggerSignals,
      industries: icp.industries,
      companySizeRange: icp.companySizeRange,
      geographies: icp.geographies,
    });
    return (json.results ?? []).map(toSignal('trigger'));
  }
}

function toSignal(kind: SillageSignal['kind']) {
  return (r: any): SillageSignal => ({
    companyName: r.company_name ?? r.companyName ?? '',
    companyDomain: r.company_domain ?? r.companyDomain ?? null,
    contactLinkedinUrl: r.contact_linkedin_url ?? r.linkedinUrl ?? null,
    contactFirstName: r.contact_first_name ?? null,
    contactLastName: r.contact_last_name ?? null,
    contactJobTitle: r.contact_job_title ?? null,
    description: r.description ?? r.summary ?? '',
    kind,
  });
}
