---
project: develop
domain: solution
---

# claude-pr-skill-research

[![ci](https://github.com/MrParkerZ7/claude-pr-skill-research/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/MrParkerZ7/claude-pr-skill-research/actions/workflows/ci.yml)

A small test bed for the `soft-pr-*` skills (`pr-create`, `pr-update`, `pr-review`, `pr-review-deep`, `pr-resolve`).

It holds a Kotlin Spring Boot WebFlux and React monorepo, so the pull requests opened here have real code to describe, review and resolve. Work lands on `dev` and reaches `main` through a pull request.

## Develop

Prerequisites: a JDK 21, with `JAVA_HOME` pointing at it; and, for the web half, Node 24 (`web/.nvmrc`; `web/package.json` accepts `^22.22.2 || ^24.15.0 || >=26`) and pnpm 9.

```bash
# the API (Kotlin, Spring Boot WebFlux)
./gradlew build            # format check, tests and the 100% coverage gate
./gradlew :api:bootRun     # the API on port 8080
curl localhost:8080/actuator/health

# the web app (React, TypeScript, Vite)
pnpm --dir web install --frozen-lockfile
pnpm --dir web run verify  # lint, format check, type check, tests at 100% coverage, build
pnpm --dir web run build   # the production bundle alone, in web/dist
pnpm --dir web dev         # http://localhost:5173, forwarding /api and /actuator to the API
pnpm --dir web preview     # http://localhost:4173, serving the build (run build first)
```

On Windows use `gradlew.bat`. Set `API_ORIGIN` when the API is not on `http://localhost:8080`. `CLAUDE.md` lists the rest.

## Docs

Docs layout v2 (the prompt master's shared/project-types/DOCS_LAYOUT.md) - written by develop-docs-engine.py, never by hand.

| Field | Value |
|-------|-------|
| Layout | 2 |
| Repo | claude-pr-skill-research-documentation |
| Remote | https://github.com/MrParkerZ7/claude-pr-skill-research-documentation.git |
| Branch | main |
| Path | docs |

A fresh clone of this repo has no `docs/`: the docs are a separate nested repo, ignored here. From this folder, clone them:

```bash
git clone https://github.com/MrParkerZ7/claude-pr-skill-research-documentation.git docs
```

