# Backend change needed: `POST /api/prospects`

IC(E)looP's delivery step creates a prospect from a Sillage-sourced, FullEnrich-verified lead.
The tsplus-outreach FastAPI backend currently has **no generic create-prospect endpoint** —
prospects can only be created from Leadinfo companies
(`POST /api/leadinfo/companies/{id}/create-prospect`). IC(E)looP leads are **not** Leadinfo
companies, so we need a plain create route.

This is the **only** backend change required. Everything else the adapter uses already exists
(`GET /api/prospects`, `POST /api/sequences/{seq_id}/enroll`).

## Endpoint

```
POST /api/prospects
Auth: same OAuth2 bearer as the other write endpoints
```

### Request body (JSON)

Mirror the existing `ProspectOut` field names. Only `email` is required.

| field          | type          | notes                                                  |
|----------------|---------------|--------------------------------------------------------|
| `email`        | string (req.) | used for dedup / uniqueness                            |
| `first_name`   | string \| null|                                                        |
| `last_name`    | string \| null|                                                        |
| `title`        | string \| null| job title                                              |
| `company`      | string \| null| free-text (no company object)                          |
| `website`      | string \| null|                                                        |
| `linkedin_url` | string \| null|                                                        |
| `country`      | string \| null|                                                        |
| `location`     | string \| null|                                                        |
| `source_list`  | string \| null| IC(E)looP sends `"IC(E)looP"` so its leads are filterable |
| `prospect_type`| string \| null|                                                        |
| `status`       | string \| null| IC(E)looP sends `"new"`                                 |
| `notes`        | string \| null| IC(E)looP puts the source signal + phone here          |

### Response

`201` (or `200`) with a **`ProspectOut`** — must include the integer `id`.

### Behaviour

- **Plain insert is fine.** The adapter does its own dedup first
  (`GET /api/prospects?q=<email>`, exact-email filter) and only calls this endpoint when no
  match exists, so the endpoint does **not** need to be idempotent.
- If you'd rather centralise dedup in the backend, an upsert-by-email that returns the existing
  `ProspectOut` on conflict also works — the adapter tolerates both.
- `422` on validation error (standard FastAPI), `401` without auth.

## Two things to confirm on your side

1. **Service account without 2FA.** The adapter logs in via `POST /api/auth/login`
   (form-urlencoded username/password). If the account has TOTP enabled, plain login won't
   return a token. Create a dedicated service user without 2FA and put its creds in `.env`
   (`CRM_USERNAME` / `CRM_PASSWORD`).
2. **Which DB the FastAPI uses** (postgres vs the MCP server's `data/outreach.db` sqlite).
   The adapter only ever talks to the FastAPI backend, so as long as this new endpoint writes
   to the same store the app reads from, we're consistent. (This is why we went REST instead of
   the MCP/sqlite path.)

## How the adapter calls it

`src/crm/pipeline.ts` → `pushQualifiedLead()` sends, per lead:

```jsonc
{
  "first_name": "Jane",
  "last_name": "Doe",
  "email": "jane@acme.com",
  "title": "Head of Sales",
  "company": "Acme",
  "linkedin_url": "https://linkedin.com/in/jane",
  "source_list": "IC(E)looP",
  "status": "new",
  "notes": "Signal source (Sillage): new CRO, 3 weeks in\nTél: +33612345678"
}
```
