# 0001. Record architecture decisions and the advisor/architect governance

Status: Accepted (the owner instructed this set-up on 2026-10-15)
Date: 2026-10-15
Deciders: owner; architect (Fable 5.1)

## Context

Until today the project's structural decisions lived in pull-request descriptions, memory notes and individual design documents (`docs/*.md`, `docs/ambak-learning-data-standard/BLUEPRINT.md`). Nothing recorded which decisions were approved, which were superseded, or which document governs which area. `CLAUDE.md` now names `docs/ARCHITECTURE.md` and `docs/adr/` as the source of truth and defines an `architect` agent (`.claude/agents/architect.md`) that writes plans but never feature code. Neither file existed before this record.

On 2026-10-15 the owner directed: Opus 5.5 codes; Fable 5.1 decides through the `advisor` tool and the `architect` agent; the advisor is consulted before schema, module, roles/permissions, API, new-library/integration and grading/privacy/data changes, on a repeated error, and before a big task is declared finished; advice that conflicts with `docs/ARCHITECTURE.md` stops work and goes to the owner; every approved structural decision is recorded as a new ADR.

## Decision

1. `docs/ARCHITECTURE.md` describes the system as it is, the principles, the governance, which document is authoritative for which area, the phase roadmap and the open decisions. It is short and points at the design documents instead of repeating them.
2. One phase-scoped decision per file in `docs/adr/NNNN-kebab-title.md`, numbered from `0001` in sequence; each numbered step inside a record can be accepted or changed individually, and the owner's acceptance names any steps excluded. Sections, in this order: title (`# NNNN. Title`), Status, Date, Deciders, Context, Decision, Consequences, Alternatives considered, Decisions requested from the owner, References. (`.claude/agents/architect.md` lists the seven core sections; this record adds Deciders, Decisions requested from the owner and References.)
3. Status values: `Proposed`, `Accepted`, `Superseded by NNNN`. New ADRs are written as Proposed. Only the owner's approval moves one to Accepted. An accepted ADR is never edited except to change its status line to Superseded; a new ADR carries the replacement.
4. Decision flow: architect writes the ADR (Proposed) → owner accepts or changes it → status becomes Accepted → the executor builds from the ADR's numbered steps → the test or harness named in the ADR proves each step.
5. Every ADR's Decision section is concrete enough for the executor: files, tables, migrations, routes and the proving test. Database changes are stated as SQL intent including RLS, the policy and the literal grants in the same migration. Risks to learners, grading, privacy and existing records are stated with the protection for each.
6. The architect writes only `docs/ARCHITECTURE.md` and `docs/adr/*`. Everything else (code, migrations, tests, scripts, configuration, other docs) is the executor's, built from a plan.
7. The project rules in `docs/ARCHITECTURE.md` §3 bind every plan: hand-applied migrations (staging, then production; never the Supabase CLI), RLS plus literal grants per new relation, learner history never rewritten, production actions owner-run and explained first.
8. The advisor consultation triggers and the stop-and-ask rule from `CLAUDE.md` are part of this governance and are not repeated per ADR.

## Consequences

- Structural decisions have one home; the review history of a decision is its ADR file.
- Each phase of work starts from an accepted ADR, which makes "what was approved" checkable before a migration is applied or a tag is pushed.
- Writing and approving records adds a step before implementation; it replaces re-deriving the same decisions in each session.
- Older design documents remain authoritative for their areas until an ADR amends them (see `docs/ARCHITECTURE.md` §5).

## Alternatives considered

- Decisions in pull-request descriptions only: not discoverable, and silently changed by later PRs.
- One living design document for everything: the learning-data blueprint is already 1,100 lines; a single document would not stay readable, and status per decision would be lost.
- No records, rely on the model's memory notes: the notes are per-machine and not in the repository.

## Decisions requested from the owner

The set-up itself was instructed by the owner on 2026-10-15 and needs no further approval. Two specifics in this record were chosen by the architect and can be changed by a superseding ADR 0008 if the owner prefers otherwise:

1. The ten-section template and the "phase-scoped decision, steps individually acceptable" rule of decision 2. Recommended: confirm.
2. Align the section list in `.claude/agents/architect.md` with decision 2 (the architect cannot edit that file). Recommended: yes, an owner edit.

## References

- `CLAUDE.md` (Architecture and decision rules), `AGENTS.md`
- `.claude/agents/architect.md`
- `docs/ARCHITECTURE.md`
