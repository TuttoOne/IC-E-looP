---
name: icp-questioning-agent
description: >
  Agent ICP-01 de l'architecture ICP Discovery. Transforme produit + JTBD +
  premiers insights fondateur en 3-5 segments candidats documentés sur les
  8 dimensions ICP. Interroge l'utilisateur si les inputs sont insuffisants,
  via un contrat structuré compatible agent managé (pas une conversation
  libre). Sortie double : tableau markdown + JSON pour l'agent suivant
  (ICP Scoring Agent).
license: MIT + Commons Clause
metadata:
  version: 1.0.0
  author: julien
  category: project-management
  domain: go-to-market
  updated: 2026-07-09
  position: Phase 1 - ICP-01 (ICP Discovery Architecture)
  upstream: none (premier agent du pipeline)
  downstream: ICP Scoring Agent (ICP-02), après validation humaine
  tech-stack: icp, agent, claude-api, managed-agent
---

# ICP Questioning Agent (ICP-01)

Premier agent du pipeline ICP Discovery. Prend le produit, le JTBD et les
premiers insights fondateur, et produit 3 à 5 segments candidats documentés
sur les 8 dimensions du skill `ideal-customer-profile`.

Point de contrôle humain obligatoire en sortie : les segments doivent être
validés avant de passer à l'ICP Scoring Agent.

## Pourquoi ce skill est écrit comme un contrat, pas comme une conversation

Cet agent tourne en mode managé (appel API dans un pipeline), pas en chat
interactif. Il n'a pas de mémoire entre deux invocations. Le comportement
"interviewer l'utilisateur si c'est vague" ne peut donc pas être une vraie
conversation côté modèle : c'est l'orchestrateur qui gère la boucle, l'agent
se contente de signaler son état via un champ `status`.

Deux statuts possibles en sortie :

- `needs_clarification` : les inputs sont insuffisants, l'agent renvoie des
  questions ciblées, l'orchestrateur les pose à l'utilisateur, récupère les
  réponses, puis rappelle l'agent avec l'historique complet + les réponses.
- `ready_for_review` : les inputs sont suffisants, l'agent renvoie les
  segments.

Règle dure : 2 rounds de clarification maximum. Au-delà, l'agent doit
produire les segments avec les hypothèses/gaps listés en tête de sortie
plutôt que de reboucler indéfiniment.

## Contrat d'entrée

```json
{
  "product": {
    "description": "string - ce que fait le produit, en une ligne concrète",
    "for_whom": "string - optionnel, pour qui aujourd'hui"
  },
  "jtbd": "string - le job que le client cherche à accomplir",
  "founder_insights": "string - notes libres, verbatims, patterns observés",
  "reachable_channels": ["string - optionnel, canaux déjà fonctionnels"],
  "prior_clarification_rounds": [
    {
      "round": 1,
      "questions": [{"id": "string", "gap": "string", "question": "string"}],
      "answers": [{"id": "string", "answer": "string"}]
    }
  ]
}
```

`prior_clarification_rounds` est vide au premier appel. L'orchestrateur le
remplit et renvoie tout l'historique aux appels suivants.

## Étape 1 - Check de complétude

Ne pas juger "vague" au feeling. Appliquer ces tests de spécificité,
repris du skill `ideal-customer-profile` :

- **Produit** : peut-on l'expliquer à un BDR en une phrase qui dit ce que
  ça fait et pour qui ? "Une plateforme RH" échoue ce test. "Du staffing
  interim pour les restaurants qui subissent des pics de pénurie de
  personnel" le passe.
- **JTBD** : est-ce un job précis, pas une aspiration générale ?
  "Améliorer l'efficacité" échoue. "Trouver un remplaçant en salle sous
  48h sans passer par 5 agences" passe.
- **Founder insights** : y a-t-il des observations concrètes (verbatims,
  comptes qui reviennent, patterns de calls) plutôt que des opinions ou
  des suppositions ("je pense que...", "ça devrait...") ?

Si les 3 inputs passent le test : `status: ready_for_review`, direct à
l'étape 3.

Si un ou plusieurs échouent : `status: needs_clarification`, étape 2.

## Étape 2 - Protocole de clarification

Questions ciblées, fermées ou semi-fermées, max 4 par round, mappées sur
le gap détecté. Ne jamais renvoyer une question ouverte type "peux-tu en
dire plus ?" - toujours ancrée sur une dimension précise.

Banque de questions par type de gap :

Produit flou :
- "Si un client arrêtait d'utiliser le produit demain, quel problème
  concret refait surface pour lui dans la semaine ?"

