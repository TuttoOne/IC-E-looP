---
name: signal-aggregator-sillage
description: >
  Agrège les signaux détectés par le Content Listener pour chaque compte de la
  Top Account List, les dédoublonne, applique les disqualifiants ICP, calcule
  un signal_score par compte, décide quels contacts déclenchent FullEnrich, et
  prépare le dossier prêt pour le CRM Pusher. Point de décision entre la
  détection de signaux (Content Listener, Stakeholder Mapper) et
  l'enrichissement (Contact Enricher). Utiliser ce skill dès que l'utilisateur
  mentionne : "Signal Aggregator", "agréger les signaux", "prioriser les
  comptes", "quels comptes enrichir", "qualification finale", "scoring des
  comptes", "SIG-03", "avant FullEnrich", ou toute demande consistant à
  transformer plusieurs signaux en décision commerciale. Prérequis : le
  Content Listener a livré son feed de signaux, le Stakeholder Mapper a livré
  sa power map pour le compte, et le score ICP du segment existe (ICP Scoring
  Agent) - même provisoire avec des knowledge_gaps ouverts.
metadata:
  version: 1.0.0
  phase: SIG-03 (Phase 2 - Signal Detection)
  pairs-with: [content-listener-sillage, stakeholder-mapper-sillage, icp-scoring-agent]
  upstream: content-listener-sillage (feed de signaux normalisé), stakeholder-mapper-sillage (power map + verdict reachability), icp-scoring-agent (score du segment, jamais recalculé ici)
  downstream: Contact Enricher (ENR-01, trigger conditionnel par contact), Right Person Validator, CRM Pusher (rosk_signal_score, rosk_signal_type, rosk_signal_date, rosk_signal_source, rosk_deal_summary, rosk_icp_tier)
  changelog: >
    v1.0.0 - fusionne 3 brouillons concurrents (signal-aggregator-sillage,
    signal-aggregator-rosk, icp-qualification-agent-rosk) après test de
    chaînage avec les specs Content Listener, Stakeholder Mapper et ICP
    Scoring Agent. 4 corrections principales : (1) supprime le recalcul d'un
    "ICP Score" par compte, qui dupliquait le Signal Score sous un autre nom
    et confondait deux échelles différentes (0-100 vs 0-5 par critère côté
    ICP Scoring Agent) ; (2) remplace les seuils de score arbitraires comme
    condition de déclenchement FullEnrich par la règle déjà actée en amont
    (2+ signaux sur le contact ET aucun gap reachability ouvert sur le
    segment) ; (3) fait du contrôle des disqualifiants (conflit social,
    lock-in concurrent) une action déclenchée par ce skill plutôt qu'un champ
    supposé déjà rempli, conformément à l'Annexe 2 du Content Listener ;
    (4) retire le hard gate géographique Île-de-France, non confirmé ailleurs
    dans l'architecture, remplacé par un critère de firmographics normal issu
    du segment - à réintroduire en gate dur si le ciblage réel de Rosk le
    confirme.
---

# Signal Aggregator - le moteur de décision commerciale

Le Persona Builder répond à qui on veut cibler. Le Stakeholder Mapper répond
à qui décide réellement. Le Content Listener répond à ce qui se passe en ce
moment. Le Signal Aggregator répond à la dernière question : que fait-on
maintenant.

Ce skill ne détecte aucun signal, ne mappe aucun décideur, ne contacte
personne et ne recalcule jamais le score ICP du segment. Sa seule mission est
de transformer des signaux hétérogènes en une décision commerciale
explicable par compte, et de dire précisément quels contacts méritent un
enrichissement FullEnrich.

## Ce que ce skill ne fait pas

- Il ne calcule pas le score ICP du segment - ça, c'est l'ICP Scoring Agent
  et le Hypothesis Validator. Il le lit comme contexte, jamais comme une
  valeur qu'il produit lui-même.
- Il ne détecte aucun signal - ça, c'est le Content Listener.
- Il ne mappe aucun décideur et ne tranche pas le statut d'un gap
  reachability - ça, c'est le Stakeholder Mapper et le Hypothesis Validator.
- Il ne pousse rien dans le CRM - il prépare les champs, le CRM Pusher écrit.

## Prérequis (vérifier, pas supposer)

1. Le Content Listener a livré son feed de signaux pour le compte (voir son
   contrat de sortie : Compte, Critère ICP, Type détection, Date, Source,
   Poids, Urgency segment indicatif).
2. Le Stakeholder Mapper a livré sa power map pour le compte (decision_role,
   persona_match, level par personne) et, si un gap reachability était
   ouvert, son rapport factuel d'evidence.
3. Le score ICP du segment existe côté ICP Scoring Agent, même provisoire.
   S'il n'existe pas encore, arrêter et rediriger vers l'ICP Scoring Agent -
   ce skill ne doit jamais improviser un score ICP de remplacement.

