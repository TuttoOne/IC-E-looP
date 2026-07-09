---
name: persona-builder-sillage
description: >
  Transforme la sortie native du pipeline ICP Discovery (segment ICP-01 a 8
  dimensions + scoring ICP-02 avec knowledge_gaps) en persona Sillage
  configure et execute via MCP, avec checkpoint humain obligatoire avant
  toute ecriture. Produit la table de mapping signaux vers agents qui sert
  d'entree au Content Listener et au Signal Aggregator, et declenche la
  couverture (enrich_company) necessaire a la resolution du gap
  reachability - le verdict reachability lui-meme est produit par le
  Stakeholder Mapper apres detection de groupe, jamais par ce skill.
  Utiliser ce skill des que l'utilisateur mentionne : "Persona
  Builder", "configurer le persona Sillage", "traduire le segment retenu en
  persona", "pousser le segment dans Sillage", "SIG-01", ou fournit un
  segment retenu par ICP-02 a operationnaliser dans Sillage - meme s'il ne
  dit pas explicitement "persona". Ne PAS utiliser pour une interview ICP
  from scratch (c'est sillage-onboarding) ni pour de la maintenance de
  workspace existant.
metadata:
  version: 2.1.0
  phase: SIG-01 (Phase 2 - Signal Detection)
  pairs-with: [sillage-onboarding, sillage-manage-workspace, stakeholder-mapper-sillage]
  upstream: ICP-02 Scoring Agent (segment dans segments_retained, kill_gate_1 non declenche) + segment ICP-01 correspondant
  downstream: Content Listener (poids derive d'urgency transmis a titre indicatif uniquement, autorite finale cote Content Listener - voir sa taxonomie), Signal Aggregator, Stakeholder Mapper (ce skill declenche la couverture, le Mapper produit le verdict reachability et le route au Hypothesis Validator)
  changelog: >
    v2.1.0 - integre 3 retours d'un check anterieur. (1) sequencement :
    l'Etape 7 ne produit plus un rapport route au Hypothesis Validator,
    elle s'arrete a "couverture declenchee" et devient explicitement
    preliminaire - le verdict reachability n'est emis qu'apres detection
    de groupe par le Stakeholder Mapper, ce qui elimine structurellement
    le cas ou un compte visible semble injoignable alors que son parent
    ne l'est pas (cas GastroParis). (2) ajoute la procedure de
    re-invocation quand le Stakeholder Mapper propose une mise a jour du
    persona suite a une decouverte de groupe (le headcount du parent
    invalide le persona) - passe toujours par GET->merge->PUT (Etape 5),
    jamais duplique ailleurs. (3) clarifie que la requalification de tier
    et le re-score market_size/ltv_proxy ne sont pas le travail de ce
    skill ni du Stakeholder Mapper seul, mais du Hypothesis Validator, qui
    la recoit en input flague plutot que de la construire en boucle
    formelle.
    v2.0.0 - reecrit pour consommer nativement le schema JSON ICP-01/ICP-02
    (8 dimensions + scores) au lieu d'un doc ICP libre type "Rosk ICP
    Profile". Ajoute l'etape 7 (feedback reachability vers Hypothesis
    Validator), corrige l'hypothese "buyer_persona absent" (le champ existe
    dans ICP-01, il est juste souvent thin), et derive les poids de
    signaux depuis le score urgency d'ICP-02 au lieu d'un bloc "criteres de
    scoring High/Medium/Low" qui n'existe plus en amont.
---

# Persona Builder - du segment ICP-01/ICP-02 au persona Sillage execute

Tu reçois deux objets produits par le pipeline ICP Discovery, jamais un
document ICP libre :

1. Le segment ICP-01 (8 dimensions : firmographics, tech_stack_signals,
   buyer_persona, jtbd, existing_alternatives, trigger_events,
   budget_authority, reachability, plus hypotheses_to_test)
2. L'entree correspondante dans la sortie d'ICP-02 (scores sur 4 criteres,
   knowledge_gaps, overall_confidence, kill_gate_1, rationale)

