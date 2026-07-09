# Hypothesis Validator - Spec

## Role et position dans le pipeline

Le Hypothesis Validator est le point de convergence de la Phase 2. Il reçoit trois flux distincts et produit une seule sortie : le statut à jour de chaque hypothèse et de chaque knowledge gap, par segment.

Downstream : Kill Gate 2, et l'ICP doc mis à jour (Phase 6, ICP Refinement Agent).

Point important sur la dépendance au Signal Aggregator : deux des trois flux d'entrée ne dépendent PAS du Signal Aggregator et sont donc spécifiables et implémentables dès maintenant. Un seul flux en dépend. Ce document sépare les deux explicitement.

## Les trois flux d'entrée

### Flux A - Verdict reachability (Stakeholder Mapper, prêt)

Produit à l'Étape 7 du Stakeholder Mapper, après sa détection de groupe. Schéma déjà figé :

```json
{
  "segment_id": "string",
  "gap_dimension": "reachability",
  "accounts_checked_this_run": 0,
  "decision_makers_found": 0,
  "evidence": [
    {"account_domain": "string", "title_found": "string", "channel": "string", "level": "groupe / site"}
  ],
  "checked_at": "date ISO"
}
```

Le Mapper rapporte des faits uniquement, aucun champ `status`. C'est le Hypothesis Validator qui tranche.

### Flux B - Classification des profils (Stakeholder Mapper, prêt)

Produit à l'Étape 5/6 du Stakeholder Mapper, indépendamment du gap reachability. Table decision_role / persona_match par personne et par compte. Résout potentiellement les gaps buyer_persona et budget_authority, sans passer par le Signal Aggregator.

Inclut aussi le signal de requalification de tier (ex. rosk_site_count qui fait passer un compte de T3 apparent à T2 réel via détection de groupe parent). Le Mapper flague cette requalification mais ne re-score jamais lui-même market_size ou ltv_proxy - c'est explicitement le rôle du Hypothesis Validator.

### Flux C - Dossiers de décision par compte (Signal Aggregator, spec disponible)

Le Signal Aggregator produit un dossier par compte, jamais un score au niveau segment - c'est le Hypothesis Validator qui agrège. Schéma réel, repris de sa spec :

```json
{
  "account_domain": "string",
  "decision": "READY_FOR_ENRICHMENT | WATCHLIST | LOW_PRIORITY | REJECT | WAITING_FOR_SIGNALS",
  "signal_score": 0,
  "priorite_commerciale": "Very High | High | Medium | Low | Discard",
  "segment_context_lu": {"weighted_total": 0.0, "overall_confidence": "string", "reachability_gap_status": "string"},
  "signaux_retenus": [
    {"categorie": "Recurring Hiring | New Site Opening | Seasonal Hiring Burst | Leadership Change | Competitor Engagement | Funding/Expansion | Negative Signal | Unknown", "date": "string", "description": "string"}
  ],
  "rejection_reason": "string ou null - Labor conflict / Competitor lock-in / Too small, uniquement si decision = REJECT"
}
```

Point d'attention réel, pas une supposition : les 8 catégories du Signal Aggregator ne couvrent pas `tech_stack_signals`. Ce gap n'a donc aucun mécanisme de résolution via ce flux. D'après la spec ICP-02, `tech_stack_signals` se résout via le Content Listener directement (le feed brut, pas le dossier catégorisé du Signal Aggregator) - un flux que le Hypothesis Validator n'a pas encore en entrée. À traiter comme une vraie question ouverte plutôt qu'un mapping à inventer.

`reachability_gap_status` apparaît en lecture dans le contexte segment du Signal Aggregator lui-même : il consomme la décision du Hypothesis Validator, il ne la produit jamais. Le sens du flux est confirmé : Hypothesis Validator -> Signal Aggregator sur ce point, jamais l'inverse.

## Contrat d'entrée complet