## Contrat d'entrée

```json
{
  "account": {
    "name": "string",
    "domain": "string",
    "city": "string",
    "site_count": 0
  },
  "segment_context": {
    "segment_id": "string",
    "weighted_total": 0.0,
    "overall_confidence": "high | medium | low",
    "reachability_gap_status": "resolved | open | confirmed_negative | none"
  },
  "stakeholders": [
    {"name": "string", "title": "string", "decision_role": "Decision-maker | Influencer | End user", "level": "groupe | site"}
  ],
  "signals": [
    {"type": "string", "date": "string", "source": "string", "detail": "string", "poids_content_listener": "High | Medium | Low"}
  ],
  "existing_data": {
    "competitor_contract": null,
    "labor_conflict": null
  }
}
```

`weighted_total` reste sur l'échelle 0-5 par critère de l'ICP Scoring Agent,
jamais convertie en score sur 100 : les deux scores (ICP et signal) ne se
mélangent jamais dans une même unité, ils se combinent seulement à l'étape 6.

`existing_data.competitor_contract` et `labor_conflict` peuvent arriver à
`null` : c'est normal, personne en amont ne les détecte automatiquement (voir
étape 2).

## Workflow

### Étape 1 - Charger le contexte

Pour chaque compte : company, segment_context, stakeholders, signals. Si
`signals` est vide, marquer le compte `WAITING_FOR_SIGNALS` et ne rien
déclencher.

### Étape 2 - Vérifier les disqualifiants (action, pas simple lecture)

Le Content Listener le dit explicitement : les disqualifiants ICP ne sont
pas des détections Sillage, aucun agent en amont ne les produit. Si
`existing_data.competitor_contract` ou `labor_conflict` sont `null`, ce skill
déclenche une vérification ciblée (recherche web / connaissance BD) avant
de router le compte plus loin. Ne jamais traiter un `null` comme un `false`.

Disqualifiants durs, s'ils sont confirmés :

- Conflit social ouvert (grève, polémique RH publique) → `REJECT`,
  raison "Labor conflict".
- Lock-in concurrent (contrat staffing concurrent signé < 6 mois) →
  `REJECT`, raison "Competitor lock-in".
- Compte trop petit (site unique et moins de 5 employés) → `REJECT`,
  raison "Too small".

Un compte rejeté ici s'arrête immédiatement, aucun scoring n'est calculé.

Note sur la géographie : aucun autre agent de l'architecture n'impose un
hard gate géographique. Si le ciblage réel de Rosk est aujourd'hui limité à
une zone précise, ce n'est pas un disqualifiant caché mais un critère de
`firmographics` normal du segment (ICP Questioning Agent / ICP Scoring
Agent), pas une règle inventée ici.

### Étape 3 - Normaliser et dédoublonner les signaux

Plusieurs sources peuvent décrire le même événement (Indeed "recherche
serveur", LinkedIn "serveur recherché", site carrière "serveur H/F") : un
seul signal normalisé, avec type, date, source, description conservée pour
le CRM, et confiance. Dix annonces pour le même poste ne valent pas dix
signaux : ça reste un seul signal `recurring_hiring`, renforcé.

### Étape 4 - Classer les signaux

Catégories Rosk : Recurring Hiring, New Site Opening, Seasonal Hiring Burst,
Leadership Change, Competitor Engagement, Funding / Expansion, Negative
Signal, Unknown. Un signal qui ne rentre dans aucune catégorie connue est
classé Unknown, jamais supprimé.

### Étape 5 - Calculer le signal_score du compte

Poids par catégorie (indépendant du poids High/Medium/Low du Content
Listener, qui mesure la fiabilité de détection, pas la valeur commerciale
du type de signal - les deux sont volontairement dans des espaces
différents) :

Recurring Hiring +30, New Site Opening +30, Seasonal Hiring Burst +15,
Leadership Change +15, Competitor Engagement +15, Funding / Expansion +10.

Multiplicateur de fraîcheur : moins de 7 jours ×1.5, 7-30 jours ×1.2, 30-90
jours ×1, plus de 90 jours ×0.5.

Multiplicateur de confiance, dérivé du poids Content Listener plutôt que
d'une table de sources séparée (pour ne pas dupliquer une classification déjà
faite en amont) : High ×1.5, Medium ×1.2, Low ×0.8.

Bonus d'accumulation par nombre de catégories différentes détectées (pas le
nombre brut de signaux) : 2 catégories +10, 3 catégories +25, 4 ou plus +40.

`signal_score = min(100, Σ(poids catégorie × fraîcheur × confiance) + bonus accumulation)`

### Étape 6 - Combiner avec le contexte ICP (sans jamais fusionner les échelles)

