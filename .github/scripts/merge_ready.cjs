// Label-only readiness controller. Adds/removes `merge-ready`; it NEVER merges,
// dismisses reviews, resolves threads, or touches protection settings.
const {linkedIssues} = require('./task_links.cjs');
const {protectedPath, isCodex, isClaude} = require('./codex_merge.cjs');

const LABEL = 'merge-ready';
const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';
const CLEAN_RE = /^Codex Review: Didn't find any major issues\./;
const OPT_OUT = ['manual-merge', 'automation-paused'];
// Job names defined by .github/workflows/ci.yml.
const REQUIRED_CHECKS = ['sdk'];
const CI_WORKFLOW = '.github/workflows/ci.yml';
// This workflow's own job; excluded so the controller never waits on itself.
const OWN_CHECKS = ['merge-ready-evaluate'];
const BAD_CONCLUSIONS = ['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'];

const ready = () => ({state: 'ready', reason: 'all readiness evidence is current and successful'});
const no = reason => ({state: 'not_ready', reason});
const defer = reason => ({state: 'deferred', reason});

function reviewedSha(body = '') {
  return body.match(/\*\*Reviewed commit:\*\*\s*`([0-9a-f]{10,40})`/)?.[1] || null;
}

// Latest decisive (approve / request-changes / dismiss) review per human reviewer.
function decisiveByUser(reviews) {
  const latest = new Map();
  const sorted = [...reviews].sort((a, b) => Date.parse(a.submitted_at || 0) - Date.parse(b.submitted_at || 0));
  for (const r of sorted) {
    if (!r.user || isCodex(r.user) || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    latest.set(r.user.id, r);
  }
  return [...latest.values()];
}

// Pure decision over already-fetched evidence. Anything missing => not ready.
function decide(e, cfg = {}) {
  const {pr} = e;
  if (!pr || pr.state !== 'open') return no('PR is not open');
  if (pr.draft) return no('PR is a draft');
  if (pr.baseRef !== 'main') return no('PR does not target main');
  if (!pr.sha) return no('head revision unknown');
  if (pr.headRepo !== pr.baseRepo) return no('fork PRs are excluded');
  if (!(['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr.authorAssociation) || isClaude(pr.user))) return no('author is not trusted');
  if (pr.labels.some(l => OPT_OUT.includes(l))) return no('manual-merge/automation-paused label present');
  if (e.taskPaused) return no('linked task is paused');
  if (!Array.isArray(e.files) || e.files.some(f => protectedPath(f))) return no('automation infrastructure paths need separate review');

  // Mergeability: unknown is deferred, never guessed.
  if (pr.mergeable === null || pr.mergeable === undefined || pr.mergeableState === 'unknown') return defer('mergeability still unknown');
  if (pr.mergeable === false || pr.mergeableState === 'dirty') return no('merge conflicts');
  if (pr.mergeableState !== 'clean') return no(`mergeable_state is ${pr.mergeableState}`);

  // Required CI: the exact Automation CI run for this head, plus its jobs.
  const run = (e.runs || []).filter(r => r.path?.split('@')[0] === CI_WORKFLOW && r.head_sha === pr.sha &&
    (r.pull_requests || []).some(p => p.number === pr.number)).sort((a, b) => b.id - a.id)[0];
  if (!run) return no('Automation CI has not run on this head');
  if (run.status !== 'completed') return no('Automation CI is not finished');
  if (run.conclusion !== 'success') return no(`Automation CI concluded ${run.conclusion}`);
  const checks = (e.checks || []).filter(c => !OWN_CHECKS.includes(c.name));
  for (const name of REQUIRED_CHECKS) {
    const found = checks.filter(c => c.name === name && c.app?.slug === 'github-actions');
    if (!found.length) return no(`required check ${name} missing`);
    if (!found.every(c => c.status === 'completed' && c.conclusion === 'success')) return no(`required check ${name} not successful`);
  }
  for (const c of checks) {
    if (c.status !== 'completed') return no(`check ${c.name} is pending`);
    if (BAD_CONCLUSIONS.includes(c.conclusion)) return no(`check ${c.name} ${c.conclusion}`);
  }
  if ((e.statuses || []).some(s => s.state !== 'success')) return no('a commit status is not successful');

  // Human reviews.
  const human = decisiveByUser(e.reviews || []);
  if (human.some(r => r.state === 'CHANGES_REQUESTED')) return no('active change request');
  const need = cfg.requiredApprovals || 0;
  const approvals = human.filter(r => r.state === 'APPROVED' && r.user.type === 'User' &&
    (!cfg.requireFreshApprovals || r.commit_id === pr.sha));
  if (approvals.length < need) return no(`needs ${need} human approval(s), has ${approvals.length}`);

  // Review threads: every thread, resolved state from GraphQL.
  if (!Array.isArray(e.threads)) return no('review threads unknown');
  if (e.threads.some(t => !t.isResolved)) return no('unresolved review threads');

  // Codex: needs an explicit clean result for this exact head. A resolved thread,
  // a COMMENTED review, or a finished run is not approval.
  const codex = e.codex || {};
  const summaries = (codex.summaries || []).filter(c => isCodex(c.user)).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
  const summary = summaries.at(-1);
  if (summary && /\bRunning\b/i.test(summary.body.split(/Reviewed commit/i)[0])) return no('Codex review is running');
  let evidenceAt = null;
  if (summary && CLEAN_RE.test(summary.body) && summary.reviewedSha === pr.sha) evidenceAt = Date.parse(summary.updated_at);
  const bound = (codex.requests || []).filter(c => c.body?.includes(`<!-- codex-auto-merge:${pr.sha}:`))
    .find(c => (codex.reactions?.[c.id] || []).some(r => r.content === '+1' && isCodex(r.user)));
  if (evidenceAt === null && bound) {
    evidenceAt = Math.max(...codex.reactions[bound.id].filter(r => r.content === '+1' && isCodex(r.user)).map(r => Date.parse(r.created_at)));
  }
  if (evidenceAt === null) return no('no clean Codex result for this head');
  // A review request newer than the clean evidence means a newer review is pending.
  const pending = (codex.requests || []).some(c => Date.parse(c.created_at) > evidenceAt &&
    !(codex.reactions?.[c.id] || []).some(r => r.content === '+1' && isCodex(r.user)));
  if (pending) return no('a newer Codex review is pending');
  const cr = (e.reviews || []).filter(r => isCodex(r.user) && r.commit_id === pr.sha);
  if (cr.some(r => r.state === 'CHANGES_REQUESTED' || Date.parse(r.submitted_at) > evidenceAt)) return no('Codex posted findings after the clean result');
  return ready();
}

// Which PR numbers an event concerns. Anything unverified => nothing.
function routeEvent(context) {
  const p = context.payload || {};
  const repoFull = `${context.repo.owner}/${context.repo.repo}`;
  switch (context.eventName) {
    case 'pull_request': case 'pull_request_target': case 'pull_request_review':
    case 'pull_request_review_comment': case 'pull_request_review_thread':
      return {numbers: p.pull_request?.number ? [p.pull_request.number] : []};
    case 'issue_comment':
      // Only the verified Codex reviewer can change readiness through discussion.
      return {numbers: p.issue?.pull_request && isCodex(p.comment?.user) ? [p.issue.number] : []};
    case 'workflow_run': {
      const w = p.workflow_run;
      if (!w || w.event !== 'pull_request' || w.repository?.full_name !== repoFull || w.head_repository?.full_name !== repoFull) return {numbers: []};
      return {numbers: (w.pull_requests || []).map(x => x.number), headSha: w.head_sha};
    }
    case 'repository_dispatch': {
      const n = p.client_payload?.pr_number;
      return {numbers: Number.isInteger(n) && n > 0 ? [n] : []};
    }
    case 'workflow_dispatch': {
      const n = Number(p.inputs?.pr_number);
      return {numbers: Number.isInteger(n) && n > 0 ? [n] : []};
    }
    case 'schedule': return {numbers: [], sweep: true};
    default: return {numbers: []};
  }
}

const THREADS_QUERY = `query($owner:String!,$repo:String!,$n:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{isResolved}}}}}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gather({github, owner, repo, number, retries = 3, delayMs = 4000}) {
  let pr;
  for (let i = 0; i < retries; i++) {
    ({data: pr} = await github.rest.pulls.get({owner, repo, pull_number: number}));
    if (pr.mergeable !== null || pr.state !== 'open' || pr.draft) break;
    await sleep(delayMs);
  }
  const sha = pr.head.sha;
  const page = (fn, params) => github.paginate(fn, {owner, repo, per_page: 100, ...params});
  const taskPaused = async () => {
    for (const n of linkedIssues(pr)) {
      const {data: t} = await github.rest.issues.get({owner, repo, issue_number: n});
      if (t.labels.some(l => OPT_OUT.includes(l.name))) return true;
    }
    return false;
  };
  const [files, runs, checks, statusesRaw, reviews, discussion] = await Promise.all([
    page(github.rest.pulls.listFiles, {pull_number: number}),
    page(github.rest.actions.listWorkflowRuns, {workflow_id: 'ci.yml', head_sha: sha, event: 'pull_request'}),
    page(github.rest.checks.listForRef, {ref: sha, filter: 'latest'}),
    page(github.rest.repos.listCommitStatusesForRef, {ref: sha}),
    page(github.rest.pulls.listReviews, {pull_number: number}),
    page(github.rest.issues.listComments, {issue_number: number}),
  ]);
  // Statuses are newest-first; keep the latest per context.
  const statuses = [...new Map(statusesRaw.slice().reverse().map(s => [s.context, s])).values()];
  const threads = [];
  let after = null;
  do {
    const r = (await github.graphql(THREADS_QUERY, {owner, repo, n: number, after})).repository.pullRequest.reviewThreads;
    threads.push(...r.nodes);
    after = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (after);
  const summaries = discussion.filter(c => isCodex(c.user) && c.body?.includes(SUMMARY_MARKER));
  for (const s of summaries) {
    const ref = reviewedSha(s.body);
    s.reviewedSha = ref ? (await github.rest.repos.getCommit({owner, repo, ref})).data.sha : null;
  }
  const requests = discussion.filter(c => /^@codex review\b/m.test(c.body || ''));
  const reactions = {};
  for (const c of requests) reactions[c.id] = await page(github.rest.reactions.listForIssueComment, {comment_id: c.id});
  return {
    pr: {number, state: pr.state, draft: pr.draft, baseRef: pr.base.ref, sha, user: pr.user,
      authorAssociation: pr.author_association, labels: pr.labels.map(l => l.name),
      headRepo: pr.head.repo?.full_name, baseRepo: pr.base.repo.full_name,
      mergeable: pr.mergeable, mergeableState: pr.mergeable_state},
    files: files.flatMap(f => [f.filename, f.previous_filename].filter(Boolean)),
    taskPaused: await taskPaused(), runs, checks, statuses, reviews, threads,
    codex: {summaries, requests, reactions},
  };
}

async function ensureLabel({github, owner, repo}) {
  try { await github.rest.issues.getLabel({owner, repo, name: LABEL}); }
  catch (e) {
    if (e.status !== 404) throw e;
    await github.rest.issues.createLabel({owner, repo, name: LABEL, color: '0e8a16',
      description: 'Eligible for the external merge routine; handoff signal only'});
  }
}

async function removeLabel({github, owner, repo, number}) {
  try { await github.rest.issues.removeLabel({owner, repo, issue_number: number, name: LABEL}); }
  catch (e) { if (e.status !== 404) throw e; }
}

async function evaluatePr({github, core, owner, repo, number, cfg = {}, dryRun = false, gatherFn = gather}) {
  let e1;
  try {
    e1 = await gatherFn({github, owner, repo, number});
  } catch (err) {
    // Unknown evidence fails closed: withdraw any existing label, then surface the error.
    core.warning(`#${number}: evidence unavailable (${err.status || err.name}); failing closed`);
    if (!dryRun) {
      const {data} = await github.rest.issues.get({owner, repo, issue_number: number});
      if (data.labels.some(l => l.name === LABEL)) await removeLabel({github, owner, repo, number});
    }
    return {state: 'not_ready', reason: 'evidence unavailable'};
  }
  const has = e1.pr.labels.includes(LABEL);
  const d1 = decide(e1, cfg);
  core.info(`#${number}: ${d1.state} - ${d1.reason}`);
  if (d1.state === 'deferred') return d1; // no mutation; re-evaluated on the next event/sweep
  if (d1.state === 'not_ready') {
    if (has && !dryRun) { await removeLabel({github, owner, repo, number}); core.info(`#${number}: removed ${LABEL}`); }
    return d1;
  }
  if (has) return d1; // unchanged: no label mutation
  // Ready transition: re-read everything immediately before writing.
  const e2 = await gatherFn({github, owner, repo, number});
  const d2 = decide(e2, cfg);
  if (d2.state !== 'ready' || e2.pr.sha !== e1.pr.sha || e2.pr.labels.includes(LABEL)) {
    core.info(`#${number}: state changed before write; not labeling`); return d2;
  }
  if (dryRun) return d2;
  await ensureLabel({github, owner, repo});
  await github.rest.issues.addLabels({owner, repo, issue_number: number, labels: [LABEL]});
  // Labels carry no head-SHA guard: verify afterwards and withdraw if raced.
  const {data: after} = await github.rest.pulls.get({owner, repo, pull_number: number});
  if (after.head.sha !== e2.pr.sha || after.state !== 'open' || after.draft || after.base.ref !== 'main') {
    await removeLabel({github, owner, repo, number});
    core.warning(`#${number}: head/state changed during labeling; label removed`);
    return no('raced with a push');
  }
  core.info(`#${number}: added ${LABEL} at ${e2.pr.sha}`);
  return d2;
}

async function run({github, context, core}) {
  const {owner, repo} = context.repo;
  const cfg = {
    requiredApprovals: Number(process.env.MERGE_READY_REQUIRED_APPROVALS || 0),
    requireFreshApprovals: process.env.MERGE_READY_FRESH_APPROVALS === 'true',
  };
  const dryRun = process.env.MERGE_READY_DRY_RUN === 'true';
  let {numbers, sweep, headSha} = routeEvent(context);
  if (headSha && !numbers.length) {
    const assoc = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {owner, repo, commit_sha: headSha, per_page: 100});
    numbers = assoc.filter(p => p.state === 'open' && p.base.ref === 'main' && p.head.sha === headSha).map(p => p.number);
  }
  if (sweep) {
    // Bounded polling backstop for signals with no Actions trigger (thread
    // resolution, Codex reaction-only completion).
    const open = await github.paginate(github.rest.pulls.list, {owner, repo, state: 'open', base: 'main', per_page: 100});
    numbers = open.filter(p => !p.draft).slice(0, 25).map(p => p.number);
  }
  if (!numbers.length) return core.info('No relevant PR for this event.');
  for (const number of [...new Set(numbers)]) {
    try { await evaluatePr({github, core, owner, repo, number, cfg, dryRun}); }
    catch (err) { core.setFailed(`#${number}: ${err.status || err.name}`); }
  }
}

module.exports = {run, decide, routeEvent, evaluatePr, gather, reviewedSha, decisiveByUser, LABEL};