Tu dois produire un persona Sillage **hybride** : champs entreprise
(`industry`, `headcount`, `location`) ET champs personne (`job_title`,
`seniority`). C'est la difficulte centrale de ce skill : le schema ICP-01
documente precisement le compte mais reste souvent thin sur les decideurs.
Ton travail est de combler ce fossé sans inventer, d'ecrire dans Sillage
sans rien casser, puis de rapporter au pipeline amont ce que tu as trouve
sur la reachability.

Un persona faible empoisonne silencieusement tout l'aval : les agents
detectent du bruit, le contenu genere est generique, le Signal Aggregator
score n'importe quoi. Prends le temps de bien faire cette etape.

## Prerequis

Lis `references/sillage-persona-schema.md` AVANT toute ecriture MCP - il
contient les valeurs d'enum exactes (rejet garanti si approximatives) et
les semantiques d'ecriture qui evitent de detruire le workspace. Lis
`references/exemple-rosk.md` pour voir un mapping complet travaille sur
le schema natif du pipeline.

## Contrat d'entree

```json
{
  "icp01_segment": {
    "segment_id": "string",
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
    "hypotheses_to_test": ["string"]
  },
  "icp02_scoring_entry": {
    "segment_id": "string (doit matcher icp01_segment.segment_id)",
    "scores": {
      "market_size": {"value": 0, "confidence": "string"},
      "urgency": {"value": 0, "confidence": "string"},
      "reachability": {"value": 0, "confidence": "string"},
      "ltv_proxy": {"value": 0, "confidence": "string"}
    },
    "overall_confidence": "string",
    "knowledge_gaps": [
      {"dimension": "string", "why_it_matters": "string", "resolve_via": "string", "status": "string", "resolution_deadline": "string"}
    ],
    "rationale": "string"
  },
  "top_accounts": ["string - domaines, 10-20 comptes, input fondateur"]
}
```

Regle dure avant de commencer : verifier que `icp01_segment.segment_id`
apparait bien dans `segments_retained` de la sortie ICP-02 complete (pas
seulement present dans `ranking`). Un segment tue par Kill Gate 1 ne doit
jamais atteindre ce skill - si c'est le cas, arreter et signaler l'erreur
en amont plutot que produire un persona pour un segment mort.

## Workflow en 8 etapes

### Etape 1 - Parser les deux objets d'entree

Extraire les 8 dimensions ICP-01, les 4 scores ICP-02, et surtout la liste
`knowledge_gaps`. Un knowledge_gap avec `dimension: "reachability"` et
`resolve_via` mentionnant Persona Builder ou Stakeholder Mapper est le
signal le plus important de cette etape - il determine si l'Etape 7 aura
du contenu a rapporter.

### Etape 2 - Mapper vers les champs persona

| Dimension ICP-01 | Champ Sillage | Regle |
|---|---|---|
| `firmographics` | `headcount`, `industry`, `location` | Extraire taille, secteur, geo. Si une contrainte d'exclusion geographique infra-nationale apparait (ex. Ile-de-France), lister les villes couvertes ET repeter la contrainte en `additional_info` - Sillage ne connait pas les regions administratives |
| `buyer_persona` | `job_title` + `seniority` | Point de vigilance : ce champ existe deja dans ICP-01, il n'est **pas absent** par defaut. Souvent thin ("Gerant, decision rapide") - partir de ce texte et l'etendre (voir Etape 3), ne pas repartir de zero comme si le champ n'existait pas |
| `budget_authority` | `seniority` (recoupement) | Qui controle la depense confirme ou contredit la seniority deduite de `buyer_persona` |
| `existing_alternatives` | `additional_info` + candidats pour la table de handoff (agent `competitor`) | Alternatives nommees = watchlist concurrents potentielle |
| `trigger_events` | **PAS le persona** -> table de handoff (Etape 6) | C'est la source primaire des signaux a detecter, remplace le bloc "criteres de scoring ponderes" qui n'existe plus dans ce schema |
| `tech_stack_signals` | **PAS le persona** -> contexte pour Content Listener uniquement | Ne pas gaver `additional_info` avec ca - c'est un signal de positionnement/concurrence, pas un critere de qualification |
| `jtbd` | `additional_info` (contexte) | Nourrit la generation de contenu, pas un champ structure |
| `reachability` (texte ICP-01) + score ICP-02 | `location`/`additional_info` + declenche Etape 7 si gap ouvert | Si `knowledge_gaps` contient reachability, ce champ est justement ce que tu dois aller verifier, pas seulement retranscrire |

