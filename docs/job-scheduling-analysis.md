# BTP Job Scheduling — End-to-End Flow Analysis

> **App**: `sampleapp` — CAP + Fiori on SAP BTP Cloud Foundry (US10 region, trial)
> **CAP server URL**: `https://fef3594etrial-dev-sampleapp-srv.cfapps.us10-001.hana.ondemand.com`
> **Job Scheduler REST**: `https://jobscheduler-rest.cfapps.us10.hana.ondemand.com`

---

## 1. Component Map

```
┌─────────────────────────────────────────────────────────────────────┐
│  SAP BTP Cloud Foundry (org: fef3594etrial, space: dev)             │
│                                                                     │
│  ┌──────────────────────┐      ┌──────────────────────────────────┐ │
│  │   sampleapp-srv      │      │  jobschedule                     │ │
│  │   (CAP Node.js)      │◄─────│  (BTP Job Scheduling Service)    │ │
│  │                      │ HTTP │                                  │ │
│  │  /odata/v4/catalog/  │      │  - Stores job definitions        │ │
│  │  /jobs/syncBooks     │      │  - Stores schedules              │ │
│  │  /jobs/books         │      │  - Fires HTTP calls on schedule  │ │
│  └──────────┬───────────┘      └──────────────────────────────────┘ │
│             │                                                       │
│  ┌──────────▼───────────┐      ┌──────────────────────────────────┐ │
│  │   sampleapp-db       │      │  sampleapp-auth (XSUAA)          │ │
│  │   (HANA HDI)         │      │  - Issues user tokens            │ │
│  │                      │      │  - jobschedule has its own UAA   │ │
│  │   schema: Books      │      │    for issuing scheduler tokens  │ │
│  └──────────────────────┘      └──────────────────────────────────┘ │
│                                                                     │
│  ┌──────────────────────┐                                           │
│  │  html5-apps-repo     │  ← Fiori UI bundle (static files)        │
│  │  + destination-svc   │  ← Managed Approuter proxies OData calls │
│  └──────────────────────┘                                           │
└─────────────────────────────────────────────────────────────────────┘
```

### Key distinction: srv vs Fiori UI

| | `sampleapp-srv` | Fiori UI |
|---|---|---|
| Type | CAP Node.js server | Static HTML/JS bundle |
| Runs where | CF application container | `html5-apps-repo` (no server) |
| Job Scheduler target | **Yes** — has `/jobs/*` endpoints | No |
| Must be running for jobs | **Yes** | Irrelevant |

---

## 2. MTA Services & Bindings

Defined in `mta.yaml`. The srv module is bound to all three backend services:

```yaml
modules:
- name: sampleapp-srv
  requires:
  - name: sampleapp-auth    # XSUAA — secures OData endpoints
  - name: sampleapp-db      # HANA HDI — Books table
  - name: jobschedule       # Job Scheduler — injects UAA creds into VCAP_SERVICES

resources:
- name: jobschedule
  type: org.cloudfoundry.managed-service
  parameters:
    service: jobscheduler
    service-plan: free      # trial accounts use "free" plan
```

> **Plan gotcha**: The `lite` plan does not exist in trial subaccounts. Use `free`.

When the app starts on CF, `VCAP_SERVICES` contains the `jobschedule` binding:
```json
{
  "jobscheduler": [{
    "credentials": {
      "uaa": {
        "clientid": "sb-...|sap-jobscheduler!b1",
        "clientsecret": "...",
        "url": "https://fef3594etrial.authentication.us10.hana.ondemand.com",
        "xsappname": "...|sap-jobscheduler!b1"
      },
      "url": "https://jobscheduler-rest.cfapps.us10.hana.ondemand.com"
    }
  }]
}
```

---

## 3. Code Architecture

### Entry point: `srv/server.js`

```js
cds.on('bootstrap', (app) => {
  require('./jobs-handler')(app);
});
module.exports = cds.server;
```

CAP fires `bootstrap` once the Express app is created but before CDS routes are mounted. This is the correct hook to inject custom Express routes — they sit alongside CDS's OData middleware, not inside it.

