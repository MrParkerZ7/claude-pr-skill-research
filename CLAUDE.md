# claude-pr-skill-research

A test bed for the `soft-pr-*` skills (`pr-create`, `pr-update`, `pr-review`, `pr-review-deep`, `pr-resolve`). It holds a Kotlin Spring Boot WebFlux API in `api/` and a React + TypeScript app in `web/`. Work lands on `dev`; `main` moves only through a pull request.

## Commands

Prerequisite: a JDK 21, with `JAVA_HOME` pointing at it. Gradle itself comes from the wrapper.

| What | Command (Windows: `gradlew.bat` for `./gradlew`) |
|---|---|
| Build and run every gate | `./gradlew build` |
| Tests only | `./gradlew :api:test` |
| Format the sources | `./gradlew spotlessApply` |
| Coverage figure | `./gradlew :api:koverLog` |
| Run the API | `./gradlew :api:bootRun`, then `GET http://localhost:8080/actuator/health` |

`build` runs `spotlessCheck`, `test` and `koverVerify`. The gates are never lowered: ktlint clean, 100% line and branch coverage on `:api` (only `ApiApplicationKt`, the top-level `main`, is excluded), and Kotlin warnings are errors.

The web half needs Node 24 (`web/.nvmrc`; `web/package.json` accepts `^22.22.2 || ^24.15.0 || >=26`, and `web/.npmrc` makes an install on an older Node fail) and pnpm 9 (pinned to 9.12.0); put that Node first on `PATH`. Run these from the repository root:

| What | Command |
|---|---|
| Install from the lockfile | `pnpm --dir web install --frozen-lockfile` |
| Every web gate | `pnpm --dir web run verify` (lint, format check, type check, tests at 100% coverage, build) |
| Tests only | `pnpm --dir web run test` |
| Format the sources | `pnpm --dir web run format` |
| Dev server | `pnpm --dir web dev`, on http://localhost:5173 |
| Preview the build | `pnpm --dir web run build`, then `pnpm --dir web preview`, on http://localhost:4173 |

Both servers forward `/api` and `/actuator` to the API at `http://localhost:8080`; set `API_ORIGIN` to point them elsewhere. The web gates are never lowered: ESLint and Prettier clean, strict TypeScript, and 100% statement, branch, function and line coverage.

## Layout

| Path | Holds |
|---|---|
| `api/` | the Spring Boot WebFlux service, Kotlin, package `io.github.mrparkerz7.prskill.api` |
| `web/` | the React + TypeScript app (Vite, Vitest, pnpm), built from `web/package.json` and its lockfile |
| `gradle/libs.versions.toml` | every plugin and library version; no version literal in a `*.gradle.kts` file |
| `contracts/` | shared fixtures the API tests read (a test input; created by the tickets that need it) |
| `docs/` | a separate private repository, nested and ignored here; see the README |

## Rules

- Commit subjects are `T-NNN: <summary>`, one per ticket, pushed to `dev`.
- This repository is public: no machine paths, no secrets and no private ticket text in any file here.
- Line endings are LF (`.gitattributes`), except `*.bat` and `*.cmd`.
- Runtime settings are in `api/src/main/resources/application.yml`.
