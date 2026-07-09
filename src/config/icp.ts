import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface Icp {
  /** Court résumé humain de l'ICP, utilisé comme contexte pour Sillage/Interrogation engine. */
  summary: string;
  industries: string[];
  companySizeRange: { minEmployees: number; maxEmployees: number };
  geographies: string[];
  targetJobTitles: string[];
  /** Ce qu'on cherche comme signe que l'entreprise vit le problème adressé. */
  problemSignals: string[];
  /** Signaux d'achat/déclencheurs (levée de fonds, changement de poste, embauche...). */
  triggerSignals: string[];
  updatedAt: string;
}

const DATA_DIR = path.resolve(import.meta.dirname, '../../data');
const ICP_PATH = path.join(DATA_DIR, 'icp.json');

export const defaultIcp: Icp = {
  summary: '',
  industries: [],
  companySizeRange: { minEmployees: 0, maxEmployees: 0 },
  geographies: [],
  targetJobTitles: [],
  problemSignals: [],
  triggerSignals: [],
  updatedAt: new Date(0).toISOString(),
};

export async function loadIcp(): Promise<Icp> {
  try {
    const raw = await readFile(ICP_PATH, 'utf-8');
    return { ...defaultIcp, ...JSON.parse(raw) };
  } catch (err: any) {
    if (err.code === 'ENOENT') return defaultIcp;
    throw err;
  }
}

export async function saveIcp(icp: Icp): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const toSave: Icp = { ...icp, updatedAt: new Date().toISOString() };
  await writeFile(ICP_PATH, JSON.stringify(toSave, null, 2), 'utf-8');
}
