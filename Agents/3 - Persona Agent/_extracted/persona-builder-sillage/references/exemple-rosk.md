# Exemple travaille - segment ICP-01/ICP-02 vers persona Sillage

Cas reel : Rosk, staffing digital pour restauration/hotellerie. Reprend le
segment "Restaurant groups 5+ sites, Paris region" tel que sorti d'ICP-02
dans `icp-scoring-agent-spec.md` (section "Worked example"), pour montrer
le cycle complet y compris le feedback reachability de l'Etape 7.

## Les deux objets recus en entree (resumes)

icp01_segment.dimensions :
- firmographics : "Groupes de restauration, 5+ sites, region parisienne"
- tech_stack_signals : "Utilise deja un logiciel de planning mais pas de
  solution de remplacement d'urgence"
- buyer_persona : "Directeur des Operations ou DRH selon la taille du
  groupe, decision rarement individuelle" (thin, mais present)
- jtbd : "Trouver un remplaçant qualifie en salle ou cuisine sous 48h"
- existing_alternatives : "Agences generalistes lentes, reseau perso"
- trigger_events : "Arret maladie non prevu, pic saisonnier, ouverture
  recente de site"
- budget_authority : "Le directeur des operations arbitre en dessous d'un
  seuil, sinon DG"
- reachability : "Hypothese : LinkedIn et reseaux pro restauration, jamais
  confirme sur des comptes reels"

icp02_scoring_entry.scores : market_size 4 (high), urgency 4 (high),
reachability unscoreable, ltv_proxy 4 (high). overall_confidence : medium.

icp02_scoring_entry.knowledge_gaps :
```json
[{"dimension": "reachability", "why_it_matters": "aucun canal confirme sur un compte reel", "resolve_via": "Persona Builder / Stakeholder Mapper", "status": "open", "resolution_deadline": "1 week or 10 accounts checked"}]
```

top_accounts : 12 domaines fournis par le fondateur.

## Etape 2 - Mapping champ par champ

| Decision | Raisonnement |
|---|---|
| `location: ["Paris", "La Defense", "Boulogne-Billancourt", "Saint-Denis", "Versailles", "Creteil", "Nanterre"]` | Derive de `firmographics` ("region parisienne"). Sillage ne connait pas "Ile-de-France", on liste les villes ET on repete la contrainte en `additional_info` |
| `industry: ["Restaurants", "Hospitality", "Food & Beverages"]` | Derive de `firmographics`, termes anglais standards |
| `headcount: ["51-200", "201-500", "501-1,000"]` | Derive de "5+ sites" dans `firmographics` - un groupe 5+ sites en restauration tombe rarement sous 50 salaries. Virgule des milliers obligatoire dans `"501-1,000"` |
| `job_title` / `seniority` | Point de depart : `buyer_persona` donne deja "Directeur des Operations ou DRH" et `budget_authority` confirme "DG" au-dessus d'un seuil. Ce n'est PAS un trou absent, juste un texte a etendre (Etape 3) |
| `additional_info` | Recoit `jtbd`, `tech_stack_signals` (contexte concurrentiel), et la contrainte geo repetee |

## Etape 3 - L'interview de comblement (exemple reel)

> "Ton segment donne deja Directeur des Operations, DRH, et DG comme
> decideurs potentiels selon la taille. Je propose d'etendre : **Directeur
> des Operations / Ops Director, DRH / HR Director, Directeur de Reseau,
> Responsable Recrutement / Talent Acquisition Manager, DG / Managing
> Director** pour les groupes ou la decision est centralisee. Faut-il
> exclure les **managers de site individuels** (bruit probable : ils
> recrutent mais ne signent pas) ?"

Reponse type -> `exclude_job_title: ["Restaurant Manager", "Store Manager", "Chef de rang"]`.

Aucun disqualifiant structure n'apparait dans les 8 dimensions -> demander
explicitement : "Y a-t-il des criteres qui excluent un compte d'office
(conflit social en cours, contrat concurrent recent, taille minimale) ?"