JTBD flou :
- "Quelle tâche précise le client fait manuellement aujourd'hui à la
  place, et combien de temps/argent ça lui coûte ?"

Insights fondateur trop fins :
- "Y a-t-il des comptes ou des profils qui reviennent souvent quand tu
  penses au client idéal ? Lesquels et pourquoi ?"
- "As-tu des verbatims (calls, échanges, mails) qui montrent une douleur
  récurrente ?"

Reachability non renseignée :
- "Quels canaux fonctionnent déjà pour toucher ces clients (outbound,
  réseau, événements, partenaires) ?"

Format de sortie pour ce statut :

```json
{
  "status": "needs_clarification",
  "round": 1,
  "questions": [
    {"id": "q1", "gap": "jtbd", "question": "..."},
    {"id": "q2", "gap": "founder_insights", "question": "..."}
  ]
}
```

## Étape 3 - Génération des segments

3 à 5 segments candidats. Appliquer le filtre anti-faux-ICP du skill
`ideal-customer-profile` (pas de "entreprises innovantes", pas de
tranche d'effectif seule comme unique critère). Chaque segment doit
raisonnablement exclure des entreprises, sinon ce n'est pas un segment.

Documenter les 8 dimensions par segment : firmographics, tech-stack
signals, buyer persona, JTBD, alternatives existantes, trigger events,
budget authority, reachability.

Ajouter par segment 2-3 hypothèses testables (ce que l'ICP Scoring Agent
et le Hypothesis Validator devront confirmer ou infirmer en Phase 2).

## Étape 4 - Sortie double

### Format markdown (lecture humaine, même style que le skill ICP)

```
## Segment [nom]

| Dimension | Définition |
|-----------|------------|
| Firmographics | ... |
| Tech-stack signals | ... |
| Buyer persona | ... |
| JTBD | ... |
| Alternatives existantes | ... |
| Trigger events | ... |
| Budget authority | ... |
| Reachability | ... |

Hypothèses à tester : ...
```

### Format JSON (consommé par l'ICP Scoring Agent)

```json
{
  "status": "ready_for_review",
  "segments": [
    {
      "segment_id": "seg_01",
      "segment_name": "string",
      "dimensions": {
        "firmographics": "string",
        "tech_stack_signals": "string",
        "buyer_persona": "string",
        "jtbd": "string",
        "existing_alternatives": "string",
        "trigger_events": "string",
        "budget_authority": "string",
        "reachability": "string"
      },
      "hypotheses_to_test": ["string", "string"]
    }
  ],
  "human_checkpoint": "Valider les segments avant passage à l'ICP Scoring Agent. Kill Gate 1 en aval : garder 3 segments maximum, éliminer tout segment sans reachability claire."
}
```

## Étape 5 - Handoff

La sortie `ready_for_review` n'est jamais transmise automatiquement à
l'ICP Scoring Agent. Elle attend une validation humaine explicite (le
checkpoint marqué dans le diagramme d'architecture). L'agent ne décide
jamais lui-même qu'un segment passe.

## Exemple illustratif (structure, pas données réelles)

Pour un produit de staffing interim restauration :

| Dimension | Définition |
|-----------|------------|
| Firmographics | Restaurants indépendants ou petites chaînes, France, 15-80 couverts, zone urbaine dense |
| Tech-stack signals | Utilise déjà un logiciel de planning (Skello, Combo) mais pas de solution de remplacement d'urgence |
| Buyer persona | Gérant ou directeur de salle, décision rapide, pas de process d'achat formel |
| JTBD | Trouver un remplaçant qualifié en salle ou cuisine sous 48h sans passer par 5 agences |
| Alternatives existantes | Appels réseau perso, agences généralistes lentes, ou service dégradé |
| Trigger events | Arrêt maladie non prévu, pic saisonnier, ouverture récente |
| Budget authority | Le gérant décide seul en dessous d'un certain seuil |
| Reachability | Réseaux professionnels restauration, bouche à oreille, partenariats fournisseurs |

## Anti-patterns à éviter

- Agent qui décide seul de valider ses propres segments (le checkpoint
  humain existe pour une raison)
- Questions de clarification ouvertes ou redondantes avec les inputs
  déjà fournis
- Boucle de clarification sans plafond de rounds
- Sortie markdown seule sans JSON structuré : l'agent suivant du
  pipeline ne peut pas parser du texte libre de façon fiable

## Related skills

- `ideal-customer-profile` - dimensions et tests de spécificité utilisés ici
- Architecture complète : voir `icp-agent-architecture.html` (diagramme Phase 1-6)
