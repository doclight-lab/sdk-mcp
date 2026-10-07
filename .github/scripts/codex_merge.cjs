const {linkedIssues} = require('./task_links.cjs');
const BOT_ID = 199175422;
const BOT = 'chatgpt-codex-connector[bot]';
const isClaude = user => user?.id === 209825114 && user?.login === 'claude[bot]' && user?.type === 'Bot';
const isCodex = user => user?.id === BOT_ID && user?.login === BOT && user?.type === 'Bot';

function cleanCommitRef(body = '') {
  if (!/^Codex Review: Didn't find any major issues\./.test(body)) return null;
  return body.match(/\*\*Reviewed commit:\*\*\s*`([0-9a-f]{10,40})`/)?.[1] || null;
}

function reviewClean({sha, request, reactions, reviews, comments, cleanEvidence}) {
  if (!request) return false;
  const c = cleanEvidence?.comment;
  const ref = cleanCommitRef(c?.body);
  const cleanText = c && isCodex(c.user) && c.created_at >= request.created_at &&
    ref && sha.startsWith(ref) && cleanEvidence.resolvedSha === sha;
  if (!cleanText && !reactions.some(r => r.content === '+1' && isCodex(r.user))) return false;
  // Never treat silence, an eyes reaction, or merely resolving a thread as approval.
  if (reviews.some(r => r.commit_id === sha &&
      (r.state === 'CHANGES_REQUESTED' || (isCodex(r.user) && r.state !== 'APPROVED')))) return false;
  return !comments.some(c => isCodex(c.user) && (c.original_commit_id || c.commit_id) === sha);
}

function checksClean(checks, statuses) {
  return checks.length > 0 && checks.every(c => c.status === 'completed' &&
    ['success', 'neutral', 'skipped'].includes(c.conclusion)) &&
    statuses.every(s => s.state === 'success');
}

function protectedPath(path = '') {
  return path.startsWith('.github/workflows/') ||
    path.startsWith('.github/scripts/ci_') ||
    path.startsWith('.github/scripts/codex_merge') ||
    path.startsWith('.github/scripts/claude_resume') ||
    path.startsWith('.github/claude-resume/') || path.startsWith('.claude/hooks/') || path === '.claude/settings.json' || path.startsWith('.github/scripts/task_automation') || path.startsWith('.github/scripts/task_links') || path.startsWith('.github/scripts/merge_ready');
}

async function run({github, context, core}) {
  const {owner, repo} = context.repo;
  const {data: me} = await github.rest.users.getAuthenticated();
  const prs = await github.paginate(github.rest.pulls.list, {owner, repo, state:'open', base:'main', per_page:100});
  for (const initial of prs) {
    const n = initial.number;
    if (initial.draft || initial.head.repo?.full_name !== `${owner}/${repo}` ||
        (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(initial.author_association) && !isClaude(initial.user)) ||
        initial.labels.some(l => ['manual-merge','automation-paused'].includes(l.name))) continue;
    try {
      const {data: pr} = await github.rest.pulls.get({owner, repo, pull_number:n});
      const files = await github.paginate(github.rest.pulls.listFiles, {owner, repo, pull_number:n, per_page:100});
      if (pr.changed_files >= 3000 || files.some(f => protectedPath(f.filename) || protectedPath(f.previous_filename))) {
        core.info(`#${n}: automation infrastructure changes require a separate trusted setup review`); continue;
      }
      const taskPaused = async (snapshot = pr) => {for(const n of linkedIssues(snapshot)){const {data:task}=await github.rest.issues.get({owner,repo,issue_number:n});if(task.labels.some(l=>l.name==='automation-paused'))return true;}return false;};
      if(await taskPaused())continue;
      const sha = pr.head.sha;
      const {data: main} = await github.rest.repos.getBranch({owner, repo, branch:'main'});
      const base = main.commit.sha;
      // CI must include current main, not an older base. No automatic conflict resolution.
      const {data: comparison} = await github.rest.repos.compareCommits({owner, repo, base, head:sha});
      if (!['ahead', 'identical'].includes(comparison.status)) {
        core.info(`#${n}: branch needs an update from main`); continue;
      }
      const marker = `<!-- codex-auto-merge:${sha}:${base} -->`;
      const discussion = await github.paginate(github.rest.issues.listComments, {owner, repo, issue_number:n, per_page:100});
      const requests = discussion.filter(c => c.user.id === me.id && c.body?.includes(marker));
      let request = requests.at(-1);
      // Bounded retry for a missing reviewer result; never interpret silence as approval.
      const sameHeadResults = discussion.some(c=>isCodex(c.user)&&cleanCommitRef(c.body)&&sha.startsWith(cleanCommitRef(c.body)));
      const headReviews = await github.paginate(github.rest.pulls.listReviews,{owner,repo,pull_number:n,per_page:100});
      if (request && !sameHeadResults && !headReviews.some(r=>isCodex(r.user)&&r.commit_id===sha) && requests.length < 3 && Date.now()-Date.parse(request.created_at)>6*3600e3) request = null;
      if (!request) {
        // A PAT-authored request triggers the subscription-based reviewer. GITHUB_TOKEN
        // events cannot be assumed to trigger another automation.
        await github.rest.issues.createComment({owner, repo, issue_number:n, body:
          `@codex review\n\nReview the current head ${sha} against main ${base}. This PR is eligible for automatic merge only after CI passes and your clean-review thumbs-up on this request or standard no-major-issues summary naming the reviewed commit. Report consequential findings normally. Do not merge or change repository settings.\n\n${marker}`});
        core.info(`#${n}: requested review of ${sha}`); continue;
      }
      const reactions = await github.paginate(github.rest.reactions.listForIssueComment, {owner, repo, comment_id:request.id, per_page:100});
      const reviews = await github.paginate(github.rest.pulls.listReviews, {owner, repo, pull_number:n, per_page:100});
      const comments = await github.paginate(github.rest.pulls.listReviewComments, {owner, repo, pull_number:n, per_page:100});
      let cleanEvidence;
      for (const comment of discussion.filter(c => isCodex(c.user) &&
          c.created_at >= request.created_at && cleanCommitRef(c.body))) {
        const {data: resolved} = await github.rest.repos.getCommit({owner, repo, ref:cleanCommitRef(comment.body)});
        if (resolved.sha === sha) { cleanEvidence = {comment, resolvedSha:resolved.sha}; break; }
      }
      if (!reviewClean({sha, request, reactions, reviews, comments, cleanEvidence})) {
        core.info(`#${n}: waiting for a clean Codex result`); continue;
      }
      // Require a successful run of OUR CI workflow on this head. A skipped job,
      // similarly named external check, or no CI run is insufficient.
      const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
        owner, repo, workflow_id:'ci.yml', head_sha:sha, event:'pull_request', per_page:100});
      const ci = runs.filter(r => r.path.split('@')[0] === '.github/workflows/ci.yml' &&
        r.pull_requests.some(p => p.number === n)).sort((a,b) => b.id-a.id)[0];
      if (!ci || ci.status !== 'completed' || ci.conclusion !== 'success') {
        core.info(`#${n}: waiting for Automation CI`); continue;
      }
      const checks = await github.paginate(github.rest.checks.listForRef, {owner, repo, ref:sha, filter:'latest', per_page:100});
      const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {owner, repo, ref:sha, per_page:100});
      const latestStatuses = [...new Map(statuses.map(s => s.context).map(name => [name,statuses.find(s => s.context === name)])).values()];
      if (!checksClean(checks, latestStatuses)) { core.info(`#${n}: other checks are pending or failed`); continue; }
      // Refresh immediately before mutation, then use GitHub's SHA guard. GitHub
      // still enforces any rulesets; this workflow never bypasses or edits them.
      const {data: fresh} = await github.rest.pulls.get({owner, repo, pull_number:n});
      const {data: freshBase} = await github.rest.repos.getBranch({owner, repo, branch:'main'});
      if (fresh.state !== 'open' || fresh.draft || fresh.head.sha !== sha ||
          freshBase.commit.sha !== base || fresh.mergeable_state !== 'clean' ||
          fresh.labels.some(l => ['manual-merge','automation-paused'].includes(l.name))) continue;
      if(await taskPaused(fresh))continue;
      if (process.env.AUTO_MERGE_DRY_RUN === 'true') { core.info(`#${n}: eligible (dry run)`); continue; }
      const result = {merged:false, message:'Review complete; merge is delegated to the external merge-ready routine.'};
      core.info(`#${n}: ${result.merged ? 'merged' : result.message}`);
    } catch (error) {
      // Fail closed for this PR, but keep evaluating independent PRs.
      core.warning(`#${n}: not merged (${error.status || error.name})`);
    }
  }
}
module.exports = {run, reviewClean, checksClean, protectedPath, cleanCommitRef, isCodex, isClaude};
