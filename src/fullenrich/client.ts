/* Port du client FullEnrich de fullenrich-extension/background.js pour un usage backend (batch, sans UI).
   Même endpoint, même logique de polling — seule la persistance (chrome.storage) disparaît. */

const API_BASE = 'https://app.fullenrich.com/api/v2';
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_FIRST_MS = 10 * 1000;
const POLL_FAST_MS = 3 * 1000;
const POLL_SLOW_MS = 15 * 1000;
const POLL_FAST_WINDOW_MS = 90 * 1000;

const FIELD_WORK = 'contact.work_emails';
const FIELD_PHONE = 'contact.phones';

export interface EnrichInput {
  linkedinUrl: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
}

export interface EnrichResult {
  workEmails: string[];
  phones: string[];
}

async function apiFetch(apiKey: string, path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(API_BASE + path, {
    method: opts.method ?? 'GET',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* réponse vide */
  }
  return { status: res.status, ok: res.ok, json };
}

function normalizeResult(json: any): EnrichResult {
  const contact = (json.datas || json.data || [])[0] || {};
  const info = contact.contact_info || {};
  const workEmails = [info.most_probable_work_email, ...(info.work_emails || [])]
    .map((e) => (typeof e === 'string' ? e : e?.email))
    .filter((e): e is string => Boolean(e));
  const phones = [info.most_probable_phone, ...(info.phones || [])]
    .map((p) => (typeof p === 'string' ? p : p?.number ?? p?.phone))
    .filter((p): p is string => Boolean(p));
  return { workEmails: [...new Set(workEmails)], phones: [...new Set(phones)] };
}

export class FullEnrichClient {
  constructor(private readonly apiKey: string) {}

  /** Lance un enrichissement bulk et attend le résultat (poll bloquant, cadence identique à l'extension). */
  async enrich(input: EnrichInput): Promise<EnrichResult> {
    const contact: Record<string, unknown> = {
      linkedin_url: input.linkedinUrl,
      enrich_fields: [FIELD_WORK, FIELD_PHONE],
    };
    if (input.firstName) contact.first_name = input.firstName;
    if (input.lastName) contact.last_name = input.lastName;
    if (input.companyName) contact.company_name = input.companyName;

    const label = [input.firstName, input.lastName].filter(Boolean).join(' ') || input.linkedinUrl;
    const start = await apiFetch(this.apiKey, '/contact/enrich/bulk', {
      method: 'POST',
      body: { name: 'ic-e-loop - ' + label, data: [contact] },
    });
    if (start.status === 401) throw new Error('FullEnrich: clé API invalide');
    if (!start.ok || !start.json?.enrichment_id) {
      throw new Error(`FullEnrich: échec de démarrage (${start.json?.message ?? start.status})`);
    }
    const enrichmentId = start.json.enrichment_id;
    const startedAt = Date.now();

    await sleep(POLL_FIRST_MS);
    while (true) {
      const elapsed = Date.now() - startedAt;
      const timedOut = elapsed > POLL_TIMEOUT_MS;
      const poll = await apiFetch(this.apiKey, `/contact/enrich/bulk/${enrichmentId}?forceResults=true`);
      if (poll.status === 401) throw new Error('FullEnrich: clé API invalide');

      if (poll.ok && poll.json) {
        const batchStatus = poll.json.status || 'UNKNOWN';
        if (batchStatus === 'FINISHED') return normalizeResult(poll.json);
        if (batchStatus === 'CREDITS_INSUFFICIENT') throw new Error('FullEnrich: crédits insuffisants');
        if (batchStatus === 'CANCELED') throw new Error('FullEnrich: enrichissement annulé');
        if (timedOut) {
          const partial = normalizeResult(poll.json);
          if (partial.workEmails.length || partial.phones.length) return partial;
          throw new Error('FullEnrich: timeout sans résultat');
        }
      } else if (timedOut) {
        throw new Error('FullEnrich: timeout');
      }

      const rateLimited = poll.status === 429 || poll.json?.status === 'RATE_LIMIT';
      await sleep(rateLimited ? POLL_SLOW_MS : elapsed < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
