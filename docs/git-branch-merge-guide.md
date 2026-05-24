# Git Branch & Merge Guide

> **Repo**: `github.com/Maddy464/sampleapp_jobs`
> **Current state**: Single `main` branch, 1 commit — all changes go directly to production BTP

---

## Why Branch?

Right now any change to `main` immediately affects the live BTP deployment and the running Job Scheduler. A broken `jobs-handler.js` pushed to `main` means the scheduled `syncBooks` job starts failing in production with no stable version to fall back to.

---

## Recommended Branch Strategy

```
main          ← always stable, always matches deployed BTP state
  └── feature/cron-schedule-config   ← active development
  └── feature/job-retry-logic        ← parallel feature
  └── fix/hana-update-performance    ← bug fix
```

**Minimum setup for solo work**: just `main` + one `feature/` branch at a time.

---

## Pros & Cons

### Pros

| Benefit | Why it matters for this app |
|---|---|
| Safe experimentation | Break `jobs-handler.js` on a branch without affecting live BTP job |
| Rollback | `main` always has the last working code |
| Parallel work | Fix a bug while a feature is still in progress |
| Code review via PR | See full diff on GitHub before it hits production |
| Deploy control | Only merge to `main` when ready to deploy |
| Audit trail | Each branch/PR documents what changed and why |

### Cons

| Drawback | Impact |
|---|---|
| Extra steps | Small solo project — branching adds overhead |
| Merge conflicts | If `main` moves while branch is open, rebase needed |
| No CI/CD | Without auto-deploy, PRs don't give full safety |
| Solo review overhead | Self-reviewing PRs has less value |

---

## Full Workflow: Branch → Change → Merge → Deploy

### Step 1 — Create and switch to a new branch

```sh
git checkout -b feature/my-changes
# Now on feature/my-changes — main is untouched
```

---

### Step 2 — Make changes and commit

```sh
# Edit files...
git add srv/jobs-handler.js mta.yaml
git commit -m "Add retry logic for syncBooks job"

# Push branch to GitHub
git push origin feature/my-changes
```

---

### Step 3 — Merge back to main

#### Option A — GitHub Pull Request (recommended)

```
1. Go to github.com/Maddy464/sampleapp_jobs
2. GitHub shows: "feature/my-changes had recent pushes"
3. Click "Compare & pull request"
4. Add title + description → "Create pull request"
5. Review the diff
6. Click "Merge pull request" → "Confirm merge"
```

Then sync local main:
```sh
git checkout main
git pull origin main
```

---

#### Option B — Direct CLI merge (no PR)

```sh
git checkout main
git pull origin main                  # get latest remote changes
git merge feature/my-changes          # merge branch into main
git push origin main                  # push to GitHub
```

---

#### Option C — Rebase then merge (cleanest history)

```sh
# Update feature branch with latest main first
git checkout feature/my-changes
git rebase main

# Fast-forward merge — no merge commit created
git checkout main
git merge feature/my-changes
git push origin main
```

---

### Step 4 — Clean up branch after merge

```sh
# Delete local branch
git branch -d feature/my-changes

# Delete remote branch on GitHub
git push origin --delete feature/my-changes
```

---

### Step 5 — Deploy to BTP after merge

```sh
# Always deploy from main
git checkout main
npm run build && npm run deploy
```

---

## Which Option to Use

| Situation | Use |
|---|---|
| Solo, simple change | Option B — CLI merge |
| Want to review diff before merging | Option A — GitHub PR |
| Want clean linear git history | Option C — Rebase |
| Team working on same repo | Always Option A — PR |

For this app (solo, manual BTP deploy): **Option B** for day-to-day changes. **Option A** when touching `mta.yaml` or `jobs-handler.js` — review the diff before it goes live.

---

## Handling Merge Conflicts

If `main` was updated while your branch was open:

```sh
git checkout feature/my-changes
git rebase main          # replays your commits on top of latest main
# If conflicts appear:
#   edit the conflicted files
#   git add <file>
#   git rebase --continue
git checkout main
git merge feature/my-changes
git push origin main
```

---

## Quick Reference

```sh
git checkout -b feature/<name>          # create new branch
git push origin feature/<name>          # push to GitHub
git checkout main && git pull           # switch to main and sync
git merge feature/<name>               # merge into main
git push origin main                    # push merged main
git branch -d feature/<name>           # delete local branch
git push origin --delete feature/<name> # delete remote branch
```
