# Schéma persona Sillage — champs exacts et règles d'écriture

Source : skill officiel `sillage-onboarding` (sillage-labs/skills) + `write-semantics.md` de
`sillage-manage-workspace`. Valeurs vérifiées contre le MCP v2. Envoyer une valeur hors enum =
rejet garanti.

## Les 7 champs de `sillage_v2_upsert_persona` — et RIEN d'autre

| Champ | Type | Contraintes |
|---|---|---|
| `job_title` | string[] | Titres à INCLURE. Envoyer le set étendu de variantes, pas un titre unique |
| `exclude_job_title` | string[] | Titres à EXCLURE — filtre le bruit d'un include large |
| `seniority` | string[] | Enum strict : `owner`, `founder`, `c_suite`, `partner`, `vp`, `head`, `director`, `manager`, `senior`, `entry`, `intern` |
| `headcount` | string[] | Enum strict AVEC virgules des milliers : `"1-10"`, `"11-50"`, `"51-200"`, `"201-500"`, `"501-1,000"`, `"1,001-5,000"`, `"5,001-10,000"`, `"10,001+"`. `"501-1000"` (sans virgule) ou `"5000+"` (bucket inventé) → rejeté |
| `industry` | string[] | Termes anglais standards : `"SaaS"`, `"Restaurants"`, `"Hospitality"`, `"FinTech"`... |
| `location` | string[] | Pays ou villes : `"France"`, `"Paris"`, `"Germany"`. PAS de régions administratives (une contrainte type Île-de-France se gère par villes + `additional_info`) |
| `additional_info` | string | Logique de qualification non structurable : disqualifiants, contraintes métier. Nourrit aussi la génération de contenu — un persona maigre = contenu générique |

⚠️ **Champ inconnu = persona effacé.** Envoyer une clé non documentée (ex. `name`) retourne un
200 et **vide le persona entier**. Comportement observé en production, documenté par Sillage.
Valider chaque clé de l'objet contre la liste ci-dessus avant l'appel.

## Sémantique PUT — le piège n°1

`upsert_persona` **remplace l'objet entier à chaque appel**. Ce n'est pas un patch. Un objet
partiel efface tous les champs omis.

Pattern obligatoire :

```
current = sillage_v2_get_persona()
next = { ...current, <tes modifications sur l'objet COMPLET> }
sillage_v2_upsert_persona(next)   # objet complet, champs documentés uniquement
relire = sillage_v2_get_persona() # vérifier champ par champ
```

Il n'y a qu'UN persona par workspace : pas d'id à cibler, pas de collection "personas".

## Top accounts — append-only

- `add_top_accounts` **ajoute** (pas d'outil "remplacer la liste"). Ré-ajouter un compte déjà
  présent est inoffensif mais churne l'ingestion pour rien → dédupliquer d'abord via
  `read_top_account_list`
- Identifier par **domaine** de préférence (matche mieux qu'une URL LinkedIn)
- `remove_top_accounts` est destructif — ids numériques lus depuis `read_top_account_list`,
  jamais devinés
- L'ajout **enfile une ingestion** : poller `get_top_account_list_status` jusqu'à `completed`
  avant d'attendre couverture ou contenu

## Couverture — trigger explicite, jamais automatique

- `enrich_company` (par domaine) **démarre** un mapping et retourne immédiatement. Le mapping
  n'est lisible qu'au stage `completed` — un "not found" avant, c'est normal
- Idempotent : relancer réutilise la même requête, pas de doublon
- La couverture ne se reconstruit **PAS** quand le persona change → après tout élargissement
  ou remodelage du persona, re-trigger `enrich_company` sur les comptes à re-mapper
- Le `request_id` retourné = le `mapping_id` de `get_company_mapping`

## Jamais de delete-and-recreate

- Recréer un agent mint un nouvel id et orpheline sa watchlist (churn réel observé :
  agent 1416 → 2191, watchlist 17 → 18 → 19). Éditer avec `configure_agent`
- Re-upsert du persona à l'identique = churn sans bénéfice
- Remove + re-add d'un compte n'est PAS un refresh — le mapping des personnes est un
  `enrich_company` séparé que le re-add ne déclenche pas

## Erreurs fréquentes

| Erreur | Réponse |
|---|---|
| `Invalid input...` | Corps invalide — revérifier noms/types/enums, corriger, réessayer |
| `Resource not found...` | Mauvais id OU record pas encore prêt (mapping en vol) |
| `403` | Feature non activée sur le workspace — remonter à l'utilisateur, NE PAS réessayer |
| `429` | Back-off, respecter `retry_after` |