Note sur les disqualifiants : le schema ICP-01/ICP-02 n'a pas de champ
"disqualifiants automatiques" dedie (contrairement a un ancien format de
doc ICP libre). Un disqualifiant reel (conflit social, contrat concurrent
recent, taille minimale) doit etre soit deductible de `existing_alternatives`
ou `firmographics`, soit demande explicitement en Etape 3 s'il n'est nulle
part dans les 8 dimensions. Ne jamais l'omettre silencieusement : un
disqualifiant manquant fausse tout le scoring du Signal Aggregator en aval.

Note sur les tiers de comptes : pas de champ dedie non plus. Les tiers
(T1 groupe national, T2 chaine regionale, T3 independant) se deduisent en
croisant `firmographics` avec la liste `top_accounts` fournie par le
fondateur, a confirmer en Etape 3 si ambigu.

### Etape 3 - Detecter les trous et interviewer (une question a la fois)

Le schema ICP-01 omet presque toujours : la distinction decideur/champion/
utilisateur, les exclusions de titres, les disqualifiants non couverts par
les 8 dimensions, et parfois les tiers de comptes. Il ne omet PAS forcement
buyer_persona en tant que tel - traite-le comme thin a etendre, pas comme
absent.

- **Proposer, ne pas collecter** : partir du texte existant dans
  `buyer_persona` et `budget_authority`, puis proposer l'echelle etendue
  ("le doc mentionne Gerant/Directeur de salle - je propose d'ajouter
  Directeur des Operations, DRH, Responsable Recrutement - et faut-il
  exclure les managers de site individuels ?").
- **Une seule question par tour.** Dix questions d'un coup = dix reponses
  superficielles.
- **Si un disqualifiant plausible n'apparait dans aucune des 8 dimensions**,
  le demander explicitement plutot que de le supposer absent du segment.

### Etape 4 - CHECKPOINT HUMAIN (obligatoire, jamais saute)

Relire le persona complet en langage clair, champ par champ, AVANT tout
appel d'ecriture :

```
## Persona pret a ecrire
Titres inclus : ...        Titres exclus : ...
Seniorite : ...            Effectifs : ...
Secteurs : ...             Localisations : ...
Additional info : "..."

## Ce que j'ai deduit (a valider) : ...
## Ce qui vient tel quel des dimensions ICP-01 : ...
## Gap reachability signale par ICP-02 : ouvert / absent
-> GO pour ecrire dans Sillage ?
```

Distinguer explicitement le deduit du source. Ne JAMAIS ecrire sans un GO
explicite.

### Etape 5 - Executer via MCP (dans cet ordre exact)

1. `sillage_v2_get_persona` - TOUJOURS lire d'abord, meme si le workspace
   semble vierge
2. Merger : objet complet = existant + modifications. `upsert_persona` a
   une semantique PUT - un objet partiel EFFACE les champs omis
3. `sillage_v2_upsert_persona` avec UNIQUEMENT les 7 champs documentes. Un
   champ inconnu (ex. `name`) retourne 200 et **vide le persona entier** -
   bug documente, pas une hypothese
4. Relire avec `get_persona` et verifier champ par champ que l'ecriture
   correspond
5. Si `top_accounts` fourni : `sillage_v2_add_top_accounts` (append-only -
   dedupliquer d'abord contre `read_top_account_list` ; identifier par
   **domaine** de preference)
6. Poller `get_top_account_list_status` jusqu'a `completed`
7. `enrich_company` sur chaque compte prioritaire - la couverture ne se
   construit PAS toute seule apres l'ajout, et ne se rafraichit PAS apres
   un changement de persona. C'est un trigger : poller jusqu'a `completed`
   ("not found" en cours de route est normal)

**Interdits absolus** : delete-and-recreate pour "rafraichir" (orpheline
les watchlists) ; re-upsert du meme persona (churn inutile) ; remove+re-add
d'un compte comme "refresh".

### Etape 6 - Handoff vers Content Listener et Signal Aggregator

Clore avec la table de mapping signaux vers agents, derivee de
`trigger_events` et `existing_alternatives`. Le poids de chaque signal se
derive du score `urgency` d'ICP-02 (pas d'un bloc High/Medium/Low separe
qui n'existe plus en amont) : `urgency.value` 4-5 = High, 2-3 = Medium,
0-1 = Low. Si `urgency` est `unscoreable`, marquer le poids "a confirmer
par Signal Aggregator" plutot que d'en inventer un.

```
## Table de handoff - signaux ICP-01/02 vers agents Sillage

| Source (dimension, poids derive d'urgency) | Type d'agent | Parametres proposes |
|---|---|---|
| trigger_events (poids X) | job_posting_keyword_detection | tracking_keywords: [...] |
| existing_alternatives (poids X) | competitor (watchlist) | entites a ajouter : [...] |
| ... | ... | ... |

## Disqualifiants a réappliquer par le Signal Aggregator
<rappel des disqualifiants identifies en Etape 2/3 - Sillage ne les
connait pas, c'est le Signal Aggregator qui devra forcer le score a 0 avec>
```

Correspondances types : embauches recurrentes / burst saisonnier ->
`job_posting_keyword_detection` (keywords = les roles recrutes, pas le
langage de la douleur) ; ouverture de site / levee de fonds ->
`keyword_detection` sur posts LinkedIn ; changement de direction ->
`job_update` (sans parametres, opere sur les contacts mappes - d'ou
l'importance de l'enrichissement en Etape 5) ; engagement concurrent ->
agent `competitor` avec watchlist.

Note d'autorite sur le poids : le poids derive d'urgency ci-dessus est
transmis au Content Listener a titre indicatif uniquement. Le Content
Listener a sa propre table de traduction, fixe par type de detection
(`references/taxonomie-et-handoff.md` cote Content Listener), et c'est
elle qui fait foi dans le feed final livre au Signal Aggregator - pas ce
poids-ci. Un segment a urgency=4 peut tres bien produire un signal
"Competitor engagement" livre a poids Medium malgre tout : ce n'est pas
une incoherence, c'est la regle de preseance du Content Listener qui
s'applique.

### Etape 7 - Couverture declenchee, rapport preliminaire (pas un verdict)

Cette etape ne s'execute que si `knowledge_gaps` (recu en entree) contient
une entree `dimension: "reachability"` avec `resolve_via` mentionnant
Persona Builder ou Stakeholder Mapper. Sinon, passer directement a la
sortie finale.

Changement important : ce skill **s'arrete a la couverture declenchee**.
Il ne produit plus de rapport route au Hypothesis Validator. La raison :
`enrich_company` sur le domaine visible d'un compte (Etape 5.7) ne voit
souvent qu'une partie de la structure reelle - un compte qui semble sans
decideur accessible peut tres bien etre la filiale d'un groupe dont le
parent, une fois detecte, a un DRH Groupe injoignable... jusqu'a ce que
le Stakeholder Mapper le trouve. Un verdict emis a ce stade-ci serait
premature et pourrait faire declarer "confirmed_negative" un compte qui
ne l'est pas (cas type : GastroParis, voir `references/exemple-rosk.md`).

Ce que ce skill fait donc a l'Etape 7 :

1. Verifier que `enrich_company` a bien ete declenche (Etape 5.7) sur les
   comptes prioritaires du segment
2. Produire, si utile pour le suivi interne, un signalement **explicitement
   preliminaire** de ce qui a ete vu a ce stade (ex. "couverture
   declenchee sur N comptes, en attente de detection de groupe") - ce
   signalement n'est **jamais** transmis au Hypothesis Validator et ne
   contient aucun champ `status`, `decision_makers_found` ou `evidence`
   pretendant trancher la reachability
3. S'arreter la. Le verdict reachability (evidence + decision sur le
   statut du gap) est produit par le **Stakeholder Mapper**, apres sa
   propre detection de groupe (4 indices) et sa classification des
   profils - c'est lui qui route ce rapport au Hypothesis Validator, pas
   ce skill

Ce sequencement (couverture par ce skill, verdict par le Stakeholder
Mapper seulement apres detection de groupe) elimine structurellement le
faux negatif du cas GastroParis, sans ajout de synchronisation entre les
deux skills : chacun a une propriete claire et non chevauchante sur le
gap reachability.

### Etape 8 - Re-invocation ciblee : mise a jour du persona demandee par le Stakeholder Mapper (nouveau)

Le Stakeholder Mapper a deja un checkpoint humain au moment ou il decouvre
un groupe parent (proposition d'ajout a la top account list). Ce
checkpoint porte desormais aussi la question : "le headcount reel du
groupe invalide-t-il le persona actuel ?" (ex. persona configure sur
`headcount: ["51-200"]` alors que le parent decouvert fait `"501-1,000"`).

Si l'humain valide la mise a jour a ce checkpoint-la, elle **repasse
toujours par ce skill**, jamais par un upsert fait directement depuis le
Stakeholder Mapper : celui-ci n'a pas la procedure GET->merge->PUT de
l'Etape 5, et un upsert partiel envoye sans elle efface le persona (bug
documente, voir `references/sillage-persona-schema.md`). Concretement,
sur re-invocation pour ce motif :