```json
{
  "segment_id": "string",
  "knowledge_gaps": [
    {
      "dimension": "reachability | buyer_persona | budget_authority | trigger_events | existing_alternatives | tech_stack_signals",
      "why_it_matters": "string",
      "resolve_via": "string",
      "status": "open",
      "opened_at_phase": "scoring",
      "resolution_deadline": "string",
      "opened_at_date": "date ISO - nécessaire pour calculer la deadline, absent du schéma ICP-02 original, à ajouter"
    }
  ],
  "reachability_verdict": "objet Flux A, ou null si pas de gap reachability ouvert",
  "profile_classification": "objets Flux B, agrégés par compte",
  "tier_requalification_flags": ["objets flagués par le Mapper, ex. site_count 3 -> 11, T3 -> T2 implicite"],
  "signal_dossiers": ["objets Flux C, un par compte du segment, agrégés côté Hypothesis Validator pour les décisions au niveau segment"],
  "hypotheses_to_test": ["passées depuis ICP-01/ICP-02, reordonnées à chaque appel"],
  "current_scores": "objet scores ICP-02 (market_size, urgency, reachability, ltv_proxy) - nécessaire pour appliquer le re-score de tier"
}
```

Note sur `opened_at_date` : la spec ICP-02 définit la deadline comme "1 semaine ou 10 comptes vérifiés" mais ne stocke jamais la date d'ouverture du gap. Sans elle, le Hypothesis Validator ne peut pas calculer si la deadline temporelle est dépassée. À ajouter au schéma `knowledge_gaps` en amont (ICP-02 et Persona Builder), sinon seul le critère de volume (comptes / contenus) est utilisable pour l'instant.

## Logique de résolution des gaps, par flux

### Gaps rapides (reachability, buyer_persona, budget_authority) - PRÊT, pas de dépendance Signal Aggregator

Deadline : 1 semaine depuis `opened_at_date`, ou 10 comptes du segment vérifiés, selon ce qui arrive en premier.

**reachability** : résolu uniquement via Flux A.
- Si `decision_makers_found` > 0 sur au moins une partie des comptes vérifiés (`accounts_checked_this_run`) : `status: resolved`, nouveau score reachability calculé sur la rubrique 0-5 de la spec ICP-02, à partir de l'évidence (channel actif + niveau groupe/site).
- Si deadline atteinte (temps ou volume) sans decision-maker trouvé : `status: confirmed_negative`, ce qui déclenche le kill rétroactif du segment (reachability est le seul critère à pouvoir tuer un segment après coup).
- Tant que ni l'un ni l'autre : `status` reste `open`, aucune décision.

**buyer_persona / budget_authority** : résolus via Flux B.
- Si la classification produit au moins un `decision_role: Decision-maker` avec `persona_match` cohérent : `status: resolved`, score correspondant recalculé.
- Si deadline atteinte sans classification exploitable : `status` locked à `low` de façon permanente pour ce critère (pas de kill, contrairement à reachability - voir logique Kill Gate 1 dans la spec ICP-02).

### Gaps lents (trigger_events, existing_alternatives) - PRÊT pour ces deux dimensions, via Flux C

Deadline : 2 semaines, ou 20 comptes du segment couverts par un dossier Signal Aggregator (READY_FOR_ENRICHMENT, WATCHLIST, LOW_PRIORITY ou REJECT - tout sauf WAITING_FOR_SIGNALS compte comme couvert), selon ce qui arrive en premier.

**trigger_events** : résolu si au moins un dossier du segment porte un `signaux_retenus` de catégorie Recurring Hiring, New Site Opening ou Seasonal Hiring Burst qui correspond qualitativement à l'hypothèse testée (match qualitatif décidé par le Hypothesis Validator, pas une règle automatique - une catégorie présente ne confirme pas n'importe quelle hypothèse trigger_events, elle doit correspondre au trigger décrit). Si deadline atteinte sans catégorie correspondante sur aucun compte : `locked_low`.

**existing_alternatives** : résolu de la même façon via la catégorie Competitor Engagement. Si aucun dossier du segment ne la porte à la deadline : `locked_low`.

**tech_stack_signals** : PAS résoluble via ce flux (voir Flux C ci-dessus - aucune des 8 catégories ne le couvre). Reste `open` indéfiniment tant que le Hypothesis Validator n'a pas un accès direct au feed brut du Content Listener. Marqué comme question ouverte, pas comme un flux bloqué à débloquer plus tard - c'est un trou d'architecture distinct.

