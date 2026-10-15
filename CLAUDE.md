@AGENTS.md

## Architecture and decision rules

- `docs/ARCHITECTURE.md` and `docs/adr/` are the source of truth. Follow them exactly.
- Do not change folder structure, module boundaries, or patterns on your own.
- Consult the advisor BEFORE:
  - database or schema changes;
  - adding new modules or folders;
  - login, roles or permissions changes (learner, instructor, admin; in this codebase the roles are super_owner, admin, data_analyst and user);
  - changing APIs;
  - choosing new libraries or integrations (video, payments, SCORM/xAPI);
  - anything about grading, privacy or data;
  - when the same error happens twice;
  - before saying a big task is finished.
- If advice conflicts with `docs/ARCHITECTURE.md`, stop and ask the owner.
- Record every approved structural decision as a new file in `docs/adr/`.
- For system design, feature planning, database design and structural changes, use the `architect` agent (`.claude/agents/architect.md`). It writes plans; it does not write feature code.