Le score ICP du segment (`weighted_total`, 0-5) reste une donnée de contexte,
jamais recalculée ni convertie de force en pourcentage. La priorité
commerciale du compte se lit comme une combinaison qualitative des deux :

- `overall_confidence` bas ou gap reachability encore `open` → le compte
  peut avoir un signal_score élevé, mais reste marqué provisoire : pas de
  budget d'enrichissement tant que le gap n'est pas fermé (voir étape 7).
- `weighted_total` élevé et `signal_score` élevé → Very High.
- `weighted_total` moyen et `signal_score` élevé → High.
- `weighted_total` élevé et `signal_score` faible → Medium (bon ICP, pas
  d'urgence).
- Le reste → Low, ou Discard si `signal_score` sous 25 sans aucun signal
  positif.

### Étape 7 - Décider le déclenchement FullEnrich (règle déjà actée, pas un nouveau seuil)

Le déclenchement d'un enrichissement FullEnrich ne suit pas un seuil de
score inventé ici. Il suit la règle déjà fixée dans le spec ICP Scoring
Agent et dans le diagramme d'architecture : les deux conditions suivantes
doivent être vraies ensemble, pour un contact donné parmi ceux recommandés
par le Stakeholder Mapper.

1. Le compte porte 2 signaux ou plus, de catégories différentes.
2. `reachability_gap_status` du segment n'est pas `open` (donc `resolved`,
   `confirmed_negative` traité selon la règle du Hypothesis Validator, ou
   `none` si aucun gap n'existait).

Si les deux conditions tiennent : `READY_FOR_ENRICHMENT` pour les 1 à 3
contacts recommandés par le Stakeholder Mapper (le Decision-maker niveau
groupe en priorité). Sinon : `WATCHLIST`, le compte reste suivi mais aucun
crédit FullEnrich n'est consommé.

### Étape 8 - Construire le dossier de sortie

```
## Signal Aggregator - COMPTE

Decision:
READY_FOR_ENRICHMENT / WATCHLIST / LOW_PRIORITY / REJECT

signal_score:
XX/100

Priorité commerciale:
Very High / High / Medium / Low / Discard

Contexte ICP segment (lu, pas recalculé):
weighted_total: X.X/5 - overall_confidence: ... - reachability_gap: ...

Signaux retenus:
- catégorie - date - description courte

Raisonnement:
2-3 phrases, un commercial doit comprendre en moins de 10 secondes pourquoi
ce compte est prioritaire ou non.

Contacts recommandés pour FullEnrich:
1. nom - titre - decision_role
2. ...

Champs CRM:
rosk_signal_score:
rosk_signal_type:
rosk_signal_date:
rosk_signal_source:
rosk_deal_summary:
rosk_icp_tier:
```

## Golden rules

1. Un signal isolé n'est jamais une intention d'achat.
2. Plusieurs catégories de signaux cohérentes valent plus qu'un seul signal
   répété.
3. La récence compte : un signal de plus de 90 jours pèse la moitié.
4. Le score ICP du segment et le signal_score du compte ne se mélangent
   jamais dans une même unité - ils se lisent ensemble, pas fusionnés.
5. Aucun enrichissement FullEnrich sans 2+ signaux sur le contact ET gap
   reachability fermé - jamais sur la seule base d'un score.
6. Les disqualifiants battent toujours le score, et ne sont jamais supposés
   déjà vérifiés : ce skill déclenche la vérification s'ils sont absents.
7. Un signal Unknown n'est jamais supprimé.

## Exemple travaillé

Compte : groupe-gastroparis-exemple.fr (11 sites après détection de groupe
par le Stakeholder Mapper).

Signaux : `jobPostingKeywordDetection` ×3 sur 3 semaines (Recurring Hiring,
poids Content Listener High), `keywordDetection` "ouverture prochaine"
(New Site Opening, poids High).

Calcul : Recurring Hiring 30 × 1.5 (moins de 7 jours) × 1.5 (confiance High)
= 67.5. New Site Opening 30 × 1.2 × 1.5 = 54. Bonus 2 catégories +10.
signal_score = 100 (plafonné).

Contexte ICP segment : weighted_total 4.2/5, overall_confidence high,
reachability_gap_status resolved (DRH Groupe identifié par le Stakeholder
Mapper).

Décision : les deux conditions de l'étape 7 sont réunies (2+ catégories de
signaux, gap fermé) → READY_FOR_ENRICHMENT pour DRH Groupe et Directeur des
Opérations. Priorité commerciale : Very High.

## Ce que ce skill ne fait pas (rappel)

- Détecter des signaux → Content Listener.
- Mapper des décideurs ou trancher un gap reachability → Stakeholder Mapper,
  Hypothesis Validator.
- Calculer ou recalculer le score ICP du segment → ICP Scoring Agent.
- Enrichir des coordonnées → Contact Enricher / FullEnrich.
- Pousser dans HubSpot → CRM Pusher.