## L'objet final envoye (apres GET + merge + GO humain)

```json
{
  "job_title": ["Directeur des Operations", "Operations Director", "Head of Operations",
                "DRH", "HR Director", "Directeur des Ressources Humaines",
                "Directeur de Reseau", "Responsable Recrutement",
                "Talent Acquisition Manager", "Directeur General", "Managing Director"],
  "exclude_job_title": ["Restaurant Manager", "Store Manager", "Chef de rang"],
  "seniority": ["c_suite", "vp", "head", "director"],
  "headcount": ["51-200", "201-500", "501-1,000"],
  "industry": ["Restaurants", "Hospitality", "Food & Beverages"],
  "location": ["Paris", "La Defense", "Boulogne-Billancourt", "Saint-Denis",
               "Versailles", "Creteil", "Nanterre"],
  "additional_info": "Contrainte : groupes physiquement implantes en region parisienne (Paris + petite/grande couronne). Cible : groupes multi-sites (5+ sites de preference) avec logiciel de planning existant mais sans solution de remplacement d'urgence. JTBD : trouver un remplaçant qualifie en salle ou cuisine sous 48h. Priorite aux comptes montrant des signaux actifs de penurie de personnel."
}
```

Note : contrairement a un ancien format de doc ICP libre, il n'y a pas de
bloc "criteres de scoring pondere" a exclure explicitement du persona ici
- `trigger_events` et `existing_alternatives` n'ont simplement jamais ete
des candidats pour les champs persona, ils partent directement dans la
table de handoff (Etape 6).

## Etape 6 - La table de handoff produite

urgency.value = 4 -> poids High pour les signaux derives de trigger_events.

| Source (poids derive d'urgency=4 -> High) | Type d'agent | Parametres proposes |
|---|---|---|
| trigger_events : arret maladie / pic saisonnier | `job_posting_keyword_detection` | keywords = roles recrutes : "cuisinier", "commis de cuisine", "serveur", "chef de partie", "plongeur" |
| trigger_events : ouverture de site | `keyword_detection` | "ouverture", "nouveau restaurant", "nouvelle adresse", "opening soon" |
| existing_alternatives : agences generalistes concurrentes | `competitor` (watchlist) | entites : plateformes de staffing rivales - URLs LinkedIn de preference |

## Etape 7 - Couverture declenchee, rapport preliminaire (nouveau, declenche ici)

Le knowledge_gap reachability est ouvert -> cette etape s'execute. Sur les
12 comptes de `top_accounts`, l'Etape 5.7 declenche `enrich_company` sur
chacun. Ce skill s'arrete la : il ne classe pas les profils, ne conclut
rien sur la reachability.

Signalement interne, explicitement preliminaire (jamais transmis au
Hypothesis Validator) :

```
Couverture enrich_company declenchee sur 12/12 comptes de top_accounts.
Detection de groupe et verdict reachability : a produire par le
Stakeholder Mapper.
```

C'est le Stakeholder Mapper qui prend le relais a partir d'ici : sur ces
12 comptes, il applique sa detection de groupe a 4 indices et sa
classification des profils. Dans le cas reel documente par
`Stakeholder_Mapper_Sillage.md` (exemple GastroParis), c'est exactement
ce sequencement qui evite le faux negatif : le compte visible
(`brasserie-lipp-exemple.fr`) montre peu de profils exploitables au
premier regard, mais le Mapper detecte que c'est une filiale d'un groupe
de 11 enseignes et trouve le DRH Groupe apres avoir mappe le domaine
parent. Un verdict emis a l'Etape 7 de ce skill, avant cette detection,
aurait pu conclure a tort que le compte etait injoignable.

Le rapport final (evidence + statut du gap) est produit et route au
Hypothesis Validator par le Stakeholder Mapper, pas par ce skill.
