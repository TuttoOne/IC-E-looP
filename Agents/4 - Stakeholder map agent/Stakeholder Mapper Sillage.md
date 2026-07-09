---
name: stakeholder-mapper-sillage
description: >
  Construit la power map de décideurs pour chaque compte de la liste cible Sillage : détecte si
  le compte est la filiale d'un groupe plus large, déclenche et lit le mapping de personnes
  (enrich_company → profiles), classe chaque profil en Décideur / Influenceur / Utilisateur final
  selon le persona, et produit la decision-maker map par compte prête pour le Contact Enricher
  (FullEnrich) et le CRM Pusher (HubSpot). Produit aussi le verdict reachability (après détection
  de groupe) routé au Hypothesis Validator - le Persona Builder ne fait que déclencher la
  couverture, ce skill tranche. Utiliser ce skill dès que l'utilisateur mentionne :
  "Stakeholder Mapper", "power map", "mapper les décideurs", "qui décide chez X", "détecter les
  filiales / le groupe parent", "SIG-01 mapping", "couverture des comptes", ou demande qui sont
  les interlocuteurs dans les comptes cibles - même sans dire "stakeholder". Prérequis : un
  persona Sillage déjà configuré (sinon → persona-builder-sillage d'abord).
metadata:
  version: 1.1.0
  phase: SIG-01 (Phase 2 - Signal Detection)
  pairs-with: [persona-builder-sillage, sillage-manage-workspace]
  upstream: persona-builder-sillage (persona configuré + top accounts ingérés + couverture enrich_company déclenchée sur les comptes prioritaires)
  downstream: Contact Enricher (ENR-01), Signal Aggregator, CRM Pusher (rosk_persona_match, rosk_decision_role, rosk_site_count), Hypothesis Validator (verdict reachability), persona-builder-sillage (ré-invocation ciblée si le headcount du groupe invalide le persona)
  changelog: >
    v1.1.0 - reprend 3 points d'un check du Persona Builder. (1) ce skill devient le seul
    producteur du verdict reachability (evidence + statut du gap) routé au Hypothesis
    Validator, toujours après la détection de groupe - le Persona Builder ne fait plus que
    déclencher la couverture en amont, ce qui évite un faux négatif sur un compte dont le
    parent, une fois détecté, s'avère joignable (cas GastroParis, voir Étape 6). (2) le
    checkpoint humain de découverte de groupe (Étape 4) porte désormais aussi la question
    du headcount groupe vs persona configuré, avec proposition de mise à jour exécutée par
    le Persona Builder (GET→merge→PUT), jamais par un upsert direct depuis ce skill.
    (3) clarifie que la requalification de tier (Étape 6) est une donnée transmise au
    Hypothesis Validator, pas une décision prise ici ni une boucle de re-score construite
    par ce skill.
---

# Stakeholder Mapper - la power map par compte

Le Persona Builder a défini *qui chercher* ; ce skill trouve *qui existe réellement* dans chaque
compte cible, et surtout *où siège la décision*. Dans les groupes multi-sites (le cas Rosk est
typique : brasseries, hôtellerie), le piège classique est de mapper l'entité visible - le
restaurant - alors que le DRH groupe signe depuis la holding. Une power map qui rate le groupe
parent envoie tout l'outreach au mauvais étage.

Deux livrables par compte : (1) le verdict de structure (indépendant / filiale d'un groupe, avec
l'entité parente identifiée) et (2) la table des personnes classées par rôle de décision, prête à
alimenter le Contact Enricher et les champs CRM `rosk_persona_match` / `rosk_decision_role` /
`rosk_site_count`.

## Prérequis

- Persona Sillage configuré (`get_persona` non-null) - sinon arrêter et rediriger vers
  `persona-builder-sillage`
- Lire `references/sillage-mapping-api.md` AVANT tout appel - états, erreurs, et le piège
  `get_top_accounts` vs `read_top_account_list`
- Lire `references/detection-groupe-et-classification.md` pour la méthode de détection de
  groupe et les règles de classification des rôles

## Workflow en 7 étapes

### Étape 1 - Établir le périmètre (et le checkpoint de coût)

1. `read_top_account_list` (view: accounts) - c'est LA liste cible. Ne JAMAIS utiliser
   `get_top_accounts` comme source : c'est un superset de toute activité, pas la liste
2. `list_company_mappings` - identifier les comptes DÉJÀ mappés (statut `complete`) pour ne
   pas re-consommer de crédits inutilement
3. ⚡ **Checkpoint périmètre** : annoncer combien de comptes vont être mappés, lesquels sont
   déjà couverts, et que chaque mapping consomme des crédits. Attendre le GO avant de lancer.
   Proposer de prioriser (ex. Tier 1-2 d'abord) si la liste est longue

### Étape 2 - Déclencher les mappings (batch discipliné)

Pour chaque compte du périmètre validé, PAS encore mappé :

1. `enrich_company` avec le **domaine** (jamais l'URL LinkedIn en premier choix). Sur domaine
   ambigu (409 / erreur de résolution) : réessayer avec domaine + linkedin_url ensemble
2. Conserver chaque `request_id` retourné - c'est directement le `mapping_id` de lecture
3. Lancer les triggers en série avec un court délai, pas en rafale (respecter le rate limit ;
   lire `X-RateLimit-Remaining` / utiliser `get_rate_limit` si disponible)
4. Erreurs à traiter immédiatement, sans retry aveugle :
   - **403** = feature Account Mapping non activée → STOP, remonter à l'utilisateur
   - **402** = crédits épuisés → STOP, remonter, livrer ce qui est déjà mappé
   - **409** = requête en vol pour ce compte → réutiliser, ne pas dupliquer

### Étape 3 - Poller poliment jusqu'à complétion

- `get_requests_status` pour la vue d'ensemble (items typés `account_mapping`), ou
  `get_account_mapping_stage(request_id)` par compte
- Terminal : `completed` ou `account_mapping_failed`. Un "not found" en cours de route est
  NORMAL (le record n'est lisible qu'à `completed`) - ce n'est pas une erreur
- Intervalle de quelques secondes avec backoff, jamais de boucle serrée - un mapping peut
  prendre plusieurs minutes. Prévenir l'utilisateur du délai plutôt que de marteler l'API

### Étape 4 - Lire et analyser chaque mapping

1. `get_company_mapping(mapping_id)` → `profiles[]` : name, position, linkedin_url, email,
   phone, location par personne
2. `get_company(company_id)` → l'enrichissement entreprise : headcount, industries,
   locations (siège en premier, flag `is_hq`), année de fondation, résumé d'activité.
   Champs null = non enrichi, pas une absence de données
3. **Détection de groupe parent** - appliquer la méthode à 4 indices de
   `references/detection-groupe-et-classification.md` (titres "Group/Groupe" dans les
   positions, incohérence headcount/sites, siège distinct, raison sociale différente).
   Si suspicion forte : vérifier via recherche web/LinkedIn, identifier le domaine du parent
4. Si parent confirmé : `enrich_company` sur le domaine du PARENT aussi - c'est là que
   siègent les décideurs groupe. ⚡ **Checkpoint** : proposer (ne pas imposer) l'ajout du
   parent à la top account list (`add_top_accounts` est append-only : décision de ciblage
   qui appartient à l'humain). Au même checkpoint, vérifier si le `headcount` du groupe
   invalide le persona configuré (ex. persona sur `"51-200"` alors que le groupe fait
   `"501-1,000"`) : si oui, le signaler et proposer la mise à jour, sans l'exécuter ici -
   c'est le Persona Builder qui la réalise via sa procédure GET→merge→PUT, jamais un upsert
   fait directement depuis ce skill

### Étape 5 - Classer les profils

Pour chaque profil, croiser `position` avec le persona et attribuer :

- **`decision_role`** : Decision-maker / Influencer / End user (règles dans la référence -
  aligné sur le champ CRM `rosk_decision_role`)
- **`persona_match`** : la catégorie persona correspondante (ex. Group HR Director /
  Ops Director / Site Manager - aligné sur `rosk_persona_match`)
- **`level`** : groupe / site - un Decision-maker niveau groupe prime sur son homologue site
- Les profils hors persona (`exclude_job_title` ou aucun match) sont listés à part comme
  "écartés", jamais silencieusement supprimés - l'humain doit pouvoir contester le tri

### Étape 6 - Livrer la decision-maker map

Format de sortie par compte (c'est le contrat d'interface avec l'aval) :

```
## Power map - <Compte> (<domaine>)
Structure : indépendant | filiale de <Parent> (<domaine parent>) - confiance : haute/moyenne
Sites détectés : N  →  rosk_site_count
Headcount : <bucket>  |  Siège : <ville>

| Personne | Titre | decision_role | persona_match | Niveau | LinkedIn | Email dispo |
|---|---|---|---|---|---|---|

Écartés (hors persona) : <liste courte + raison>
Gaps : <ex. "aucun profil RH trouvé - candidat pour recherche manuelle LinkedIn">
Recommandation Contact Enricher : <les 1-3 profils à enrichir en priorité via FullEnrich>
```

Et en synthèse finale, la vue agrégée : comptes mappés / échoués / en attente de crédits,
groupes parents découverts, et la liste consolidée des profils prioritaires pour ENR-01
(rappel de la règle amont : FullEnrich ne se déclenche que sur les personnes à 2+ signaux -
ce skill fournit les personnes, le Signal Aggregator fournira les signaux).

### Étape 7 - Verdict reachability vers le Hypothesis Validator (nouveau)

Cette étape ne s'exécute que si le Persona Builder a signalé, en amont, un knowledge_gap
`dimension: "reachability"` ouvert pour le segment. Ce skill est le seul à trancher ce gap :
le Persona Builder se limite à déclencher la couverture (`enrich_company`) sur les comptes
prioritaires, jamais à conclure sur la reachability - la détection de groupe de l'Étape 4 est
justement ce qui rend un verdict fiable, un compte visible sans décideur accessible pouvant
très bien avoir un parent joignable une fois détecté (cas GastroParis ci-dessous).

Produire ce rapport, une fois le mapping et la classification terminés sur le périmètre
validé au checkpoint de l'Étape 1 :

```json
{
  "segment_id": "string",
  "gap_dimension": "reachability",
  "accounts_checked_this_run": 0,
  "decision_makers_found": 0,
  "evidence": [
    {"account_domain": "string", "title_found": "string", "channel": "LinkedIn actif / activité détectée Sillage / aucun", "level": "groupe / site"}
  ],
  "checked_at": "date ISO"
}
```

Ce skill **rapporte des faits, jamais ne tranche** le statut du gap. La décision de faire
passer le statut de `open` à `resolved` ou `confirmed_negative` appartient exclusivement au
Hypothesis Validator, qui applique le deadline global (1 semaine ou 10 comptes vérifiés,
selon ce qui arrive en premier). Ne jamais inclure de champ `status` dans ce rapport - ce
serait usurper une décision qui ne t'appartient pas.

## Règles d'or

1. **Jamais de mapping sans checkpoint de périmètre** - ça consomme des crédits
2. **`read_top_account_list` est la seule source du périmètre**, jamais `get_top_accounts`
3. **La couverture ne se rafraîchit pas seule** : si le persona a changé depuis un mapping,
   re-trigger `enrich_company` sur les comptes concernés (sinon la map est classée contre
   l'ancien ICP)
4. **Un remove+re-add de compte n'est PAS un refresh** de la map - c'est `enrich_company`
   qui reconstruit les personnes
5. **403 et 402 se remontent, ne se retentent pas**
6. **Le parent d'une filiale se mappe aussi** - sinon la power map est structurellement
   incomplète pour les Tiers 1-2

## Ce que ce skill ne fait PAS

- Configurer le persona → `persona-builder-sillage` (y compris la mise à jour du persona
  proposée au checkpoint de l'Étape 4 - ce skill signale, le Persona Builder écrit)
- Enrichir les coordonnées vérifiées (email/téléphone waterfall) → Contact Enricher / FullEnrich
- Scorer les signaux → Signal Aggregator
- Décider qu'une requalification de tier (ex. `rosk_site_count` qui passe un compte de T3
  apparent à T2 réel) change le scoring `market_size`/`ltv_proxy` du segment → ce skill se
  contente de flaguer la requalification dans sa sortie (Étape 6/8) ; c'est au Hypothesis
  Validator de confirmer ou infirmer, pas à ce skill de re-scorer ou de construire une boucle
  formelle
- Pousser dans HubSpot → CRM Pusher (mais il produit ses champs d'entrée)


---

# ANNEXE 1 - references/sillage-mapping-api.md

Source : `tool-map.md` + `endpoint-catalog.md` + `conventions.md` du repo officiel
sillage-labs/skills. Note importante : les endpoints de mapping sont **absents de la spec
OpenAPI publiée** par Sillage mais sont live et documentés ici - ne pas conclure qu'ils
n'existent pas si la spec ne les montre pas.

## Les outils MCP du mapping

| Outil | Classe | Params clés | Notes |
|---|---|---|---|
| `sillage_v2_read_top_account_list` | READ | `view: accounts \| not_found` | **La vraie liste cible.** Seule source légitime du périmètre |
| `sillage_v2_get_top_accounts` | READ | `limit?` (max 250) | ⚠️ Superset de toute activité - PAS la liste cible. Ne jamais confondre |
| `sillage_v2_enrich_company` | TRIGGER | exactement un de `{domain}` / `{linkedin_url}` / `{linkedin_handle}` | Construit la couverture (personnes). Domaine de préférence ; sur ambigu (409), domaine + linkedin_url ensemble. Idempotent. Retourne `request_id` |
| `sillage_v2_get_account_mapping_stage` | READ | `id` (le request_id) | Poll cible. Terminal : `completed`, `account_mapping_failed` |
| `sillage_v2_list_company_mappings` | READ | `page?, page_size?` | Mappings matérialisés SANS profils. `data[].id` = mapping_id ; `status` = `in_progress` \| `complete` |
| `sillage_v2_get_company_mapping` | READ | `mapping_id` | LE mapping avec `profiles[]` enrichis. Accepte directement le `request_id` d'enrich comme mapping_id. Lisible seulement à `completed` |
| `sillage_v2_get_company` | READ | `company_id` | Enrichissement entreprise : name, domain, linkedin, headcount, industries, locations (HQ en premier, flag `is_hq`), founded, activity summary. Champs null tant que non enrichi |
| `sillage_v2_get_requests_status` | READ | `page?` | Vue "qu'est-ce qui tourne ?" : `requests[]` typés `account_mapping` \| `top_account_content` \| `signal`, avec status + label lisible. Tableau vide = rien en vol |
| `sillage_v2_get_rate_limit` | READ | - | Vérifier le quota AVANT un batch ; respecter `retry_after` sur 429 |

## Structure d'un profil mappé

`get_company_mapping` retourne `profiles[]`, chaque profil contenant :

- `name` - nom complet
- `position` - titre de poste (la matière première de la classification)
- `linkedin_url` - identifiant pivot vers FullEnrich et les watchlists
- `email` - parfois présent ; NE PAS le considérer vérifié (c'est le rôle de FullEnrich +
  son score de confiance en aval)
- `phone` - idem
- `location` - utile pour distinguer niveau site vs niveau siège

## Cycle de vie d'un mapping

```
enrich_company(domain)
  → 202 { request_id, stage }          # idempotent : requête récente réutilisée
  → poll get_account_mapping_stage(request_id)
       queued/processing... ("not found" possible en vol = NORMAL)
  → terminal : completed | account_mapping_failed
  → get_company_mapping(request_id)    # request_id accepté comme mapping_id
       → profiles[]
```

- Poll : intervalle de quelques secondes AVEC backoff. Un mapping peut prendre des minutes
- `completed_partial` n'existe que pour les signal runs, pas les mappings
- Relancer un mapping échoué ou récent réutilise la même requête (pas de doublon)

## Erreurs et réponses

| Code | Signification | Réaction |
|---|---|---|
| `402` | Crédits insuffisants | STOP - remonter à l'utilisateur, livrer le partiel déjà mappé |
| `403` | Feature **Account Mapping non activée** sur le workspace | STOP - remonter, NE PAS réessayer |
| `404` | Id inconnu OU record pas encore prêt (mapping en vol) | Si en vol : continuer à poller. Sinon vérifier l'id |
| `409` | Requête en conflit / déjà en vol pour ce compte, ou domaine ambigu | Réutiliser la requête en vol ; sur ambigu, retry domaine + linkedin_url |
| `422` | Payload sémantiquement invalide (identifiants conflictuels) | Corriger : exactement UN identifiant (sauf domain+url pour désambiguïser ; jamais handle+autre) |
| `429` | Rate limit | Back-off, respecter `retry_after` |
| `500` | Erreur serveur | Retry avec backoff ; si persistant, noter le `X-Request-Id` pour le support |

## Pièges vérifiés

1. **`get_top_accounts` n'est pas la liste cible** - c'est chaque entreprise ayant une trace
   d'activité quelconque. Construire un périmètre de mapping dessus = mapper (et payer) des
   comptes hors ICP
2. **La couverture est figée au moment du mapping.** Un changement de persona ne re-classe
   rien : re-trigger `enrich_company` sur les comptes dont la map doit refléter le nouvel ICP
3. **Ajouter une entité à une watchlist ne construit PAS sa couverture** - les personnes
   viennent uniquement d'`enrich_company` par domaine
4. **L'email d'un profil mappé n'est pas un email vérifié.** Le pipeline aval (FullEnrich,
   `rosk_enrichment_confidence`) existe précisément pour ça - ne pas court-circuiter
5. **Un remove + re-add dans la top account list ne relance pas le mapping des personnes** -
   c'est un `enrich_company` séparé


---

# ANNEXE 2 - references/detection-groupe-et-classification.md

La partie que Sillage ne fait PAS pour toi. Il n'existe aucun outil `get_parent_company` -
la détection de filiale est un travail de raisonnement sur les données enrichies, à faire
systématiquement pour chaque compte. Et la classification Décideur / Influenceur / Utilisateur
est une règle métier, pas un champ retourné par l'API.

## Partie 1 - Détecter si le compte est la filiale d'un groupe

### Les 4 indices (chercher les 4, conclure sur le faisceau)

**Indice 1 - Les titres trahissent la structure.** Scanner `profiles[].position` :

- "Group HR Director", "DRH Groupe", "Directeur de Réseau", "Head of Franchise",
  "Directeur des Opérations Groupe" → il existe un étage groupe
- Un titre mentionnant une AUTRE raison sociale que le compte ("HR Director @ Groupe Bertrand"
  alors qu'on mappe une enseigne) → le parent est nommé dans les données mêmes
- Beaucoup de titres site (Restaurant Manager, Directeur d'établissement) et AUCUN titre
  fonction centrale (RH, Finance, Ops) → les fonctions support sont ailleurs = probable holding

**Indice 2 - Incohérence taille/périmètre.** Croiser `get_company` : un headcount de
`"501-1,000"` pour une enseigne à 3 adresses visibles → l'entité LinkedIn agrège un groupe.
Inversement, un headcount `"11-50"` pour une marque présente dans 10 villes → les sites sont
des entités séparées et on ne mappe qu'un fragment.

**Indice 3 - Géographie du siège.** `locations` avec `is_hq` : un siège dans une tour de
La Défense pour un restaurant de quartier = fonctions centrales séparées de l'exploitation.

**Indice 4 - Vérification externe (si indices 1-3 concordent).** Recherche web/LinkedIn
ciblée : "<enseigne> groupe", page LinkedIn de l'enseigne (le champ "part of" / affiliations),
mentions légales du site (l'éditeur du site = souvent la holding, avec son propre domaine).
C'est cette étape qui donne le **domaine du parent** nécessaire pour l'enrichir.

### Verdict à produire

```
Structure : filiale de <Parent> (<domaine>) - confiance : haute
Méthode : titres "Groupe" (2 profils) + siège La Défense + mentions légales du site
Action : enrich_company(<domaine parent>) lancé ; proposition d'ajout du parent à la TAL
```

Confiance **haute** = 2+ indices concordants dont une vérification externe.
**Moyenne** = indices internes seulement → mapper le parent quand même, mais le signaler.
Ne jamais affirmer une structure de groupe sur un indice unique.

### Conséquence sur le mapping

Si filiale confirmée : le parent DOIT être mappé aussi (`enrich_company` sur son domaine),
car pour les Tiers 1-2 la décision est centralisée - c'est écrit dans l'ICP même. Les profils
du parent entrent dans la power map du compte avec `level: groupe`. L'ajout du parent à la
top account list est proposé à l'humain (append-only, décision de ciblage), jamais fait
d'office.

## Partie 2 - Classifier chaque profil

### Règles de décision (dans cet ordre)

1. **Exclusion d'abord** : `position` matche `exclude_job_title` du persona → écarté
   (listé à part avec raison, jamais supprimé silencieusement)
2. **Decision-maker** : titre dans les catégories décideur du persona ET séniorité
   `c_suite`/`vp`/`head`/`director`/`owner`/`founder`. Un DM `level: groupe` PRIME sur son
   homologue `level: site`
3. **Influencer** : fonction adjacente au problème (pour du staffing : Responsable Recrutement,
   Talent Acquisition, Office Manager qui gère les plannings) OU décideur d'un périmètre voisin
4. **End user** : celui qui vit le problème au quotidien sans signer (manager de site, chef de
   cuisine) - précieux comme porte d'entrée conversationnelle, jamais comme cible contractuelle

### Mapping vers les champs CRM (contrat avec le CRM Pusher)

| Sortie du skill | Champ HubSpot | Valeurs |
|---|---|---|
| `decision_role` | `rosk_decision_role` | Decision-maker / Influencer / End user |
| `persona_match` | `rosk_persona_match` | Group HR Director / Ops Director / Site Manager (adapter les catégories au persona actif) |
| Sites détectés | `rosk_site_count` | Entier - compté depuis locations + recherche externe |

### Priorisation pour le Contact Enricher (ENR-01)

Par compte, recommander 1 à 3 profils maximum, dans cet ordre :

1. Le Decision-maker `level: groupe` s'il existe
2. Sinon le Decision-maker site le plus senior
3. +1 Influencer si le compte est Tier 1 (approche multi-stakeholder prévue par la cadence)

Rappel de la règle amont : FullEnrich ne se déclenche que sur les personnes à **2+ signaux**
- la recommandation désigne les candidats, le Signal Aggregator apporte les signaux, et c'est
l'intersection qui part en enrichissement.

## Exemple travaillé - groupe de brasseries (cas Rosk)

Compte TAL : `brasserie-lipp-exemple.fr`, enseigne parisienne.

- Mapping → 6 profils : 3 "Directeur d'établissement", 1 "Chef exécutif",
  1 "Responsable RH - Groupe GastroParis", 1 "Serveur"
- `get_company` : headcount `"201-500"`, siège Paris 8e, 1 seule adresse d'exploitation connue
- **Faisceau** : titre mentionnant "Groupe GastroParis" (indice 1) + headcount incohérent avec
  1 adresse (indice 2) → vérification web : GastroParis opère 11 enseignes, domaine
  `groupe-gastroparis-exemple.fr` (indice 4) → **filiale, confiance haute**
- `enrich_company("groupe-gastroparis-exemple.fr")` → 9 profils dont "DRH Groupe",
  "Directeur des Opérations", "DAF"
- Classification finale de la power map du compte :
  - DRH Groupe → **Decision-maker**, persona_match: Group HR Director, level: groupe ← cible n°1
  - Directeur des Opérations (groupe) → **Decision-maker**, level: groupe
  - Responsable RH (enseigne) → **Influencer**, level: site
  - Directeurs d'établissement ×3 → **End user**, level: site
  - Serveur → écarté (hors persona)
- `rosk_site_count: 11` (sites du groupe, pas de l'enseigne seule) - ce qui requalifie le
  compte de Tier 3 apparent en **Tier 2 réel**. Cette requalification est flaguée dans la
  sortie et transmise au Hypothesis Validator (Étape 7 du fichier SKILL.md) - ce skill ne
  décide pas lui-même de re-scorer `market_size`/`ltv_proxy` en conséquence
- Recommandation ENR-01 : DRH Groupe + Directeur des Opérations
- Proposé à l'humain, au même checkpoint : ajouter `groupe-gastroparis-exemple.fr` à la top
  account list, ET vérifier le persona - ici `headcount: "201-500"` déjà configuré couvre le
  cas, donc pas de mise à jour proposée. Si le persona avait été configuré sur `"11-50"`
  (segment initial pensé "petits indépendants"), ce même checkpoint aurait signalé
  l'incohérence et proposé une extension du bucket headcount, à exécuter par le Persona
  Builder via GET→merge→PUT, pas par ce skill

La leçon : sans détection de groupe, ce compte aurait été traité comme un restaurant
indépendant Tier 3 et l'email serait parti au directeur d'établissement - qui ne signe pas.

Verdict reachability produit à l'Étape 7, une fois ce compte (et les 11 autres du
périmètre validé) traités :

```json
{
  "segment_id": "seg_01",
  "gap_dimension": "reachability",
  "accounts_checked_this_run": 12,
  "decision_makers_found": 7,
  "evidence": [
    {"account_domain": "groupe-gastroparis-exemple.fr", "title_found": "DRH Groupe", "channel": "LinkedIn actif", "level": "groupe"},
    {"account_domain": "exemple-groupe2.fr", "title_found": "DRH", "channel": "activité détectée Sillage", "level": "site"}
  ],
  "checked_at": "2026-07-09"
}
```

Sur `brasserie-lipp-exemple.fr` seul, sans détection de groupe, ce compte aurait pu compter
comme "aucun décideur trouvé" - c'est justement la détection de groupe de l'Étape 4 qui
transforme ce compte en évidence positive avant que ce rapport ne soit produit. Le statut
du gap (`resolved` ou `confirmed_negative`) reste une décision du Hypothesis Validator, pas
de ce skill.