### Job handler: `srv/jobs-handler.js`

Two endpoints registered on the Express app:

| Endpoint | Method | Purpose |
|---|---|---|
| `/jobs/syncBooks` | POST | Called by the Job Scheduler — updates Book titles |
| `/jobs/books` | GET | Debug endpoint — reads Books using the scheduler token |

Both are protected by `jwtAuth` middleware.

### JWT authentication middleware

```js
const { createSecurityContext, XsuaaService } = require('@sap/xssec');

function getService() {
  const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
  const js = (vcap.jobscheduler || [])[0];
  return js ? new XsuaaService(js.credentials.uaa) : null;
  // returns null in local dev → auth is skipped
}

async function jwtAuth(req, res, next) {
  const service = getService();
  if (!service) return next();                    // local dev bypass

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401)...;

  await createSecurityContext(service, { jwt: auth.slice(7) });
  next();
}
```

**Critical xssec v4 detail**: the function signature is `createSecurityContext(serviceInstance, contextConfig)` — the `XsuaaService` instance is the **first** argument, `{ jwt: token }` is the **second**. This is reversed from what the v3 docs suggest.

**Why jobscheduler UAA, not sampleapp-auth UAA?**
The scheduler issues tokens under its own `xsappname` (`sap-jobscheduler!b1`). Validating against `sampleapp-auth`'s XSUAA would fail audience checks. Reading from `vcap.jobscheduler[0].credentials.uaa` ensures the token is validated against the correct issuer.

### HANA UPDATE constraint

HANA does not support function expressions in `UPDATE.set()`. This fails:
```js
// WRONG on HANA
await db.run(UPDATE(Books).set({ title: title => `${title} [synced]` }));
```

Correct pattern — fetch rows first, then update individually:
```js
const rows = await db.run(SELECT.from(Books));
await Promise.all(
  rows.map(r => db.run(UPDATE(Books).where({ ID: r.ID }).set({ title: `${r.title} [synced ${now}]` })))
);
```

---

## 4. End-to-End Flow

### Flow A — Job Scheduler fires on schedule

```
1. Job Scheduler timer fires (cron or one-time)
        │
2. Scheduler fetches OAuth token from its own XSUAA
   POST https://fef3594etrial.authentication.us10.hana.ondemand.com/oauth/token
   grant_type=client_credentials
   → returns Bearer JWT (audience: sap-jobscheduler!b1, scope: uaa.resource)
        │
3. Scheduler POSTs to action URL with JWT + job metadata headers
   POST https://.../jobs/syncBooks
   Authorization: Bearer <jwt>
   x-sap-job-run-id: <runId>
   x-sap-scheduler-jobid: <jobId>
        │
4. sampleapp-srv receives request
        │
5. jwtAuth middleware runs
   ├─ reads VCAP_SERVICES.jobscheduler[0].credentials.uaa
   ├─ creates XsuaaService instance (cached after first call)
   ├─ calls createSecurityContext(service, { jwt: token })
   └─ if valid → next()  |  if invalid → 401
        │
6. syncBooks handler runs
   ├─ connects to HANA via cds.connect.to('db')
   ├─ SELECT all Books
   ├─ UPDATE each Book title individually (HANA constraint)
   ├─ SELECT again to confirm
   └─ returns { status, processed, syncedAt, books[] }
        │
7. HTTP 200 response received by Scheduler
        │
8. Scheduler records run result:
   runStatus: COMPLETED
   runState:  SUCCESS
   httpStatus: 200
   runText: [..., { type: "SUCCESS", text: '{"status":"success","processed":5}' }]
```

### Flow B — Manual trigger via REST API

