---
name: contact-enricher-fullenrich
description: >
  Enrichit, via FullEnrich (waterfall multi-fournisseurs), les 1 à 3 contacts qu'un compte
  READY_FOR_ENRICHMENT a fait remonter — email vérifié + téléphone + score de confiance — puis
  prépare le dossier prospect prêt pour le Deliver (CRM Pusher). Seul agent du pipeline qui
  consomme des crédits payants : chaque lancement passe par un checkpoint de coût explicite. Il
  n'enrichit JAMAIS un compte entier ni un contact hors de la liste recommandée par le Signal
  Aggregator, et ne re-décide jamais la porte d'enrichissement (2+ signaux + gap reachability
  fermé) — il la vérifie et refuse si elle n'est pas tenue. Utiliser ce skill dès que
  l'utilisateur mentionne : "Contact Enricher", "enrichir les contacts", "FullEnrich", "trouver
  l'email vérifié", "waterfall email/téléphone", "ENR-01", "Phase 3 Enrichment", "passer les
  survivants en enrichissement", ou toute demande de récupérer des coordonnées vérifiées sur des
  décideurs déjà qualifiés. Prérequis : le Signal Aggregator a rendu un dossier
  READY_FOR_ENRICHMENT et le Stakeholder Mapper a fourni les profils recommandés (nom, titre,
  linkedin_url, decision_role) — sinon, rien à enrichir.