### Kill Gate 2 - PRÊT, logique d'agrégation à la charge du Hypothesis Validator

Le Signal Aggregator ne produit aucun booléen de cohérence au niveau segment - il faut le reconstruire. Règle proposée : sur les comptes du segment couverts (hors WAITING_FOR_SIGNALS), si aucun dossier ne porte de `signaux_retenus` correspondant à au moins une hypothèse du segment à la deadline de 2 semaines / 20 comptes couverts, alors `segment sans signaux cohérents` est vrai et Kill Gate 2 se déclenche (segment mis en pause, pas tué - contrairement à Kill Gate 1). Si tous les comptes du segment reviennent WAITING_FOR_SIGNALS à la deadline, c'est un signal distinct : pas une incohérence JTBD mais un problème de couverture (Content Listener pas encore lancé ou en attente) - à ne pas traiter comme un échec du segment.

## Requalification de tier - PRÊT, pas de dépendance Signal Aggregator

Quand le Stakeholder Mapper flague une requalification (ex. `rosk_site_count` 3 -> 11 après détection de groupe parent), le Hypothesis Validator confirme ou rejette un re-score de `market_size` et `ltv_proxy` :

- Confirmer si le nouveau `firmographics` réel (taille du groupe, pas de l'enseigne seule) change la tranche de la rubrique ICP-02 (ex. passage de "3 mid-size" à "4-5 large et bien documenté").
- Rejeter si la requalification ne change pas la tranche malgré le changement de tier apparent (ex. le groupe reste dans la même fourchette de taille que ce qui était déjà scoré).
- Toujours documenter la décision dans `rationale`, jamais silencieusement.

Ceci n'est PAS une boucle automatique : le Mapper flague, le Hypothesis Validator décide, une seule fois par requalification reçue.

## Sortie

```json
{
  "segment_id": "string",
  "knowledge_gaps_updated": [
    {
      "dimension": "string",
      "status": "open | resolved | confirmed_negative | locked_low",
      "new_score": "objet score ou null si toujours open",
      "evidence_used": "reachability_verdict | profile_classification | signal_dossiers | unresolvable_no_source | none",
      "decided_at": "date ISO"
    }
  ],
  "retroactive_kill": {
    "triggered": false,
    "reason": "string ou null - uniquement si reachability confirmed_negative"
  },
  "tier_requalifications_resolved": [
    {"account_domain": "string", "old_tier": "string", "new_tier": "string", "score_impact": "market_size / ltv_proxy relevés ou inchangés", "rationale": "string"}
  ],
  "hypotheses_status": [
    {"hypothesis": "string", "status": "confirmed | infirmed | still_testing", "basis": "reachability_verdict | profile_classification | signal_dossiers"}
  ],
  "kill_gate_2": {
    "triggered": false,
    "reason": "string ou null - null si segment couvert avec signaux cohérents, ou si encore WAITING_FOR_SIGNALS partout (pas encore tranchable)"
  },
  "human_checkpoint": "Obligatoire avant passage en Phase 3 (Enrichment). Valider en particulier tout confirmed_negative et tout retroactive_kill avant de couper le budget d'enrichissement du segment."
}
```

## Ce que ce document ne couvre pas encore

- `tech_stack_signals` n'a aucun mécanisme de résolution dans le pipeline tel que spécifié aujourd'hui : ni le Signal Aggregator (catégories qui ne le couvrent pas) ni un accès direct du Hypothesis Validator au feed brut du Content Listener. Ce gap reste `open` par construction jusqu'à ce qu'un de ces deux flux soit ajouté. À trancher : soit on ajoute cet accès, soit on accepte que ce gap-là reste non résolu pour le hackathon et on le documente comme limite connue au jury.
- Le critère de deadline retenu (volume uniquement, décision prise plus haut dans la conversation) s'applique de la même façon aux gaps rapides et lents : comptes vérifiés pour les uns, comptes couverts par un dossier Signal Aggregator pour les autres.
