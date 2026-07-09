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
  get hubspotToken() {
    return required('HUBSPOT_PRIVATE_APP_TOKEN');
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