metadata:
  version: 1.0.0
  phase: ENR-01 (Phase 3 - Enrichment)
  pairs-with: [signal-aggregator-sillage, stakeholder-mapper-sillage]
  upstream: signal-aggregator-sillage (dossier READY_FOR_ENRICHMENT + contacts recommandés + porte d'enrichissement déjà tranchée), stakeholder-mapper-sillage (profils : name, title, linkedin_url, decision_role, persona_match, level, domaine du compte)
  downstream: CRM Pusher (Deliver — CRM tsplus-outreach via l'adaptateur REST POST /api/prospects, PAS HubSpot ; champs email, first_name, last_name, title, company, linkedin_url, source_list, status, notes) ; Hypothesis Validator / Learn (retour des contacts non-joignables comme évidence, jamais comme inférence)
  changelog: >
    v1.0.0 - première spec de l'agent d'enrichissement. Trois partis pris explicites après
    lecture des specs amont (Signal Aggregator, Stakeholder Mapper, ICP Scoring Agent) :
    (1) la porte d'enrichissement (2+ signaux de catégories différentes ET gap reachability non
    `open`) est actée en amont — ce skill la RE-VÉRIFIE comme garde-fou avant de dépenser un
    crédit, mais ne l'invente ni ne la relâche jamais sur la seule base d'un score ;
    (2) le périmètre d'enrichissement est exactement la liste "Contacts recommandés pour
    FullEnrich" (1-3 par compte, DM niveau groupe en priorité) — jamais tout le compte, jamais
    un contact ajouté ici ; (3) la cible de livraison est le CRM tsplus-outreach via l'adaptateur
    REST, pas HubSpot — les anciennes specs (Stakeholder Mapper, Signal Aggregator) nomment
    encore "CRM Pusher (HubSpot)", c'est un reste à corriger, la source de vérité est
    docs/crm-create-endpoint.md.
---

# Contact Enricher — les coordonnées vérifiées, sur les survivants seulement

Tout le pipeline en amont existe pour qu'à cet instant on ne dépense un crédit que sur des
personnes qui le méritent. Le Signal Aggregator a déjà répondu à "qui enrichir" ; ce skill
répond à "avec quelles coordonnées vérifiées, à quel niveau de confiance, et prêt pour quel
prospect CRM". Il ne cherche pas de contacts, n'en qualifie pas de nouveaux, ne re-score rien.

C'est le seul agent qui coûte de l'argent réel à chaque appel. Sa discipline n'est donc pas la
détection mais la parcimonie : enrichir la liste exacte remontée, à la bonne confiance, une
fois, après un checkpoint de coût — et rendre proprement au Deliver ce qui est joignable comme
ce qui ne l'est pas.

## Prérequis (vérifier, pas supposer)

1. Le Signal Aggregator a rendu, pour le compte, un dossier avec `decision:
   READY_FOR_ENRICHMENT` et une section "Contacts recommandés pour FullEnrich" (1-3 personnes).
   Toute autre décision (`WATCHLIST`, `LOW_PRIORITY`, `REJECT`, `WAITING_FOR_SIGNALS`) →
   **rien n'est enrichi**, on s'arrête et on le dit.
2. Le Stakeholder Mapper a fourni les profils correspondants : `name`, `title`, `linkedin_url`,
   `decision_role`, `persona_match`, `level`, et le domaine du compte. Le `linkedin_url` est
   l'identifiant pivot vers FullEnrich ; sans lui, enrichir sur (prénom + nom + domaine).
3. La porte d'enrichissement est tenue : le compte porte **2+ signaux de catégories
   différentes** ET le `reachability_gap_status` du segment n'est pas `open`. Ce skill ne calcule
   pas cette porte (c'est l'étape 7 du Signal Aggregator, règle de l'ICP Scoring Agent) — il la
   **re-vérifie** comme garde-fou. Si elle n'est pas tenue, refuser d'enrichir et renvoyer au
   Signal Aggregator, quel que soit le score.

Si un prérequis manque, arrêter et rediriger vers l'agent amont concerné — ne jamais improviser
une liste de contacts ni un email deviné.

## Contrat d'entrée

Repris des sorties du Signal Aggregator (dossier) et du Stakeholder Mapper (profils) :

```json
{
  "account": { "name": "string", "domain": "string" },
  "enrichment_gate": {
    "decision": "READY_FOR_ENRICHMENT",
    "distinct_signal_categories": 2,
    "reachability_gap_status": "resolved | confirmed_negative | none"
  },
  "recommended_contacts": [
    {
      "name": "string",
      "title": "string",
      "linkedin_url": "string | null",
      "decision_role": "Decision-maker | Influencer | End user",
      "persona_match": "string",
      "level": "groupe | site"
    }
  ],
  "signal_summary": "string — la raison commerciale courte, reprise telle quelle pour rosk_deal_summary / notes"
}
```

`recommended_contacts` contient **1 à 3 personnes maximum**. Si le Signal Aggregator en a laissé
passer davantage, tronquer à la règle amont (DM niveau groupe d'abord, puis DM site le plus
senior, puis +1 Influencer si Tier 1) et signaler la troncature — ne jamais enrichir toute une
liste gonflée.

## Workflow

### Étape 1 — Vérifier la porte, avant tout coût

Re-contrôler les 3 prérequis ci-dessus sur les données reçues. Un seul faux → stop, message
clair ("compte non READY_FOR_ENRICHMENT" / "gap reachability encore ouvert" / "moins de 2
catégories de signaux"), renvoi à l'agent amont, **aucun crédit consommé**. Cette étape est la
raison d'être de la parcimonie : la moitié du travail de ce skill est de ne pas enrichir.

### Étape 2 — Déduplication CRM (avant de dépenser)

Pour chaque contact, si un email probable existe déjà (parfois présent dans le profil mappé —
non vérifié, cf. Stakeholder Mapper Annexe 1), le Deliver déduplique de toute façon par email
(`GET /api/prospects?q=<email>`, filtre exact, cf. docs/crm-create-endpoint.md). Quand un
contact est déjà un prospect connu **avec email vérifié récent**, proposer de le sauter :
ré-enrichir une coordonnée fraîche est un crédit gaspillé. La dédup finale appartient au Deliver,
mais éviter le doublon évident ici économise le crédit.

### Étape 3 — ⚡ Checkpoint de coût (obligatoire, jamais silencieux)

1. `get_credits` — lire le solde de crédits du workspace.
2. Annoncer : combien de contacts vont être enrichis, le coût estimé en crédits, le solde
   restant après. Un enrichissement waterfall (email + téléphone) coûte des crédits par contact.
3. **Attendre le GO explicite de l'humain** avant de lancer. Si le solde est insuffisant pour la
   liste complète, proposer de prioriser (les DM niveau groupe d'abord) plutôt que d'échouer à
   mi-parcours. Ne jamais lancer un enrichissement sans ce checkpoint — c'est la règle qui
   protège le budget de tout le pipeline.

### Étape 4 — Lancer l'enrichissement (asynchrone)

- **1 seul contact** → `enrich_search_contact` (ou après un `search_people` si le profil est
  maigre : nom + entreprise + titre).
- **2-3 contacts** → `enrich_bulk` en un seul job (name, company/domain, linkedin_url par
  personne). Conserver l'`enrichment_id` retourné — c'est la clé de polling.
- Enrichissement = **job asynchrone**. Le lancer ne rend pas les résultats.

### Étape 5 — Poller poliment jusqu'à complétion

- `get_enrichment_results(enrichment_id)`. Tant que le statut est `running`, **attendre** avant
  de re-poller (l'instruction MCP FullEnrich le dit : ne pas marteler). Intervalle de quelques
  secondes avec backoff, prévenir l'humain du délai plutôt que de boucler serré.
- Un waterfall parcourt plusieurs fournisseurs en cascade : un contact peut revenir sans email
  (waterfall épuisé). C'est un résultat **normal et informatif**, pas une erreur — voir étape 7.

### Étape 6 — Attacher le score de confiance

Chaque coordonnée vérifiée porte une confiance (statut de vérification email : `valid`,
`catch_all`, `unknown` ; présence/format du téléphone). Traduire en `rosk_enrichment_confidence`
lisible pour le commercial et le Deliver :

| Confiance | Condition |
|---|---|
| **High** | email `valid` (délivrable confirmé) + téléphone présent |
| **Medium** | email `valid` sans téléphone, OU email `catch_all` avec téléphone |
| **Low** | email `catch_all` seul, ou seulement un téléphone sans email |
| **None** | waterfall épuisé, aucune coordonnée vérifiée |

Un email `catch_all` n'est **pas** un email vérifié délivrable : ne jamais le présenter comme
tel. La confiance descend avec la qualité de la vérification, elle ne se gonfle jamais pour
"remplir" une ligne.

### Étape 7 — Router les non-joignables (évidence, jamais inférence)

Un contact revenu `None` n'est pas un échec silencieux : c'est une donnée pour la boucle Learn.
Le Deliver n'a pas de quoi créer un prospect sans email (l'email est le seul champ requis, cf.
docs/crm-create-endpoint.md) — donc :

- **Joignable (High/Medium/Low avec email)** → part au Deliver.
- **Non joignable (None, ou Low téléphone-seul)** → **ne pas** créer de prospect ; remonter le
  fait au Hypothesis Validator comme évidence de reachability (un DM identifié mais sans
  coordonnée vérifiée nuance le verdict de joignabilité). Ne **jamais** inférer une raison du
  silence — se limiter au fait "waterfall épuisé, aucun email vérifié", conformément à la règle
  Learn du brief ("ne pas inférer de raisons du silence, c'est un horoscope").

### Étape 8 — Construire le dossier prospect (contrat avec le Deliver)

Un objet par contact joignable, aligné exactement sur le body `POST /api/prospects`
(docs/crm-create-endpoint.md — mirror de `ProspectOut`, seul `email` requis) :

```json
{
  "email": "jane@acme.com",
  "first_name": "Jane",
  "last_name": "Doe",
  "title": "Head of Sales",
  "company": "Acme",
  "linkedin_url": "https://linkedin.com/in/jane",
  "source_list": "IC(E)looP",
  "status": "new",
  "notes": "Signal source (Sillage): <signal_summary>\nTél: <phone si présent>",
  "rosk_enrichment_confidence": "High | Medium | Low"
}
```

- `source_list` est **toujours** `"IC(E)looP"` — c'est ce qui rend les leads filtrables côté CRM.
- `status` est **toujours** `"new"`.
- `notes` porte la raison-signal (reprise du Signal Aggregator) **et** le téléphone — le schéma
  CRM n'a pas de champ téléphone dédié, il vit dans `notes`.
- `rosk_enrichment_confidence` accompagne le lead : le Deliver et le commercial doivent voir la
  confiance avant tout envoi. La cible de livraison est le **CRM tsplus-outreach** via
  l'adaptateur REST, **pas HubSpot** (les anciennes specs disent encore "HubSpot" — obsolète).

Et une synthèse finale : contacts enrichis / joignables / non-joignables, crédits consommés,
solde restant, et la liste des dossiers prêts pour le Deliver. **Le Deliver n'envoie rien sans
approbation humaine** (checkpoint du brief) — ce skill prépare, il ne pousse pas.

## Le score de confiance en une règle

`rosk_enrichment_confidence` reflète la vérifiabilité de la coordonnée, jamais l'envie de
compléter la ligne. Email `valid` + téléphone = High ; `catch_all` seul = Low ; waterfall épuisé
= None et le contact ne va pas au CRM. Un `catch_all` présenté comme délivrable est exactement le
genre de faux positif que tout le pipeline en amont a travaillé à éviter — ne pas le réintroduire
à la dernière étape.

## Golden rules

1. **Un crédit ne se dépense qu'après le checkpoint de coût** (`get_credits` + GO humain).
2. **On enrichit la liste recommandée, jamais le compte entier ni un contact ajouté ici.**
   1-3 personnes, DM niveau groupe d'abord.
3. **La porte d'enrichissement se re-vérifie, ne se relâche jamais** : 2+ catégories de signaux
   ET gap reachability non `open`. Un score élevé seul n'ouvre rien.
4. **Un email `catch_all` n'est pas un email vérifié** — la confiance descend, elle ne se gonfle
   pas.
5. **Un contact non joignable est une évidence, pas un échec silencieux** : il remonte au
   Hypothesis Validator, sans jamais inférer une raison du silence.
6. **La cible de livraison est le CRM tsplus, pas HubSpot** ; `source_list` toujours
   `"IC(E)looP"`, `status` toujours `"new"`, téléphone dans `notes`.
7. **Rien ne part au client** : ce skill remplit le prospect, le Deliver l'envoie après
   approbation humaine.

## Ce que ce skill ne fait PAS

- Détecter ou qualifier des contacts → Content Listener, Signal Aggregator.
- Mapper les décideurs ou décider qui enrichir → Stakeholder Mapper (profils), Signal
  Aggregator (décision READY_FOR_ENRICHMENT + liste recommandée).
- Calculer ou re-décider la porte d'enrichissement (2+ signaux / gap fermé) → Signal Aggregator,
  ICP Scoring Agent. Ce skill la vérifie, il ne la produit pas.
- Trancher le statut d'un gap reachability → Hypothesis Validator (ce skill lui rapporte des
  faits de joignabilité, il ne conclut pas).
- Créer le prospect dans le CRM ou l'enrôler dans une séquence → CRM Pusher / Deliver (adaptateur
  tsplus, `POST /api/prospects` puis `POST /api/sequences/{seq_id}/enroll`).
- Décider d'envoyer un message → jamais ; approbation humaine obligatoire côté Deliver.

## Exemple travaillé — groupe de brasseries (cas Rosk, suite)

Entrée du Signal Aggregator, compte `groupe-gastroparis-exemple.fr` :
`decision: READY_FOR_ENRICHMENT`, 2 catégories de signaux (Recurring Hiring + New Site Opening),
`reachability_gap_status: resolved`. Contacts recommandés (du Stakeholder Mapper) : DRH Groupe
(Decision-maker, level groupe, LinkedIn actif) et Directeur des Opérations (Decision-maker,
level groupe).

- **Étape 1** : porte tenue (2 catégories, gap `resolved`, décision READY) → on peut dépenser.
- **Étape 3** : `get_credits` → solde suffisant. Annonce : "2 contacts, ~X crédits, solde après :
  Y". GO humain reçu.
- **Étape 4** : `enrich_bulk` sur les 2 profils (linkedin_url + domaine). `enrichment_id` gardé.
- **Étape 5** : poll `get_enrichment_results` jusqu'à `completed`.
- **Étape 6-7** :
  - DRH Groupe → email `valid` + mobile → `rosk_enrichment_confidence: High` → dossier Deliver.
  - Directeur des Opérations → email `catch_all`, pas de téléphone → `Low` → dossier Deliver
    (l'humain arbitrera l'envoi), noté comme `catch_all` non garanti délivrable.
- **Étape 8** : 2 dossiers prêts, `source_list: "IC(E)looP"`, `status: "new"`, `notes` portant
  "Signal source (Sillage): recrutement récurrent + ouverture de site" et le téléphone du DRH.
  Synthèse : 2 enrichis, 2 joignables, 0 non-joignable, crédits consommés + solde restant, prêt
  pour le Deliver tsplus après approbation humaine.

Contre-exemple : si ce même compte était arrivé `WATCHLIST` (un seul signal), l'étape 1 aurait
refusé tout enrichissement et renvoyé au Signal Aggregator — zéro crédit dépensé. C'est le
comportement attendu, pas un blocage.

---

# ANNEXE — references/fullenrich-api.md

Source : instructions MCP du serveur FullEnrich. FullEnrich est une plateforme d'enrichissement
B2B (waterfall multi-fournisseurs) : email vérifié, téléphone, données pro.

## Les outils MCP FullEnrich

| Outil | Classe | Notes |
|---|---|---|
| `get_credits` | READ | Solde de crédits du workspace. **À appeler avant tout enrichissement** (checkpoint de coût). |
| `list_industries` | READ | Codes/labels d'industrie — à appeler AVANT de filtrer par industrie. |
| `list_seniorities` / `list_functions_subfunctions` | READ | Vocabulaires de filtrage pour la recherche. |
| `search_people` | READ | Recherche de contacts (nom, entreprise, titre, localisation, industrie), **max 10 résultats**. Sert à compléter un profil maigre avant enrichissement. |
| `search_companies` | READ | Recherche d'entreprises, max 10. |
| `search_contact_by_email` | READ | Résolution inverse par email (utile en dédup). |
| `enrich_search_contact` | TRIGGER (async) | Enrichit **un** contact trouvé via search — email + téléphone vérifiés. |
| `enrich_bulk` | TRIGGER (async) | Enrichit **plusieurs** contacts en un job. Retourne un `enrichment_id`. |
| `get_enrichment_results` | READ | Poll par `enrichment_id`. Statut `running` → attendre avant de re-poller. |
| `export_enrichment_results` | READ | Export CSV/JSON des résultats. **URL temporaire, expire après 24 h.** |
| `export_contacts` / `export_companies` | READ | Export CSV de gros volumes de recherche (pas le cas d'usage ENR-01, qui enrichit 1-3 contacts ciblés). |

## Cycle de vie d'un enrichissement

```
get_credits                         # checkpoint de coût AVANT tout
  → GO humain
enrich_bulk([...contacts])          # ou enrich_search_contact pour 1
  → { enrichment_id }
poll get_enrichment_results(id)
     running... (attendre entre deux polls, ne pas marteler)
  → completed
     → par contact : email + statut de vérification, téléphone, données pro
export_enrichment_results(id)       # optionnel, URL valable 24 h
```

## Règles de lecture des résultats

- **Statut email** : `valid` = délivrable vérifié ; `catch_all` = le domaine accepte tout,
  délivrabilité NON garantie (≠ vérifié) ; `unknown` / absent = waterfall épuisé.
- Un contact **sans email** en sortie est un résultat normal (waterfall qui n'a rien trouvé) —
  il ne va pas au CRM (email requis) et remonte comme évidence de reachability, sans inférence.
- **Ne jamais re-poller en boucle serrée** ni relancer un job déjà `running` : c'est du crédit et
  du rate limit gaspillés.
- **Toujours annoncer le coût avant** (instruction MCP FullEnrich) et le solde restant après.

## Pièges vérifiés

1. **`catch_all` ≠ vérifié.** Le présenter comme délivrable réintroduit exactement le faux
   positif que le pipeline évite. → confiance Low au maximum.
2. **L'enrichissement est asynchrone.** Le trigger ne rend pas les résultats ; il faut poller.
3. **Le coût est réel et par contact.** Pas de lancement sans `get_credits` + GO humain.
4. **Les URLs d'export expirent en 24 h** — ne pas les traiter comme des liens durables.
5. **Enrichir hors liste recommandée = payer pour du hors-ICP.** Le périmètre est fixé en amont
   (1-3 contacts), ce skill ne l'élargit jamais.
