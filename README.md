# IC(E)looP

See [iceloop-brief.md](./iceloop-brief.md) for the project brief.


## 1. Déclarer les custom tools dans la console

Dans l'onglet **Tools** de votre agent (la capture d'écran), ajoutez deux
`custom tool` avec ces schémas. Les custom tools ne sont pas exécutés par
Anthropic — c'est votre backend qui reçoit l'appel et renvoie le résultat,
ce qui correspond exactement au pattern "propose → valide" du system prompt.

```yaml
tools:
  - type: custom
    name: present_draft
    description: >
      Present a structured best-guess draft (a segment, hypothesis, persona,
      score, or signal) for the user to validate, edit, or reject. Use instead
      of describing a proposal in prose.
    input_schema:
      type: object
      properties:
        title:
          type: string
        items:
          type: array
          items:
            type: object
            properties:
              label: { type: string }
              value: { type: string }
            required: [label, value]
        note:
          type: string
      required: [title, items]

  - type: custom
    name: ask_choice
    description: >
      Ask the user to choose between 2-4 mutually exclusive options, only
      when there is no reasonable basis to draft a guess.
    input_schema:
      type: object
      properties:
        question: { type: string }
        options:
          type: array
          items: { type: string }
          minItems: 2
          maxItems: 4
      required: [question, options]
```

Ajoutez aussi cette clause à votre `system` prompt existant (elle remplace
la phrase "work like Claude's plan mode..." par une consigne d'usage
explicite des tools) :

```
When you need input from the user, use the present_draft tool to propose
your best-guess answer, or the ask_choice tool only when you have no
reasonable basis to draft a guess. Never describe a proposal or ask a
question in plain text.
```

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
AGENT_ID=agent_...        # l'id de votre ICP Discovery Agent (v3)
ENVIRONMENT_ID=env_...    # l'id créé à l'étape 2
PORT=3001
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