```
Developer
  │
  ├─1. Get scheduler token
  │    curl -X POST https://.../oauth/token --user '<clientid>:<secret>'
  │
  ├─2. Read DB state before
  │    curl GET .../jobs/books -H "Authorization: Bearer <token>"
  │
  ├─3. Create one-time schedule (fires immediately)
  │    curl -X POST .../scheduler/jobs/<jobId>/schedules
  │    -d '{"time":"now","active":true}'
  │    → Scheduler internally runs Flow A
  │
  ├─4. Poll run result
  │    curl GET .../scheduler/jobs/<jobId>/schedules/<scheduleId>/runs
  │    → { runStatus: "COMPLETED", httpStatus: 200, runText: [...] }
  │
  └─5. Verify DB state after
       curl GET .../jobs/books -H "Authorization: Bearer <token>"
```

### Flow C — Local development

```
Developer runs: cds watch
  │
  ├─ CAP starts with SQLite (not HANA)
  ├─ VCAP_SERVICES is absent → getService() returns null
  ├─ jwtAuth middleware calls next() immediately (no auth check)
  └─ /jobs/syncBooks and /jobs/books accessible without token
```

---

## 5. Job Lifecycle in the Dashboard

```
Job created (active: true)
       │
       ▼
Schedule added
  ├─ cron: "0 * * * *"     → fires every hour, recurring
  ├─ time: "now"            → fires once immediately, then active: false
  └─ time: "2026-06-01..."  → fires once at that datetime
       │
       ▼
Schedule fires
  active: true → false (one-time)  |  active: true (cron, stays active)
  nextRunAt: null (one-time)       |  nextRunAt: <next cron time>
       │
       ▼
Run recorded under the schedule
  GET /scheduler/jobs/<jobId>/schedules/<scheduleId>/runs
  → { runStatus, runState, httpStatus, executionTimestamp, runText }
```

> **Important**: Runs are stored **per schedule**, not per job. Always use the `scheduleId` in the runs URL — the job-level runs endpoint (`/jobs/<id>/runs`) returns an empty result.

---

## 6. Lessons Learned

| Issue | Root cause | Fix |
|---|---|---|
| `service-plan: lite` deploy error | Trial subaccounts don't have the `lite` plan | Use `service-plan: free` |
| App crash: `Cannot find module '@sap/xsenv'` | `@sap/xsenv` is a transitive dep, excluded from production build | Read `VCAP_SERVICES` directly via `process.env` |
| JWT validation always failing | xssec v4 arg order is `(service, contextConfig)` not `(contextConfig, service)` | Swap arguments; pass `new XsuaaService(creds)` as first arg |
| 401 using `sampleapp-auth` XSUAA for validation | Scheduler tokens are issued under `sap-jobscheduler!b1` xsappname, not the app's | Use `vcap.jobscheduler[0].credentials.uaa` for the XsuaaService |
| `UPDATE` with function expression fails on HANA | HANA doesn't support JS function expressions in `UPDATE.set()` | Fetch rows first, then `UPDATE ... WHERE ID = ?` for each row |
| Stale `sampleapp-job-scheduler` detach error on every deploy | Service was renamed to `jobschedule` but old reference remains in MTA state | Run `cf deploy -i <id> -a abort` — app is already started, error is non-fatal |
| Run history returns empty | Queried `/jobs/<id>/runs` instead of `/jobs/<id>/schedules/<sid>/runs` | Always include the `scheduleId` in the runs URL |

---

## 7. Git Branch Management — Best Practices

### Current Repo State

```
github.com/Maddy464/sampleapp_jobs
  └── main (only branch) ← all changes go directly to production BTP
```

### Why Branch Matters for This App

The Job Scheduler is **live and running** in BTP. Any broken change pushed directly to `main` causes real scheduled job failures with no stable version to roll back to.

### Recommended Strategy

```
main          ← always stable, always matches deployed BTP state
  └── feature/add-cron-retry       ← active development
  └── feature/job-dashboard-api    ← parallel feature
  └── fix/hana-update-performance  ← bug fix
```

Minimum for solo work: `main` + one `feature/` branch at a time.

### Full Workflow: Branch → Change → Merge → Deploy

