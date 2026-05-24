# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## What this project is

A SAP CAP (Cloud Application Programming model) application with:
- A `Books` entity served via `CatalogService` at `/odata/v4/catalog/`
- A Fiori Elements List Report UI (`app/sample_ui`) that browses Books
- A BTP Job Scheduling Service integration that runs scheduled HTTP jobs against the CAP server

Deployed on BTP Cloud Foundry at:
`https://fef3594etrial-dev-sampleapp-srv.cfapps.us10-001.hana.ondemand.com`

---

## Development commands

```sh
# Local development (SQLite, hot reload)
cds watch

# UI served at: http://localhost:4004/sample_ui/webapp/index.html

# Run UI dev server with live reload (separate terminal)
cd app/sample_ui
npm start        # proxies /odata → localhost:4004

# Lint UI
cd app/sample_ui
npx eslint webapp/

# Production build + deploy to BTP Cloud Foundry
npm run build    # rimraf + mbt build → mta_archives/archive.mtar
npm run deploy   # cf deploy mta_archives/archive.mtar --retries 1

# Abort a stuck deploy operation
cf deploy -i <operation-id> -a abort
```

---

## Architecture

### CAP backend (`srv/`)

| File | Role |
|---|---|
| `srv/cat-service.cds` | Defines `CatalogService` exposing `Books` entity |
| `srv/server.js` | Custom CAP server entry — hooks Express middleware on `cds.on('bootstrap')` |
| `srv/jobs-handler.js` | Registers `/jobs/*` Express routes for the BTP Job Scheduler |

### Job Scheduling integration

The `srv/jobs-handler.js` exposes two endpoints outside the CDS OData stack:

- `POST /jobs/syncBooks` — called by the BTP Job Scheduler; appends `[synced <timestamp>]` to every Book title
- `GET /jobs/books` — debug endpoint to inspect DB state directly using the scheduler token

**Auth**: Both endpoints are protected by `jwtAuth` middleware using `@sap/xssec` v4. The correct call pattern is:
```js
// xssec v4: service instance is FIRST arg, contextConfig is SECOND
const service = new XsuaaService(vcap.jobscheduler[0].credentials.uaa);
await createSecurityContext(service, { jwt: token });
```
The middleware reads the `jobscheduler` binding from `VCAP_SERVICES` (not the `xsuaa` binding) because the scheduler issues tokens under its own xsappname. In local dev (`cds watch`), no `VCAP_SERVICES` is present so auth is skipped automatically.

**HANA constraint**: `UPDATE` with function expressions is not supported on HANA. Fetch rows first, then update each row individually with the actual string value:
```js
const rows = await db.run(SELECT.from(Entity));
await Promise.all(rows.map(r => db.run(UPDATE(Entity).where({ ID: r.ID }).set({ field: newValue }))));
```

### Fiori UI (`app/sample_ui/`)

Fiori Elements List Report + Object Page for `Books`. Annotations are in `app/sample_ui/annotations.cds`, compiled into OData metadata at `cds watch` time. The `app/services.cds` file pulls in annotations so the CAP server includes them.

The UI is deployed as an HTML5 app to `html5-apps-repo` and served via SAP Managed Application Router — not directly from the CAP server in production.

### BTP services (mta.yaml)

| Resource name | Service | Purpose |
|---|---|---|
| `sampleapp-auth` | `xsuaa / application` | App authentication; xsappname grants `jobscheduler` scope |
| `sampleapp-db` | `hana / hdi-shared` | HANA HDI container for Books table |
| `jobschedule` | `jobscheduler / free` | BTP Job Scheduling Service |
| `sampleapp-html5-repo-host` | `html5-apps-repo / app-host` | Hosts the Fiori UI bundle |
| `sampleapp-destination-service` | `destination / lite` | Destination for the managed approuter to reach the CAP backend |

**Note**: There is a stale reference to `sampleapp-job-scheduler` (the old name before it was renamed to `jobschedule`) that causes a non-fatal error at the end of every `cf deploy`. Abort it with `cf deploy -i <id> -a abort` — the app itself starts successfully.

### Validating job runs via REST

```sh
# Get scheduler token
curl -X POST "https://fef3594etrial.authentication.us10.hana.ondemand.com/oauth/token" \
  --user '<clientid>:<clientsecret>' \
  -d "grant_type=client_credentials"

# Read DB state
curl "https://.../jobs/books" -H "Authorization: Bearer <token>"

# Trigger job
curl -X POST "https://.../jobs/syncBooks" -H "Authorization: Bearer <token>" -H "Content-Type: application/json"

# Create one-time schedule (fires immediately)
curl -X POST "https://jobscheduler-rest.cfapps.us10.hana.ondemand.com/scheduler/jobs/<jobId>/schedules" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"description":"run-now","time":"now","active":true}'

# Check run history for a schedule
curl "https://jobscheduler-rest.cfapps.us10.hana.ondemand.com/scheduler/jobs/<jobId>/schedules/<scheduleId>/runs" \
  -H "Authorization: Bearer <token>"
```
Use **single quotes** around credentials — `$` and `|` in the clientid/secret break with double quotes.

---

## Seed data

`db/data/sampleapp-Books.csv` — 5 books with integer IDs (1–5). The `title` field gets mutated by the sync job; to restore original values, redeploy the `sampleapp-db-deployer` module or insert a corrective update via a job endpoint.