1. `sillage_v2_get_persona` (etat courant)
2. Merger uniquement le champ concerne (typiquement `headcount`, parfois
   `industry`/`location` si le parent change aussi la geo) sur l'objet
   complet - ne pas repartir de zero sur les autres champs
3. `sillage_v2_upsert_persona` avec l'objet complet mis a jour
4. Relire et confirmer le changement

Pas de boucle automatique : c'est une proposition au checkpoint existant
du Mapper, validee par l'humain, executee par ce skill. Rien de plus -
automatiser le sens "detection groupe -> re-ecriture persona" serait
risque sous pression de hackathon pour un gain marginal.

## Ce que ce skill ne fait PAS

- Interview ICP complete depuis zero -> `sillage-onboarding`
- Creation des agents de detection -> phase Content Listener (mais il en
  livre la spec)
- Scoring des signaux -> Signal Aggregator (mais il en livre les poids
  derives, a titre indicatif seulement - voir Etape 6)
- Decider qu'un knowledge_gap reachability est resolu ou confirme negatif
  -> Stakeholder Mapper produit le verdict (apres detection de groupe) et
  le route au Hypothesis Validator ; ce skill ne fait que declencher la
  couverture (Etape 7)
- Requalifier un tier de compte (ex. T3 apparent -> T2 reel via
  `rosk_site_count`) ou re-scorer `market_size`/`ltv_proxy` en
  consequence -> ce n'est le travail ni de ce skill ni du Stakeholder
  Mapper seul. Le Mapper flague deja la requalification dans sa sortie ;
  cette ligne est adressee au Hypothesis Validator, dont c'est le role
  (confirmer/infirmer les hypotheses). Construire une boucle de re-score
  formelle maintenant irait a l'encontre de la regle de sequencement du
  pipeline (pas de Phase 5 avant que les Phases 1-3 tournent) - a
  mentionner verbalement au jury plutot qu'a implementer avant le
  hackathon
- Maintenance / edition d'un workspace mur -> `sillage-manage-workspace`

## Related skills

- `ideal-customer-profile` - dimensions et tests de specificite utilises
  en amont par ICP-01
- Architecture complete : voir `icp-agent-architecture.html` (diagramme
  Phase 1-6)
- Contrat de sortie ICP-02 : voir `icp-scoring-agent-spec.md`, section
  "Gap resolution mechanism (Phase 2)" pour la logique complete de
  deadline et de kill retroactif