```sh
# 1. Create branch — main stays untouched
git checkout -b feature/my-changes

# 2. Make changes and commit
git add srv/jobs-handler.js mta.yaml
git commit -m "Add retry logic for syncBooks job"
git push origin feature/my-changes

# 3a. Merge via GitHub PR (recommended for mta.yaml / jobs-handler.js changes)
#     → github.com/Maddy464/sampleapp_jobs
#     → "Compare & pull request" → review diff → "Merge pull request"
git checkout main && git pull origin main

# 3b. OR merge directly via CLI (simple day-to-day changes)
git checkout main
git pull origin main
git merge feature/my-changes
git push origin main

# 4. Verify on BTP BEFORE deleting branch
npm run build && npm run deploy

# 5. Clean up after confirming deploy is healthy
git branch -d feature/my-changes            # delete local
git push origin --delete feature/my-changes # delete remote
```

### Post-Merge Checklist

```
[ ] PR merged / CLI merge completed
[ ] git pull on local main
[ ] npm run build && npm run deploy — app started successfully
[ ] Job Scheduler run history shows COMPLETED after deploy
[ ] Delete local branch:  git branch -d feature/<name>
[ ] Delete remote branch: git push origin --delete feature/<name>
[ ] Close related GitHub issue (if any)
```

### Delete or Keep the Branch?

**Always delete after merge.** The commits are permanently in `main`'s history — the branch pointer is just a label and adds noise once merged.

| Branch type | Action after merge |
|---|---|
| `feature/*` | **Delete** |
| `fix/*` | **Delete** |
| `docs/*` | **Delete** |
| `main` | Keep forever |

> **GitHub tip**: Enable auto-delete under **Repo → Settings → General → Pull Requests → Automatically delete head branches**. Removes the manual step after every PR merge.

### When to Use PR vs Direct CLI Merge

| Situation | Use |
|---|---|
| Touching `mta.yaml` or `jobs-handler.js` | GitHub PR — review diff before it hits production |
| Simple doc or config change | CLI merge — faster |
| Team working on the repo | Always GitHub PR |
| Solo, low-risk change | CLI merge |

### Conflict Resolution (if main moved ahead)

```sh
git checkout feature/my-changes
git rebase main           # replay your commits on top of latest main
# fix any conflicts → git add <file> → git rebase --continue
git checkout main
git merge feature/my-changes
git push origin main
```

---

## 8. Quick Reference — REST Commands

> Use **single quotes** around credentials — `$` and `|` break with double quotes.

```sh
# 1. Get token
TOKEN=$(curl -s -X POST "https://fef3594etrial.authentication.us10.hana.ondemand.com/oauth/token" \
  --user '<clientid>:<clientsecret>' \
  -d "grant_type=client_credentials" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# 2. List jobs
curl -s "https://jobscheduler-rest.cfapps.us10.hana.ondemand.com/scheduler/jobs" \
  -H "Authorization: Bearer $TOKEN"

# 3. List schedules for a job
curl -s "https://jobscheduler-rest.cfapps.us10.hana.ondemand.com/scheduler/jobs/<jobId>/schedules" \
  -H "Authorization: Bearer $TOKEN"

# 4. Trigger immediately
curl -X POST "https://jobscheduler-rest.cfapps.us10.hana.ondemand.com/scheduler/jobs/<jobId>/schedules" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"description":"run-now","time":"now","active":true}'

# 5. Check run history (use scheduleId, not just jobId)
curl -s "https://jobscheduler-rest.cfapps.us10.hana.ondemand.com/scheduler/jobs/<jobId>/schedules/<scheduleId>/runs" \
  -H "Authorization: Bearer $TOKEN"

# 6. Read DB state directly
curl -s "https://fef3594etrial-dev-sampleapp-srv.cfapps.us10-001.hana.ondemand.com/jobs/books" \
  -H "Authorization: Bearer $TOKEN"

# 7. Trigger job directly (bypasses scheduler)
curl -s -X POST "https://fef3594etrial-dev-sampleapp-srv.cfapps.us10-001.hana.ondemand.com/jobs/syncBooks" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"
```
