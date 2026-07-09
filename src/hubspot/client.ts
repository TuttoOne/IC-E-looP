/* Port du client HubSpot de fullenrich-extension/background.js (hsFetch, dédup contact,
   recherche company par domaine) + ajout de la création de Deal, absente de l'extension. */

const HS_BASE = 'https://api.hubapi.com';

const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr',
  'live.com', 'live.fr', 'yahoo.com', 'yahoo.fr', 'icloud.com', 'me.com', 'mac.com',
  'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'bbox.fr', 'neuf.fr',
  'protonmail.com', 'proton.me', 'gmx.com', 'gmx.fr', 'msn.com', 'aol.com',
]);

export const businessDomain = (email: string): string | null => {
  const domain = (email.split('@')[1] || '').toLowerCase().trim();
  return domain && !FREE_MAIL_DOMAINS.has(domain) ? domain : null;
};

export interface HsCompanyMatch {
  id: string;
  name: string;
  domain: string | null;
}

interface HsFetchOpts {
  method?: string;
  body?: unknown;
}

export class HubspotClient {
  constructor(private readonly token: string) {}

  private async fetch(path: string, opts: HsFetchOpts = {}) {
    const res = await fetch(HS_BASE + path, {
      method: opts.method ?? 'GET',
      headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* 204 ou corps vide */
    }
    if (!res.ok && res.status !== 404 && res.status !== 409) {
      throw new Error(`HubSpot ${opts.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${json?.message ?? ''}`);
    }
    return { status: res.status, ok: res.ok, json };
  }

  async lookupContactByEmail(email: string): Promise<{ id: string } | null> {
    const { status, ok, json } = await this.fetch(
      `/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email`
    );
    if (ok && json?.id) return { id: json.id };
    if (status === 404) return null;
    throw new Error(`HubSpot: lookup contact ${email} a échoué (HTTP ${status})`);
  }

  async searchCompaniesByDomain(domain: string): Promise<HsCompanyMatch[]> {
    const { json } = await this.fetch('/crm/v3/objects/companies/search', {
      method: 'POST',
      body: {
        filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] }],
        properties: ['name', 'domain'],
        limit: 10,
      },
    });
    return ((json?.results as any[]) || []).map((r) => ({
      id: r.id,
      name: r.properties?.name ?? '(sans nom)',
      domain: r.properties?.domain ?? null,
    }));
  }

  async searchObjects(
    objectType: 'contacts' | 'companies' | 'deals',
    filterGroups: unknown[],
    properties: string[],
    limit = 50
  ): Promise<any[]> {
    const { json } = await this.fetch(`/crm/v3/objects/${objectType}/search`, {
      method: 'POST',
      body: { filterGroups, properties, limit },
    });
    return (json?.results as any[]) || [];
  }

  async createCompany(properties: Record<string, unknown>): Promise<string> {
    const { json } = await this.fetch('/crm/v3/objects/companies', { method: 'POST', body: { properties } });
    if (!json?.id) throw new Error('HubSpot: création company sans id en retour');
    return json.id;
  }

  /** Crée le contact, ou le met à jour s'il existe déjà (dédup par email, comme l'extension). */
  async upsertContact(properties: Record<string, unknown>): Promise<{ id: string; created: boolean }> {
    const email = properties.email as string | undefined;
    const existing = email ? await this.lookupContactByEmail(email) : null;
    if (existing) {
      await this.fetch(`/crm/v3/objects/contacts/${existing.id}`, { method: 'PATCH', body: { properties } });
      return { id: existing.id, created: false };
    }
    const { status, json } = await this.fetch('/crm/v3/objects/contacts', { method: 'POST', body: { properties } });
    if (json?.id) return { id: json.id, created: true };
    if (status === 409) {
      const match = (json?.message ?? '').match(/Existing ID:\s*(\d+)/i);
      if (!match) throw new Error(`HubSpot: conflit sur création contact sans ID exploitable (${json?.message})`);
      await this.fetch(`/crm/v3/objects/contacts/${match[1]}`, { method: 'PATCH', body: { properties } });
      return { id: match[1], created: false };
    }
    throw new Error(`HubSpot: création contact a échoué (HTTP ${status})`);
  }

  async associateContactToCompany(contactId: string, companyId: string): Promise<void> {
    await this.fetch(`/crm/v4/objects/contact/${contactId}/associations/default/company/${companyId}`, {
      method: 'PUT',
    });
  }

  async createDeal(properties: Record<string, unknown>): Promise<string> {
    const { json } = await this.fetch('/crm/v3/objects/deals', { method: 'POST', body: { properties } });
    if (!json?.id) throw new Error('HubSpot: création deal sans id en retour');
    return json.id;
  }

  async associateDeal(dealId: string, toObjectType: 'contact' | 'company', toObjectId: string): Promise<void> {
    await this.fetch(`/crm/v4/objects/deal/${dealId}/associations/default/${toObjectType}/${toObjectId}`, {
      method: 'PUT',
    });
  }

  /** Résout le pipelineId + stageId réels à partir de leurs labels (les stages sont propres à chaque pipeline). */
  async findDealPipelineStage(
    pipelineLabel: string,
    stageLabel: string
  ): Promise<{ pipelineId: string; stageId: string }> {
    const { json } = await this.fetch('/crm/v3/pipelines/deals');
    const pipeline = (json?.results as any[] ?? []).find(
      (p) => p.label.toLowerCase() === pipelineLabel.toLowerCase()
    );
    if (!pipeline) throw new Error(`HubSpot: pipeline "${pipelineLabel}" introuvable`);
    const stage = (pipeline.stages as any[]).find((s) => s.label.toLowerCase() === stageLabel.toLowerCase());
    if (!stage) throw new Error(`HubSpot: stage "${stageLabel}" introuvable dans le pipeline "${pipelineLabel}"`);
    return { pipelineId: pipeline.id, stageId: stage.id };
  }
}
