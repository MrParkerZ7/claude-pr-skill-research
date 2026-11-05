---
project: develop
domain: solution
---

# claude-pr-skill-research

A small test bed for the `soft-pr-*` skills (`pr-create`, `pr-update`, `pr-review`, `pr-review-deep`, `pr-resolve`).

It holds a Kotlin Spring Boot WebFlux and React monorepo, so the pull requests opened here have real code to describe, review and resolve. Work lands on `dev` and reaches `main` through a pull request.

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

