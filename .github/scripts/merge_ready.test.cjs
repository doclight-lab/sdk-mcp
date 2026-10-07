const test = require('node:test');
const assert = require('node:assert/strict');
const {decide, routeEvent, evaluatePr, LABEL} = require('./merge_ready.cjs');
const codex = {id: 199175422, login: 'chatgpt-codex-connector[bot]', type: 'Bot'};
const human = {id: 5, login: 'rev', type: 'User'};
const SHA = 'a'.repeat(40);
const cleanBody = "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `aaaaaaaaaa`";
const ci = (o = {}) => ({id: 1, path: '.github/workflows/ci.yml@refs/pull/9/merge', head_sha: SHA,
  status: 'completed', conclusion: 'success', pull_requests: [{number: 9}], ...o});
const job = (name, o = {}) => ({name, app: {slug: 'github-actions'}, status: 'completed', conclusion: 'success', ...o});
const base = () => ({
  pr: {number: 9, state: 'open', draft: false, baseRef: 'main', sha: SHA, user: human, authorAssociation: 'OWNER',
    labels: [], headRepo: 'o/r', baseRepo: 'o/r', mergeable: true, mergeableState: 'clean'},
  files: ['backend/app/x.py'], taskPaused: false, runs: [ci()],
  checks: [job('sdk')], statuses: [], reviews: [], threads: [{isResolved: true}],
  codex: {summaries: [{user: codex, body: cleanBody, updated_at: '2026-10-07T10:00:00Z', reviewedSha: SHA}], requests: [], reactions: {}},
});
const st = (mut, cfg) => { const e = base(); mut(e); return decide(e, cfg).state; };

