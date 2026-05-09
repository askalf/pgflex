## Summary

<!-- 1-3 bullets on what this PR does and why. Skip the "what changed" auto-summary — the diff already shows that. Focus on the *why*. -->

## What's NOT in this PR

<!-- Anything reviewers might expect but doesn't belong here, with a one-line reason. Optional but useful. -->

## Test plan

- [ ] `npm run build` clean
- [ ] `npm run typecheck` clean
- [ ] `npm test` passes (factory + pglite)
- [ ] If touching pg-adapter: `DATABASE_URL=... npm run test:pg` against a throwaway Postgres
- [ ] Live smoke (if applicable): describe what you ran and what you saw
