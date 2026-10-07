const test = require('node:test');
const assert = require('node:assert/strict');
const {reviewClean, checksClean, protectedPath, cleanCommitRef} = require('./codex_merge.cjs');
const user = {id:199175422, login:'chatgpt-codex-connector[bot]', type:'Bot'};
const fixture = () => ({sha:'new', request:{created_at:'2026-10-03T10:00:00Z'},
  reactions:[{content:'+1',user}], reviews:[], comments:[]});
test('silence, eyes, and spoofed account never authorize merge', () => {
  for (const reactions of [[],[{content:'eyes',user}],[{content:'+1',user:{...user,id:1}}]])
    assert.equal(reviewClean({...fixture(),reactions}),false);
});
test('new commit findings and changes requested block a thumbs up', () => {
  assert.equal(reviewClean({...fixture(),comments:[{user,commit_id:'new',created_at:'2026-10-03T10:01:00Z'}]}),false);
  assert.equal(reviewClean({...fixture(),reviews:[{user,commit_id:'new',submitted_at:'2026-10-03T10:01:00Z',state:'COMMENTED'}]}),false);
});
test('only fresh request clean result passes; old commit findings are not carried forward', () => {
  assert.equal(reviewClean(fixture()),true);
  assert.equal(reviewClean({...fixture(),request:null}),false);
  assert.equal(reviewClean({...fixture(),comments:[{user,commit_id:'new',original_commit_id:'old',created_at:'2026-10-03T10:01:00Z'}]}),true);
});
test('missing CI, pending and failed checks/statuses block merge', () => {
  const ok={status:'completed',conclusion:'success'};
  assert.equal(checksClean([],[]),false);
  assert.equal(checksClean([ok,{status:'in_progress'}],[]),false);
  assert.equal(checksClean([ok,{status:'completed',conclusion:'failure'}],[]),false);
  assert.equal(checksClean([ok],[{state:'pending'}]),false);
  assert.equal(checksClean([ok],[{state:'success'}]),true);
});

test('a fresh clean reaction cannot hide earlier findings on the same unchanged head', () => {
  assert.equal(reviewClean({...fixture(),comments:[{user,commit_id:'new',created_at:'2026-10-03T09:00:00Z'}]}),false);
});

test('changes to CI/controller definitions cannot weaken the merge gate', () => {
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/new-ci.yml', '.github/scripts/ci_runtime.sh', '.github/scripts/codex_merge.cjs', '.github/scripts/claude_resume.cjs', '.github/scripts/claude_resume.test.cjs', '.github/claude-resume/claude.yml.changes.md'])
    assert.equal(protectedPath(path),true);
  assert.equal(protectedPath('backend/app/billing/service.py'),false);
});

test('native clean summary must come from Codex and resolve to the exact current commit', () => {
  const sha = 'a'.repeat(40);
  const comment = {user,created_at:'2026-10-03T10:01:00Z',body:"Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `aaaaaaaaaa`"};
  const input={...fixture(),sha,reactions:[],cleanEvidence:{comment,resolvedSha:sha}};
  assert.equal(cleanCommitRef(comment.body),'aaaaaaaaaa');
  assert.equal(reviewClean(input),true);
  assert.equal(reviewClean({...input,cleanEvidence:{comment,resolvedSha:'b'.repeat(40)}}),false);
  assert.equal(reviewClean({...input,cleanEvidence:{comment:{...comment,user:{...user,id:1}},resolvedSha:sha}}),false);
  assert.equal(reviewClean({...input,cleanEvidence:{comment:{...comment,created_at:'2026-10-03T09:00:00Z'},resolvedSha:sha}}),false);
});
test('generic positive comments and short/unattributed summaries are not approvals', () => {
  assert.equal(cleanCommitRef('Everything looks good. Reviewed commit: aaaaaaaaaa'),null);
  assert.equal(cleanCommitRef("Codex Review: Didn't find any major issues."),null);
});

test('only the verified installed Claude app bot can bypass human author association',()=>{
 const {isClaude}=require('./codex_merge.cjs');
 const bot={id:209825114,login:'claude[bot]',type:'Bot'};
 assert.equal(isClaude(bot),true);
 assert.equal(isClaude({...bot,id:1}),false);
 assert.equal(isClaude({...bot,type:'User'}),false);
 assert.equal(isClaude({id:209825114,login:'other[bot]',type:'Bot'}),false);
});
test('cloud session hook and settings are protected infrastructure', () => {
  assert.equal(protectedPath('.claude/hooks/session-start.sh'), true);
  assert.equal(protectedPath('.claude/settings.json'), true);
  assert.equal(protectedPath('.claude/skills/fastapi-backend/SKILL.md'), false);
});
