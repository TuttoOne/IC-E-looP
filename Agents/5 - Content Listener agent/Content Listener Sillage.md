---
name: content-listener-sillage
description: >
  Déploie et exécute les agents de détection Sillage à partir de la table de handoff produite par
  persona-builder-sillage (critère ICP → type d'agent → keywords) : crée les agents avec la
  discipline de quoting des keywords, peuple les watchlists, lance les signal runs, polle jusqu'à
  complétion, lit le feed de détections et livre les signaux normalisés par compte — l'entrée
  directe du Signal Aggregator. Utiliser ce skill dès que l'utilisateur mentionne : "Content
  Listener", "créer les agents Sillage", "lancer la détection de signaux", "signal run",
  "keyword detection", "écouter les posts / les offres d'emploi", "SIG-02", ou veut activer la
  surveillance des comptes cibles — même sans dire "listener". Prérequis : persona configuré ET
  comptes ingérés (persona-builder-sillage), idéalement mapping fait (stakeholder-mapper-sillage)
  pour que l'agent job_update ait des contacts à suivre.
metadata:
  version: 1.1.0
  phase: SIG-02 (Phase 2 — Signal Detection)
  pairs-with: [persona-builder-sillage, stakeholder-mapper-sillage]
  upstream: table de handoff du persona-builder (signaux → agents ; le poids dérivé d'urgency y est repris comme contexte, pas comme valeur finale, voir Annexe 2 "Autorité sur le poids")
  downstream: Signal Aggregator (SIG-03), champs CRM rosk_signal_type / rosk_signal_date / rosk_signal_source
  changelog: >
    v1.1.0 - clarifie l'autorité sur le poids : la table de traduction de l'Annexe 2 (fixe,
    par type de détection) prime toujours sur le poids dérivé d'urgency reçu du
    persona-builder, qui n'est plus conservé qu'à titre indicatif (colonne "Urgency segment"
    dans le feed de sortie). Corrige une ambiguïté où les deux skills pouvaient produire un
    poids différent pour le même signal sans règle de préséance explicite.
---

# Content Listener — activer les oreilles du pipeline

La table de handoff du Persona Builder dit quoi écouter ; ce skill le met en marche sans casser
le workspace et sans noyer l'aval dans le bruit. Deux vérités structurent tout : (1) les huit
types d'agents Sillage sont une **liste fermée** — ne jamais en inventer ni en promettre un
neuvième ; (2) la qualité des keywords détermine tout — un agent mal quoté produit du bruit que
le Signal Aggregator scorera consciencieusement, et l'ICP entier semblera faux alors que c'est
l'écoute qui l'était.

## Prérequis (vérifier, pas supposer)

1. `get_setup_state` : `persona_set` ET `ingestion_complete` doivent être vrais — sinon STOP,
   rediriger vers `persona-builder-sillage`
2. Table de handoff disponible (critère ICP → type d'agent → keywords proposés → poids).
   Si absente, la reconstruire depuis le doc ICP avec le mapping de
   `references/taxonomie-et-handoff.md`. Le poids qui arrive dans cette table (dérivé de
   l'urgency du segment côté Persona Builder) est du **contexte**, pas une valeur à
   retranscrire telle quelle : voir "Autorité sur le poids" dans l'Annexe 2, ce skill
   recalcule toujours le poids final depuis sa propre taxonomie
3. Pour un agent `job_update` : des contacts mappés doivent exister (sinon il ne suit
   personne) — vérifier `list_company_mappings`, sinon rediriger vers
   `stakeholder-mapper-sillage` d'abord
4. Lire `references/agents-et-runs-api.md` avant tout appel d'écriture

## Workflow en 6 étapes

### Étape 1 — Prioriser (moins d'agents = plus de signal)

Ne PAS créer les 6 lignes de la table d'un coup. Règle : démarrer avec les agents des critères
**High** + un seul agent watchlist si l'ICP en prévoit. Les Medium/Low s'ajoutent quand les
premières détections reviennent et que l'utilisateur fait confiance à la sortie. Plus d'agents
n'est pas mieux ; la qualité du signal l'est.

Vérifier aussi `get_agents` : si un agent équivalent existe déjà (même type, keywords
recouvrants), proposer de le reconfigurer (`configure_agent`) — JAMAIS delete + recreate
(nouveau id, watchlist orpheline).

### Étape 2 — Affiner les keywords avec la discipline de quoting

Pour chaque agent keyword, passer les keywords proposés au crible :

- **Terme générique** ("ouverture", "serveur", "expansion") → **le quoter** : `"\"ouverture de restaurant\""` —
  sinon il matche partout et noie le feed
- **Terme niche** (rare, spécifique au domaine) → le laisser **bare** pour le recall
- `job_posting_keyword_detection` : les keywords sont les **rôles/stacks recrutés** ("cuisinier",
  "chef de partie"), PAS le langage de la douleur — c'est l'erreur la plus courante
- Couvrir les langues des géos cibles (un ICP parisien poste en français : "recrute",
  "on embauche", pas seulement "hiring")

⚡ **Checkpoint humain** : présenter le set final par agent (quoté vs bare, avec la raison),
laisser couper. Ne jamais créer un agent avec des keywords non validés.

### Étape 3 — Créer les agents (et peupler les watchlists)

Pour chaque agent validé :

1. `create_agent` avec `name` explicite (convention : `<critère ICP> — <type>`, ex.
   "Embauches récurrentes — job postings"), `type`, et `tracking_keywords` si type keyword.
   Optionnel : `start_date` (ISO) pour ignorer l'historique, `max_posts_to_scrape` pour
   contenir les coûts
2. Vérifier le retour : `id` présent et `enabled: true`
3. Agents watchlist (`competitor` etc.) : la watchlist est auto-créée et liée. La peupler avec
   `add_watchlist_entities` — **URL LinkedIn de préférence** (les domaines ambigus bouncent :
   cas réels meandu.com, zonal.co.uk). ≤100 entités par appel, idempotent. L'agent ne découvre
   PAS la liste lui-même : il surveille ce qu'on lui donne, rien de plus
4. `job_update` : name + type seulement, aucun paramètre — il opère sur les contacts mappés
   du workspace

### Étape 4 — Lancer les runs

1. `launch_signal_run` par agent : `{ agent_id, lookback_days: N }` — `lookback_days` est un
   **entier top-level** (1–180, défaut 90), jamais une string, jamais imbriqué
2. Le retour contient `runs[]` : 1 run pour keyword/job, **2 pour les watchlist** (inbound +
   outbound) — conserver chaque `signal_request_id`
3. **Piège du premier run** : un run lancé juste après `create_agent` peut être rejeté pendant
   que les keywords s'indexent — attendre un court moment et relancer, ce n'est pas une erreur
   de config

### Étape 5 — Poller et lire les résultats

1. `get_signal_run` par `signal_request_id` jusqu'au stage terminal : `completed`,
   `completed_partial` ou `failed`. Poll poli avec backoff
2. `completed_partial` = des comptes n'ont pas été scannés — les ids sont dans
   `metadata.failed.dropped_account_ids` → relancer pour les couvrir, ne pas ignorer
3. Lire les détections dans `list_signals` (le feed) — **c'est lui la vérité**, pas les
   compteurs du run. Pas de paramètres de filtre : paginer et filtrer côté client
4. `get_contents` (filtré par `company_domain`) uniquement pour le matériau brut derrière
   une détection (le texte du post, l'offre d'emploi) — jamais non filtré, c'est un superset
   du workspace entier

### Étape 6 — Livrer le feed normalisé (contrat avec le Signal Aggregator)

Traduire chaque détection en signal métier avec le mapping de
`references/taxonomie-et-handoff.md`, agrégé par compte :

```
## Signaux détectés — <période>

| Compte | Critère ICP | Type détection | Date | Source (détail brut) | Poids |
|---|---|---|---|---|---|

## Comptes silencieux
<liste — avec le rappel : silence ≠ désintérêt. Vérifier que c'est de la vraie inactivité
et non un trou de couverture qu'un enrich_company comblerait>

## Réglages recommandés après ce run
<keywords trop bruyants à quoter, keywords morts à retirer, agents Medium/Low à activer>
```

Les colonnes alimentent directement les champs CRM : Critère ICP → `rosk_signal_type`,
Date → `rosk_signal_date`, Source → `rosk_signal_source`. Le Poids (High ×3 / Medium ×2 /
Low ×1) est fourni pour le Signal Aggregator — ce skill ne SCORE pas, il détecte et normalise.
Ce poids vient toujours de la table de traduction de l'Annexe 2 (fixe, par type de détection),
jamais du poids dérivé d'urgency reçu dans la table de handoff amont — voir "Autorité sur le
poids" dans l'Annexe 2 pour la règle de préséance.

## Règles d'or

1. **Huit types d'agents, liste fermée** — jamais en inventer, jamais promettre un signal que
   Sillage n'émet pas
2. **Jamais de keywords non validés par l'humain** dans un `create_agent`
3. **`configure_agent`, jamais delete + recreate** — et tout changement de keywords envoie la
   liste COMPLÈTE (c'est un remplacement, pas un ajout)
4. **Ne jamais prédire un rendement** ("4 000 posts donc ~20 détections") — le yield dépend
   des interactions réelles, pas du volume de corpus
5. **Ne jamais regex-miner le corpus** pour découvrir partenaires/tech stack — les posts de
   pages entreprise arrivent souvent vides, la donnée n'est pas faite pour ça
6. **`list_signals` est la vérité**, pas les compteurs de run
7. Démarrer petit (High d'abord), régler, puis élargir
8. **La taxonomie de l'Annexe 2 est seule autorité sur le poids** — le poids dérivé
   d'urgency reçu du Persona Builder n'est jamais recopié tel quel dans le feed final,
   voir "Autorité sur le poids" en Annexe 2

## Ce que ce skill ne fait PAS

- Définir le persona ou la table de handoff → `persona-builder-sillage`
- Construire la couverture personnes → `stakeholder-mapper-sillage`
- Scorer/cumuler les signaux et appliquer les disqualifiants → Signal Aggregator (SIG-03)
- Enrichir ou pousser dans le CRM → phases ENR / OUT


---

# ANNEXE 1 — references/agents-et-runs-api.md

Source : `tool-map.md` + `write-semantics.md` + `expansion-playbook.md` du repo officiel
sillage-labs/skills. Tout ce qui suit est vérifié contre le MCP v2.

## Les 8 types d'agents — liste FERMÉE

`keyword_detection`, `job_posting_keyword_detection`, `job_update`, `competitor`, `partner`,
`customer`, `influencer`, `champion`. C'est tout. Pas d'agent "employee engagement", pas
d'agent auto-dérivé. Si un besoin ne rentre pas, le dire clairement plutôt qu'inventer.

| Type | Surveille | Paramètres à la création |
|---|---|---|
| `keyword_detection` | Posts LinkedIn matchant les keywords | `tracking_keywords` (requis), `max_posts_to_scrape?`, `start_date?` (ISO, ignore l'antérieur) |
| `job_posting_keyword_detection` | Les offres d'emploi publiées par les entreprises suivies (titre + description) | Idem — keywords = rôles/stacks recrutés, PAS le langage de la douleur |
| `job_update` | Changements de poste / promotions des contacts MAPPÉS du workspace | Aucun — `name` + `type` seulement |
| `competitor` / `partner` / `customer` | Interactions avec les entreprises de la watchlist | Watchlist auto-créée et liée, sauf `watchlist_id?` passé (type doit correspondre) |
| `influencer` / `champion` | Interactions avec les profils de la watchlist | Idem (watchlist de profils) |

## Discipline de quoting des keywords (contrôle du bruit)

- Keyword **bare** → match large : haut recall, plus de bruit. Pour les termes niche, rares
  dans le flux général
- Keyword **"quoté"** → match de la phrase exacte : haute précision, moins de bruit. Pour les
  termes génériques qui matcheraient partout
- Exemples : `deliverability` (bare, assez rare) vs `"sales team"` (quoté, sinon omniprésent).
  En contexte restauration : `"chef de partie"` (quoté, expression exacte) vs `plongeur` (à
  quoter aussi — le mot a d'autres sens !)
- Toujours dire à l'utilisateur ce qui est quoté et pourquoi, et régler après le premier run

Proposer 8–12 candidats par agent, issus de 4 veines : langage de la douleur, catégorie +
noms de concurrents, phrases de déclenchement ("on recrute", "nouvelle adresse"), verbes du
job-to-be-done. Laisser l'utilisateur couper — c'est là que sa connaissance métier travaille.

## Outils

| Outil | Classe | Params clés | Notes |
|---|---|---|---|
| `create_agent` | CREATE | `name`, `type`, `tracking_keywords?`, `watchlist_id?` | Créé `enabled: true`. Vérifier `id` au retour |
| `get_agents` | READ | `agent_id?`, `response_format?` | `concise` (défaut) OMET `parameters` — demander `detailed` pour voir les keywords. Peut retourner `type: "unconfigured"` |
| `configure_agent` | PUT | `agent_id`, `tracking_keywords?`, `start_date?`, `enabled?`, `name?` | Pause = `enabled:false`. ⚠️ Changer les keywords REMPLACE la liste — envoyer la liste complète |
| `bind_agent_watchlist` | PUT | `agent_id`, `watchlist_id` | Les deux à null = délier |
| `delete_agent` | DESTRUCTIVE | `agent_id` | À éviter — voir règle delete/recreate ci-dessous |
| `add_watchlist_entities` | APPEND | `kind`, `watchlist_id`, `entities[]` | ≤100/appel, idempotent sur (liste, entité). URL LinkedIn de préférence ; `domain` accepté SEULEMENT sur les listes company (422 sur profils) |
| `launch_signal_run` | TRIGGER | `agent_id`, `lookback_days?` | Voir section runs |
| `get_signal_run` | READ | `signal_request_id` | Stage `running` → `completed` / `completed_partial` / `failed` |
| `list_signals` | READ | `page?`, `page_size?` | Le feed de détections. AUCUN filtre — paginer, filtrer côté client |
| `get_contents` | READ | `company_domain?[]`, `company_id?`, `person_id?`, `date_from?`, `date_to?`, `response_format?` | Le corpus brut. `normalized` par défaut. NON filtré = superset du workspace entier, pas les comptes cibles |

## Signal runs — le contrat exact

```
launch_signal_run({ agent_id: 42, lookback_days: 90 })
  → runs[]  # keyword/job → 1 run ; watchlist → 2 (inbound + outbound)
  → poller get_signal_run(signal_request_id) par run
  → terminal : completed | completed_partial | failed
  → lire list_signals (LA vérité), pas les compteurs du run
```

- `lookback_days` : **entier top-level**, 1–180, défaut 90. `90` et pas `"90"` (les strings
  sont rejetées). Seul l'endpoint REST le niche dans `parameters` — pas le MCP
- **Premier run d'un agent frais** : peut être rejeté pendant l'indexation des keywords —
  attendre un court moment et relancer. Ce n'est PAS une erreur de configuration
- `completed_partial` : des comptes ont été sautés — ids dans
  `metadata.failed.dropped_account_ids` → relancer pour les couvrir

## Jamais de delete + recreate

Recréer un agent mint un nouvel id ; pour les types watchlist, une NOUVELLE watchlist est
auto-créée, orphelinant celle qu'on avait peuplée (churn réel observé : agent 1416 → 2191,
watchlist 17 → 18 → 19). Pour changer keywords, nom ou état : `configure_agent`. Si
l'utilisateur demande de "tout supprimer et refaire", proposer l'édition en place.

## Erreurs

| Erreur | Réaction |
|---|---|
| `Invalid input...` | Corps invalide — vérifier noms/types/enums (lookback en int !), corriger, retenter |
| Run rejeté juste après création | Keywords en cours d'indexation — attendre, relancer |
| `403` | Feature non activée — remonter, NE PAS retenter |
| `422` sur add_watchlist_entities | Domaine envoyé à une liste de profils, ou toutes les entités ont échoué — passer aux URLs LinkedIn |
| `429` | Back-off, respecter `retry_after` |


---

# ANNEXE 2 — references/taxonomie-et-handoff.md

Comment traduire ce que Sillage détecte (vocabulaire technique) en signaux métier de l'ICP
(vocabulaire du Signal Aggregator et du CRM). C'est la couche de traduction — sans elle, le
feed brut est illisible pour l'aval.

## Les types de détection (couche événements)

**Keyword**
- `keywordDetection` — un post LinkedIn a matché un keyword d'un agent
- `jobPostingKeywordDetection` — une offre d'emploi d'une entreprise suivie a matché (titre
  ou description)

**Mouvements de carrière** (agent `job_update`, sur les contacts mappés)
- `newJob` — nouvelle prise de poste
- `recentlyPromoted` — promotion

**Engagement watchlist** (chaque type a une forme inbound et outbound)
- `competitorInboundComment` / `competitorOutboundComment` (idem partner, customer,
  influencer, champion)
- `leadLikedCompetitorContent` / `leadCommentedCompetitorContent`
- `leadLikedInfluencerContent` / `leadCommentedInfluencerContent`

**Engagement brut** : `linkedinComment`, `linkedinReaction`

En pratique, le keyword agent est le cheval de trait ; les autres dépendent du type d'agent
correspondant activé et lancé.

## Table de traduction — détection → critère ICP (exemple Rosk)

| Détection Sillage | Critère ICP | Poids | Champ CRM `rosk_signal_type` |
|---|---|---|---|
| `jobPostingKeywordDetection` — même rôle re-détecté sur plusieurs semaines | Embauches récurrentes | High | Recurring hiring |
| `keywordDetection` — keywords d'ouverture ("nouvelle adresse", "ouverture") | Ouverture de site | High | New site |
| `jobPostingKeywordDetection` — keywords saisonniers ("extra", "saisonnier", "renfort terrasse") | Burst saisonnier | Medium | Seasonal burst |
| `newJob` / `recentlyPromoted` sur un contact RH/Ops mappé | Changement de direction | Medium | Leadership change |
| `leadLikedCompetitorContent` / `leadCommentedCompetitorContent` / `competitorInboundComment` | Engagement concurrent | Medium | Competitor engagement |
| `keywordDetection` — keywords levée/expansion | Levée / expansion | Low | Funding/expansion news |

**Nuance importante sur "Embauches récurrentes"** : Sillage émet des détections unitaires — la
*récurrence* est une interprétation à construire. Règle : 2+ `jobPostingKeywordDetection` sur
le même rôle et le même compte à 2+ semaines d'écart = récurrent (High). Une détection isolée
reste un signal d'embauche simple, à classer avec le poids du burst saisonnier si le contexte
matche, sinon à laisser en signal faible. Documenter le choix dans la colonne Source.

## Autorité sur le poids (Content Listener vs Persona Builder)

Le Persona Builder produit, en amont, un poids dérivé du score `urgency` du segment
(urgency 4-5 → High, 2-3 → Medium, 0-1 → Low), appliqué de façon uniforme à tous les
signaux du segment. Ce skill produit, lui, un poids par type de détection, fixe, indépendant
du segment (table ci-dessus). Les deux ne se recouvrent pas forcément — un segment à
urgency=4 peut très bien contenir un signal "Burst saisonnier", que la table ci-dessus fixe
à Medium quel que soit le segment.

Règle de préséance, pour lever l'ambiguïté une fois pour toutes : **la table de traduction
ci-dessus fait foi**. Le poids dérivé d'urgency reçu dans la table de handoff du Persona
Builder n'est jamais copié tel quel dans le feed livré au Signal Aggregator ; il est conservé
uniquement comme contexte, sous la forme d'une colonne `Urgency segment (indicatif)` dans le
feed final (voir Contrat de sortie ci-dessous), pour que le Signal Aggregator puisse repérer
les cas où les deux divergent fortement (ex. segment à urgency=5 mais détection typée Low)
sans que ça influence le poids appliqué.

Un type de détection absent de la table de traduction (cas rare, ou nouveau critère ICP pas
encore documenté) est le seul cas où le poids dérivé d'urgency du Persona Builder sert de
repli — marquer alors le poids `à confirmer par Signal Aggregator` plutôt que de trancher
soi-même, et signaler l'écart pour mise à jour de la table de traduction.

## Contrat de sortie (l'entrée du Signal Aggregator)

Une ligne par (compte × détection), agrégée et triée par compte :

```
| Compte (domaine) | Critère ICP | Type détection | Date | Source | Poids | Urgency segment (indicatif) |
|---|---|---|---|---|---|---|
| brasserie-x.fr | Recurring hiring | jobPostingKeywordDetection | 2026-07-02 | "Cuisinier H/F posté 3× en 6 semaines (sites Bastille, Opéra, Défense)" | High | High |
```

- **Date** → `rosk_signal_date` (mesure la vitesse de réaction — champ du roadmap HubSpot)
- **Source** → `rosk_signal_source` : le détail brut, formulé pour être lisible dans le deal
  summary ("Kitchen role posted 3x in 6 weeks" est le format attendu)
- **Poids** : transmis, PAS appliqué — le scoring (cumul, ×3/×2/×1, disqualifiants, tiers)
  appartient au Signal Aggregator. Toujours issu de la table de traduction ci-dessus, jamais
  de l'urgency du segment (voir "Autorité sur le poids")
- **Urgency segment (indicatif)** : le poids dérivé d'urgency reçu du Persona Builder pour ce
  segment, reporté tel quel à titre de contexte. N'influence jamais le Poids. Sert au Signal
  Aggregator pour repérer les cas où le segment et le type de détection divergent

## Ce que le feed ne dit PAS (à rappeler dans la synthèse)

1. **Les disqualifiants ICP ne sont pas des détections Sillage.** Conflit social ouvert,
   contrat concurrent récent : aucun agent ne les émet. Ils relèvent d'une vérification
   séparée (recherche web / connaissance BD) que le Signal Aggregator devra déclencher avant
   de router un compte en outreach
2. **Silence ≠ désintérêt.** Une grande part de toute liste cible est inactive sur LinkedIn ;
   une poignée de comptes produit la majorité des détections. Avant de conclure au silence,
   vérifier que ce n'est pas un trou de couverture (`enrich_company` non fait) — voir
   sillage-manage-workspace "Troubleshoot — few or zero signals"
3. **Jamais de rendement prédit.** Le volume de corpus ne prédit pas le nombre de détections.
   Ne pas promettre de chiffres

## Exemple travaillé — premier run Rosk

Agents créés (priorité High seulement, conformément à l'Étape 1) :

1. "Embauches récurrentes — job postings" (`job_posting_keyword_detection`) —
   keywords : `"cuisinier"`, `"chef de partie"`, `"commis de cuisine"`, `"serveur"`,
   `"plongeur"`, `"barman"`, `"réceptionniste"` (tous quotés : termes génériques en français,
   et "plongeur" est polysémique)
2. "Ouverture de site — posts" (`keyword_detection`) — keywords : `"nouvelle adresse"`,
   `"ouverture prochaine"`, `"nouveau restaurant"`, `ouvre ses portes` (bare : tournure assez
   spécifique), `"opening soon"`
3. Watchlist unique : "Concurrents staffing" (`competitor`) — entités par URL LinkedIn :
   Brigad, Extracadabra, Side (validées avec l'humain avant ajout)

Lancement : `lookback_days: 60` (les signaux de staffing vieillissent vite — 90 par défaut
dilue). Watchlist → 2 runs à poller, keyword → 1 chacun, soit 4 signal_request_id au total.

Sortie type après lecture de `list_signals` (segment "Restaurant groups 5+ sites, Paris
region", urgency=4 côté ICP-02, donc "High" reçu du Persona Builder pour tout le segment) :

| Compte | Critère ICP | Détection | Date | Source | Poids | Urgency segment (indicatif) |
|---|---|---|---|---|---|---|
| groupe-gastroparis-exemple.fr | Recurring hiring | jobPostingKeywordDetection ×3 | 2026-06-12 → 2026-07-01 | "Chef de partie posté 3× / 3 sites en 3 semaines" | High | High |
| bistrot-y.fr | New site | keywordDetection | 2026-06-28 | "Post : 'ouverture prochaine de notre 4e adresse, Paris 11e'" | High | High |
| brasserie-z.fr | Competitor engagement | leadCommentedCompetitorContent | 2026-07-03 | "Le DG a commenté un post Brigad sur la pénurie en salle" | Medium | High |

Le dernier cas illustre exactement la divergence : le segment est à urgency=4 (High), mais
"Competitor engagement" reste Medium dans la table de traduction, donc le Poids final livré
au Signal Aggregator est Medium, pas High. C'est la règle de préséance en action, pas une
incohérence.

Réglages recommandés après ce run : `"serveur"` trop bruyant même quoté (posts de célébration
de staff) → restreindre à `"serveur H/F"` / `"recrute serveur"` ; activer l'agent saisonnier
(Medium) car 2 comptes mentionnent la terrasse ; `job_update` en attente du mapping complet
des contacts.
