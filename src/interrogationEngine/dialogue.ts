/* Interrogation engine — dialogue avec l'utilisateur (pas avec les leads) pour construire/affiner l'ICP.
   Pose des questions une à une jusqu'à avoir assez d'info, puis sauvegarde data/icp.json. */

import { createInterface } from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { loadIcp, saveIcp, type Icp } from '../config/icp.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const SAVE_ICP_TOOL: Anthropic.Tool = {
  name: 'save_icp',
  description: "Enregistre l'ICP une fois que tu as assez d'information de l'utilisateur pour le remplir entièrement.",
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: "Résumé en une phrase de l'ICP." },
      industries: { type: 'array', items: { type: 'string' } },
      companySizeRange: {
        type: 'object',
        properties: {
          minEmployees: { type: 'number' },
          maxEmployees: { type: 'number' },
        },
        required: ['minEmployees', 'maxEmployees'],
      },
      geographies: { type: 'array', items: { type: 'string' } },
      targetJobTitles: { type: 'array', items: { type: 'string' } },
      problemSignals: {
        type: 'array',
        items: { type: 'string' },
        description: 'Signes que l\'entreprise vit le problème adressé (pour Sillage: "people talking through the problem").',
      },
      triggerSignals: {
        type: 'array',
        items: { type: 'string' },
        description: "Signaux d'achat déclencheurs (levée de fonds, embauche, changement de poste...).",
      },
    },
    required: [
      'summary', 'industries', 'companySizeRange', 'geographies',
      'targetJobTitles', 'problemSignals', 'triggerSignals',
    ],
  },
};

function systemPrompt(currentIcp: Icp, extraContext?: string): string {
  return [
    "Tu es l'Interrogation engine d'IC-E-looP: ton rôle est de dialoguer avec l'utilisateur",
    "pour construire ou affiner sa définition d'ICP (Ideal Customer Profile) B2B.",
    'Pose une seule question à la fois, concrète et courte. Appuie-toi sur l\'ICP actuel ci-dessous',
    "pour identifier ce qui manque ou mérite d'être précisé, plutôt que de tout redemander.",
    "Quand tu as assez d'information sur tous les champs, appelle l'outil save_icp avec l'ICP complet.",
    '',
    'ICP actuel (JSON):',
    JSON.stringify(currentIcp, null, 2),
    extraContext ? `\nContexte supplémentaire à prendre en compte:\n${extraContext}` : '',
  ].join('\n');
}

/** Lance une session de dialogue. `extraContext` permet d'injecter par ex. des raisons d'échec (Refine ICP). */
export async function runInterrogation(extraContext?: string): Promise<Icp> {
  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  const currentIcp = await loadIcp();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: extraContext ? "Aide-moi à affiner mon ICP." : "Aide-moi à définir mon ICP." },
  ];

  try {
    while (true) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt(currentIcp, extraContext),
        tools: [SAVE_ICP_TOOL],
        messages,
      });

      const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (toolUse && toolUse.name === 'save_icp') {
        const icp: Icp = { ...currentIcp, ...(toolUse.input as object), updatedAt: new Date().toISOString() };
        await saveIcp(icp);
        console.log('\n✅ ICP enregistré dans data/icp.json\n');
        return icp;
      }

      const question = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
      if (question) console.log('\n' + question);

      messages.push({ role: 'assistant', content: response.content });
      const answer = await rl.question('> ');
      messages.push({ role: 'user', content: answer });
    }
  } finally {
    rl.close();
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runInterrogation().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
