# SDK cloud automation
Adapted from degerahmet/aeo-visibility main (6713d4d89aa2b569d394b166f62c2400a5a10b4f).

Flow: writer adds ready-for-claude -> Claude Cloud implementation -> same-repository PR -> Automation CI and Codex review -> bounded corrections -> merge-ready -> external Claude merge routine.

## Activate after merging this setup PR
1. Install/authorize Claude and Codex GitHub integrations for THIS repository. Verify the implementation routine can clone, push a branch and create a PR here.
2. Create an implementation routine selecting only THIS repository. Paste CLOUD_ROUTINE_PROMPT.md. Add its API trigger.
3. Configure Actions variable CLAUDE_ROUTINE_URL, secret CLAUDE_ROUTINE_TOKEN, and variable CLAUDE_EXECUTION_MODE=cloud. Do not paste tokens in issues.
4. Configure secret PROJECTS_TOKEN with this repository's contents/pull-requests/issues write and Actions/checks read access (and organization authorization when required). It must be a user/App identity whose comments can trigger the installed subscription Codex reviewer. No OpenAI API key.
5. Create a separate merge routine, selecting THIS repository, triggered on PR label added: merge-ready; paste MERGE_ROUTINE_PROMPT.md. Verify the trigger responds to the identity used by PROJECTS_TOKEN.
6. Optional separate organization project: set PROJECT_OWNER and PROJECT_NUMBER; grant project write to PROJECTS_TOKEN. Unset both to disable project sync. Never defaults to the main app board.
7. Add ready-for-claude to a small repo-local issue and verify its cloud-session link, PR, green sdk job, exact-head Codex result, label and SHA-guarded merge. Setup is not end-to-end validated until this succeeds.

## Behavior
Existing ci.yml is strengthened, not duplicated: controller tests, lint, typecheck, build and tests. CI has no publishing secrets. Unpublished sibling @doclight packages may currently block install; report this honestly and resolve dependency/release work separately rather than skip checks.
The task dispatcher uses cloud only. Missing settings cause no implementation dispatch.
At most three correction attempts. Stalled cloud sessions require manual continuation.
Automation workflows run trusted main only with elevated credentials; PR code runs only in unprivileged CI.
Automation infrastructure changes require a separate trusted review and manual merge.
Codex coordinator requests review only; it never merges. Only the external merge routine may merge, after fresh evidence.
Registry releases and the main application's docs PR are separate. Link their full URLs to the coordination issue; a local SDK merge must not close the cross-repo coordination issue.
No routine, secret, branch rule, project or release configuration is created by merging these files alone.