test('fully green, clean Codex => ready; no human approval needed by default', () => {
  assert.equal(decide(base()).state, 'ready');
});
test('CI-first and review-first both reach ready; the missing half blocks', () => {
  assert.equal(st(e => { e.codex.summaries = []; }), 'not_ready');           // CI green, review missing
  assert.equal(st(e => { e.runs = []; }), 'not_ready');                      // review clean, CI missing
});
test('green CI while Codex is Running stays unlabeled', () => {
  assert.equal(st(e => { e.codex.summaries[0].body = 'Codex Review: **Status:** Running\n**Reviewed commit:** `aaaaaaaaaa`'; }), 'not_ready');
});
test('stale Codex result for an older commit is not clean', () => {
  assert.equal(st(e => { e.codex.summaries[0].reviewedSha = 'b'.repeat(40); }), 'not_ready');
  assert.equal(st(e => { e.codex.summaries[0].user = {...codex, id: 1}; }), 'not_ready');
});
test('resolved threads alone are not a clean review; findings after clean block', () => {
  assert.equal(st(e => { e.codex.summaries[0].body = 'Codex found P1 issues'; }), 'not_ready');
  assert.equal(st(e => { e.reviews = [{user: codex, state: 'COMMENTED', commit_id: SHA, submitted_at: '2026-10-07T10:05:00Z'}]; }), 'not_ready');
  assert.equal(st(e => { e.codex.requests = [{id: 7, body: '@codex review', created_at: '2026-10-07T10:30:00Z'}]; }), 'not_ready');
});
test('unresolved threads, change requests, unmet configured approvals block', () => {
  assert.equal(st(e => { e.threads = [{isResolved: false}]; }), 'not_ready');
  assert.equal(st(e => { e.threads = null; }), 'not_ready');
  assert.equal(st(e => { e.reviews = [{user: human, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-07T09:00:00Z'}]; }), 'not_ready');
  assert.equal(st(() => {}, {requiredApprovals: 1}), 'not_ready');
  assert.equal(st(e => { e.reviews = [{user: human, state: 'APPROVED', commit_id: SHA, submitted_at: '2026-10-07T09:00:00Z'}]; }, {requiredApprovals: 1}), 'ready');
  assert.equal(st(e => { e.reviews = [{user: human, state: 'APPROVED', commit_id: 'old', submitted_at: '2026-10-07T09:00:00Z'}]; }, {requiredApprovals: 1, requireFreshApprovals: true}), 'not_ready');
  assert.equal(st(e => { e.reviews = [{user: human, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-07T08:00:00Z'}, {user: human, state: 'DISMISSED', submitted_at: '2026-10-07T09:00:00Z'}]; }), 'ready');
});
test('failed, pending, cancelled, missing or skipped required CI blocks', () => {
  for (const c of [{conclusion: 'failure'}, {conclusion: 'cancelled'}, {conclusion: 'skipped'}, {status: 'in_progress', conclusion: null}])
    assert.equal(st(e => { e.checks[0] = job('sdk', c); }), 'not_ready');
  assert.equal(st(e => { e.checks = []; }), 'not_ready');
  assert.equal(st(e => { e.runs = [ci({conclusion: 'failure'})]; }), 'not_ready');
  assert.equal(st(e => { e.runs = [ci({head_sha: 'old'})]; }), 'not_ready');
  assert.equal(st(e => { e.checks.push(job('other', {conclusion: 'failure'})); }), 'not_ready');
  assert.equal(st(e => { e.statuses = [{state: 'pending'}]; }), 'not_ready');
});
test('own readiness check is excluded from prerequisites', () => {
  assert.equal(st(e => { e.checks.push(job('merge-ready-evaluate', {status: 'in_progress', conclusion: null})); }), 'ready');
});
test('eligibility: draft, retarget, closed, fork, opt-out, protected paths', () => {
  for (const m of [e => { e.pr.draft = true; }, e => { e.pr.baseRef = 'dev'; }, e => { e.pr.state = 'closed'; },
    e => { e.pr.headRepo = 'x/r'; }, e => { e.pr.labels = ['manual-merge']; }, e => { e.taskPaused = true; },
    e => { e.files = ['.github/workflows/x.yml']; }, e => { e.pr.authorAssociation = 'NONE'; }])
    assert.equal(st(m), 'not_ready');
});
test('conflicts, behind/blocked are not ready; unknown mergeability defers', () => {
  assert.equal(st(e => { e.pr.mergeable = false; e.pr.mergeableState = 'dirty'; }), 'not_ready');
  assert.equal(st(e => { e.pr.mergeableState = 'behind'; }), 'not_ready');
  assert.equal(st(e => { e.pr.mergeableState = 'blocked'; }), 'not_ready');
  assert.equal(st(e => { e.pr.mergeable = null; e.pr.mergeableState = 'unknown'; }), 'deferred');
});
test('event routing ignores unverified sources', () => {
  const ctx = (eventName, payload) => ({eventName, payload, repo: {owner: 'o', repo: 'r'}});
  assert.deepEqual(routeEvent(ctx('issue_comment', {issue: {number: 3, pull_request: {}}, comment: {user: human}})).numbers, []);
  assert.deepEqual(routeEvent(ctx('issue_comment', {issue: {number: 3, pull_request: {}}, comment: {user: codex}})).numbers, [3]);
  assert.deepEqual(routeEvent(ctx('issue_comment', {issue: {number: 3}, comment: {user: codex}})).numbers, []);
  const wr = {event: 'pull_request', head_sha: SHA, pull_requests: [{number: 4}], repository: {full_name: 'o/r'}, head_repository: {full_name: 'o/r'}};
  assert.deepEqual(routeEvent(ctx('workflow_run', {workflow_run: wr})).numbers, [4]);
  assert.deepEqual(routeEvent(ctx('workflow_run', {workflow_run: {...wr, head_repository: {full_name: 'x/r'}}})).numbers, []);
  assert.deepEqual(routeEvent(ctx('repository_dispatch', {client_payload: {pr_number: '5; rm'}})).numbers, []);
  assert.equal(routeEvent(ctx('schedule', {})).sweep, true);
});

// Label lifecycle with a fake API.
function fake({labels = [], headAfter = SHA} = {}) {
  const calls = [];
  const github = {rest: {issues: {
    get: async () => ({data: {labels: labels.map(name => ({name}))}}),
    getLabel: async () => ({}), createLabel: async () => calls.push('create'),
    addLabels: async () => calls.push('add'), removeLabel: async () => calls.push('remove'),
  }, pulls: {get: async () => ({data: {head: {sha: headAfter}, state: 'open', draft: false, base: {ref: 'main'}}})}}};
  return {github, calls, core: {info() {}, warning() {}}};
}
const run = (f, mut, gatherFn) => evaluatePr({github: f.github, core: f.core, owner: 'o', repo: 'r', number: 9,
  gatherFn: gatherFn || (async () => { const e = base(); mut?.(e); return e; })});
test('label added only on a real transition; unchanged state does no write', async () => {
  let f = fake(); await run(f); assert.deepEqual(f.calls, ['add']);
  f = fake({labels: [LABEL]}); await run(f, e => { e.pr.labels = [LABEL]; }); assert.deepEqual(f.calls, []);
});
test('invalidation removes the label; deferred leaves it alone', async () => {
  let f = fake({labels: [LABEL]}); await run(f, e => { e.pr.labels = [LABEL]; e.threads = [{isResolved: false}]; });
  assert.deepEqual(f.calls, ['remove']);
  f = fake({labels: [LABEL]}); await run(f, e => { e.pr.labels = [LABEL]; e.pr.mergeable = null; e.pr.mergeableState = 'unknown'; });
  assert.deepEqual(f.calls, []);
});
test('a push racing the label write is rolled back', async () => {
  const f = fake({headAfter: 'b'.repeat(40)}); await run(f); assert.deepEqual(f.calls, ['add', 'remove']);
});
test('API failure fails closed: existing label withdrawn, none added', async () => {
  let f = fake({labels: [LABEL]}); await run(f, null, async () => { throw Object.assign(new Error('x'), {status: 502}); });
  assert.deepEqual(f.calls, ['remove']);
  f = fake(); await run(f, null, async () => { throw new Error('x'); }); assert.deepEqual(f.calls, []);
});
