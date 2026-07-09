import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return value;
}

export const env = {
  get fullEnrichApiKey() {
    return required('FULLENRICH_API_KEY');
  },
  /** Backend CRM tsplus-outreach (FastAPI), joignable via Tailscale. */
  get crmApiBase() {
    return process.env.CRM_API_BASE || 'http://100.102.244.19:8221';
  },
  get crmUsername() {
    return required('CRM_USERNAME');
  },
  get crmPassword() {
    return required('CRM_PASSWORD');
  },
  /** Séquence d'enrôlement optionnelle (livraison opt-in ; vide = création du prospect uniquement). */
  get crmSequenceId(): number | undefined {
    const raw = process.env.CRM_SEQUENCE_ID;
    return raw ? Number(raw) : undefined;
  },
  get sillageApiKey() {
    return required('SILLAGE_API_KEY');
  },
  get sillageApiBase() {
    return process.env.SILLAGE_API_BASE || 'https://api.getsillage.com';
  },
  get anthropicApiKey() {
    return required('ANTHROPIC_API_KEY');
  },
};
