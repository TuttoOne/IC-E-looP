/* Client CRM tsplus-outreach (remplace l'ancien client HubSpot).
   Parle au backend FastAPI "TSplus Outreach" en REST, pas au serveur MCP stdio :
   le pipeline Node n'est pas un client MCP, et le backend expose déjà tout en HTTP
   (joignable via Tailscale, ex. http://100.102.244.19:8221).

   Auth : OAuth2 password (POST /api/auth/login, form-urlencoded) -> bearer token.
   Le token est acquis paresseusement et rafraîchi sur 401. */

export interface Prospect {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  title: string | null;
  company: string | null;
  linkedin_url: string | null;
  status: string | null;
  fit_level: string | null;
  /** Raison explicite consignée par un humain (pourquoi ce prospect n'a pas abouti). */
  feedback: string | null;
  source_list: string | null;
  notes: string | null;
}

export interface ListProspectsParams {
  q?: string;
  status?: string;
  fit_level?: string;
  source_list?: string;
  limit?: number;
  offset?: number;
}

/** Corps attendu par le endpoint de création à ajouter côté backend (POST /api/prospects).
    Voir docs/crm-create-endpoint.md pour le contrat exact. */
export interface ProspectCreate {
  first_name?: string | null;
  last_name?: string | null;
  email: string;
  title?: string | null;
  company?: string | null;
  website?: string | null;
  linkedin_url?: string | null;
  country?: string | null;
  location?: string | null;
  source_list?: string | null;
  prospect_type?: string | null;
  status?: string | null;
  notes?: string | null;
}

export interface CrmClientOptions {
  baseUrl: string;
  username: string;
  password: string;
}

interface FetchOpts {
  method?: string;
  body?: unknown;
  /** form-urlencoded au lieu de JSON (login OAuth2). */
  form?: Record<string, string>;
  /** appel interne : ne pas tenter de ré-auth sur 401 (évite la récursion). */
  noAuthRetry?: boolean;
}

export class TsplusCrmClient {
  private token: string | null = null;

  constructor(private readonly opts: CrmClientOptions) {
    this.opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, '') };
  }

  private async login(): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        username: this.opts.username,
        password: this.opts.password,
      }).toString(),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.access_token) {
      // 2FA activée -> le backend renvoie un challenge TOTP, non géré ici (compte de service sans 2FA attendu).
      const hint = json?.detail ?? res.status;
      throw new Error(`CRM: login échoué (${hint}). Utiliser un compte de service sans 2FA.`);
    }
    const token = json.access_token as string;
    this.token = token;
    return token;
  }

  private async fetch(path: string, opts: FetchOpts = {}): Promise<{ status: number; ok: boolean; json: any }> {
    if (!this.token) await this.login();
    const doFetch = async () => {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
      let body: string | undefined;
      if (opts.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(opts.form).toString();
      } else if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.body);
      }
      return fetch(`${this.opts.baseUrl}${path}`, { method: opts.method ?? 'GET', headers, body });
    };

    let res = await doFetch();
    if (res.status === 401 && !opts.noAuthRetry) {
      this.token = null;
      await this.login();
      res = await doFetch();
    }
    const json: any = await res.json().catch(() => null);
    // 404 (chemin absent) et 405 (méthode non exposée, ex. POST /api/prospects pas encore ajouté)
    // sont interprétés par l'appelant, pas des erreurs génériques.
    if (!res.ok && res.status !== 404 && res.status !== 405) {
      const detail = json?.detail ?? '';
      throw new Error(`CRM ${opts.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${JSON.stringify(detail)}`);
    }
    return { status: res.status, ok: res.ok, json };
  }

  private static rows(json: any): any[] {
    if (Array.isArray(json)) return json;
    return json?.items ?? json?.results ?? json?.prospects ?? [];
  }

  /** Dédup par email : GET /api/prospects?q=<email> est une recherche floue, on filtre l'égalité exacte. */
  async findProspectByEmail(email: string): Promise<Prospect | null> {
    const { json } = await this.fetch(`/api/prospects?q=${encodeURIComponent(email)}&limit=25`);
    const norm = email.trim().toLowerCase();
    const match = TsplusCrmClient.rows(json).find(
      (p) => (p?.email ?? '').trim().toLowerCase() === norm
    );
    return match ?? null;
  }

  /** Crée un prospect. Nécessite le endpoint backend POST /api/prospects (voir docs/crm-create-endpoint.md). */
  async createProspect(input: ProspectCreate): Promise<Prospect> {
    const { status, json } = await this.fetch('/api/prospects', { method: 'POST', body: input });
    if (status === 404 || status === 405) {
      // Le backend expose GET /api/prospects mais pas encore POST (405) — ou le chemin est absent (404).
      throw new Error(
        `CRM: POST /api/prospects indisponible (HTTP ${status}). Le endpoint de création doit être ajouté ` +
          'au backend TSplus Outreach — voir docs/crm-create-endpoint.md.'
      );
    }
    if (!json?.id) throw new Error('CRM: création prospect sans id en retour');
    return json;
  }

  /** Liste paginée des prospects. Récupère jusqu'à `max` en suivant limit/offset. */
  async listProspects(params: ListProspectsParams = {}, max = 500): Promise<Prospect[]> {
    const pageSize = params.limit ?? 100;
    const out: Prospect[] = [];
    let offset = params.offset ?? 0;
    while (out.length < max) {
      const qs = new URLSearchParams();
      if (params.q) qs.set('q', params.q);
      if (params.status) qs.set('status', params.status);
      if (params.fit_level) qs.set('fit_level', params.fit_level);
      if (params.source_list) qs.set('source_list', params.source_list);
      qs.set('limit', String(pageSize));
      qs.set('offset', String(offset));
      const { json } = await this.fetch(`/api/prospects?${qs.toString()}`);
      const rows = TsplusCrmClient.rows(json);
      out.push(...rows);
      if (rows.length < pageSize) break;
      offset += pageSize;
    }
    return out.slice(0, max);
  }

  async listSequences(): Promise<Array<{ id: number; name?: string }>> {
    const { json } = await this.fetch('/api/sequences');
    return TsplusCrmClient.rows(json);
  }

  /** Enrôle des prospects dans une séquence. send_mode 'manual' = rien n'est envoyé sans action humaine. */
  async enroll(seqId: number, prospectIds: number[], sendMode: 'manual' | 'auto' = 'manual'): Promise<void> {
    await this.fetch(`/api/sequences/${seqId}/enroll`, {
      method: 'POST',
      body: { prospect_ids: prospectIds, send_mode: sendMode },
    });
  }
}
