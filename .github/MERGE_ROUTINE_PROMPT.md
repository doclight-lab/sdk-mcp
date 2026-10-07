# Merge routine
Select only doclight-lab/sdk-mcp and trigger on pull request label added: merge-ready.
Fetch the matching PR; ignore other repositories, closed/draft/fork PRs or missing merge-ready.
The label is a wake-up signal, never authorization by itself.
Check out trusted main only, not the PR's automation scripts. Independently gather current-head evidence using .github/scripts/merge_ready.cjs and call decide with the repository's configured approval policy.
Require ready: successful current-head Automation CI (ci.yml) and sdk job, all other checks complete/successful, no changes requested or unresolved threads, explicit authentic clean Codex evidence for exact head, clean mergeability, current main ancestry, no manual-merge/automation-paused on PR or linked local issue and no protected infrastructure changes.
If evidence is missing, stale, inaccessible or contradictory, do not merge; explain the blocker.
Immediately re-fetch PR head, main SHA and evidence before merging. Merge through the GitHub API with sha equal to the validated PR head and merge_method=squash. Respect rulesets; never bypass protections. If head/base changed, repeat validation or stop.
Post the resulting merge URL on the local issue/PR. Never close the main-app cross-repo coordination issue; docs and published version remain independent completion requirements.
