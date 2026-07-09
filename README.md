# IC(E)looP

See [iceloop-brief.md](./iceloop-brief.md) for the project brief.


## 1. Config des agents (versionnée dans le repo)

Les configs de référence des agents (system prompt + custom tools) vivent dans
[`Agents/1 - Questionning Agent/agent.json`](./Agents/1%20-%20Questionning%20Agent/agent.json)
et [`Agents/2 - Scoring Agent/agent.json`](./Agents/2%20-%20Scoring%20Agent/agent.json).
Plus de copier-coller dans la console : modifiez le fichier, puis poussez-le
vers l'API Managed Agents (chaque push crée une nouvelle version de l'agent ;
les nouvelles sessions la prennent automatiquement) :

```bash
npm run push-agent                   # agent Questioning
node scripts/push-agent.mjs scoring  # agent Scoring
```

Le pattern d'interaction : l'agent pose de vraies questions à réponses
cliquables (concis, une question à la fois), et ne propose des drafts à
valider que pour les segments finaux. Les custom tools ne sont pas exécutés
par Anthropic — c'est votre backend qui reçoit l'appel et renvoie le
résultat :

- `ask_choice` — l'outil par défaut pour toute question : UNE question à la
  fois, 2-4 options courtes et concrètes, rendues en boutons cliquables par
  le front (+ un bouton « Autre… » pour une réponse libre). Le Scoring Agent
  l'utilise aussi, avant de scorer, pour résoudre les critères trop flous
  (max 4 questions, « Je ne sais pas encore » toujours proposé → le critère
  reste `unscoreable` et part en knowledge gap).
- `present_draft` — réservé aux cartes segment finales (Valider / Modifier /
  Rejeter), le checkpoint humain avant le handoff au scoring.
- `submit_segments` — handoff des segments validés vers le Scoring Agent.

## 2. Créer un environnement (une fois)

```bash
ant beta:environments create \
  --name "icp-agent-env" \
  --config '{type: cloud, networking: {type: unrestricted}}'
```

Notez l'`environment.id` retourné.

## 3. Configurer les variables d'environnement

Créez un fichier `.env` à la racine :

```
ANTHROPIC_API_KEY=sk-ant-...
AGENT_ID=agent_...          # l'id de votre ICP Questioning Agent
SCORING_AGENT_ID=agent_...  # l'id de votre ICP Scoring Agent
ENVIRONMENT_ID=env_...      # l'id créé à l'étape 2
PORT=3010
```

## 4. Lancer

```bash
npm install
npm start
```

Ouvrez `http://localhost:3001` — le front sert la page statique et parle au
backend, qui lui-même parle à l'API Managed Agents. La clé API ne quitte
jamais le serveur.

## Ce qui n'est pas géré ici (à ajouter selon vos besoins)

- **Résilience réseau** : reconnexion automatique de l'EventSource, retry
  sur échec d'envoi d'événement.
- **Multi-utilisateurs** : ce prototype garde une session en mémoire par
  process ; en prod, persistez `sessionId` côté utilisateur (cookie / auth)
  et gérez plusieurs sessions concurrentes.
- **Sillage.ai (étape 4 du system prompt)** : à connecter comme
  `mcp_toolset` ou `custom tool` séparé dans la config de l'agent.
- **Webhooks** : plutôt que de garder une connexion SSE ouverte en
  permanence, vous pouvez vous abonner à `session.requires_action` en
  webhook pour ne réveiller votre backend que lorsque l'agent attend
  une réponse.
