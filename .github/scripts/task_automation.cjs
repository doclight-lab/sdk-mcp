'use strict';
const {isCodex, isClaude, protectedPath} = require('./codex_merge.cjs');
const R = require('./claude_resume.cjs');
const {linkedIssues} = require('./task_links.cjs');
const PREFIX = '<!-- doclight-task:v1:';
const MAX_FIXES = 3;
const CLOUD_MARKER = '<!-- doclight-task:cloud -->';
const CLOUD_LEASE_MS = 90*60e3;
const cloudMode = env=>env.CLAUDE_EXECUTION_MODE==='cloud';
const cloudLeased = (comments,meId,now)=>comments.some(c=>c.user?.id===meId&&(c.body||'').includes(CLOUD_MARKER)&&now-Date.parse(c.created_at)<CLOUD_LEASE_MS);
async function fireRoutine({url,token,text,fetch}){
  if(!/^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/.test(url||'')||!token)throw Error('Set CLAUDE_ROUTINE_URL and CLAUDE_ROUTINE_TOKEN for cloud mode');
  const res=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'anthropic-beta':'experimental-cc-routine-2026-04-01','anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({text})});
  if(!res.ok)throw Error(`Routine fire failed with HTTP ${res.status}`);
  const {claude_code_session_url:session}=await res.json();
  if(!/^https:\/\/claude\.ai\//.test(session||''))throw Error('Routine fire returned no session URL');
  return session;
}
const trusted = i => ['OWNER','MEMBER','COLLABORATOR'].includes(i.author_association);
const label = (i,n) => (i.labels||[]).some(l=>l.name===n);
async function canWrite(github,owner,repo,username){
  try {const {data:p}=await github.rest.repos.getCollaboratorPermissionLevel({owner,repo,username});return ['admin','write','maintain'].includes(p.permission);} catch {return false;}
}
async function approvedReady(github,owner,repo,issue){
  const events=await github.paginate(github.rest.issues.listEvents,{owner,repo,issue_number:issue.number,per_page:100});
  const event=events.filter(e=>e.event==='labeled'&&e.label?.name==='ready-for-claude').at(-1);
  return !!event && event.actor?.type==='User' && await canWrite(github,owner,repo,event.actor.login);
}
const normalize = s=>s.toLowerCase().replace(/[\s_-]/g,'');
function linkedIssue(pr,owner,repo) {
  const m = (pr.head.ref||'').match(/^issue\/(\d+)-/);
  if (m) return Number(m[1]);
  const matches = [...(pr.body||'').matchAll(/\b(?:closes|fixes|resolves)\s+#(\d+)\b/gi)];
  return matches.length===1 ? Number(matches[0][1]):null;
}
function fixReason(pr,reviews,inline,ci) {
  const sha=pr.head.sha;
  if (reviews.some(r=>isCodex(r.user)&&r.commit_id===sha&&r.state!=='APPROVED') || inline.some(c=>isCodex(c.user)&&(c.original_commit_id||c.commit_id)===sha)) return 'Codex review findings';
  if (ci?.status==='completed'&&ci.conclusion==='failure') return 'failed Automation CI';
  return null;
}
async function run({github,context,core,env=process.env,fetch=globalThis.fetch,now=Date.now()}) {
  const {owner,repo}=context.repo, full=`${owner}/${repo}`;
  const {data:me}=await github.rest.users.getAuthenticated();
  for(const [name,color] of [['ready-for-claude','0e8a16'],['automation-paused','d93f0b'],['no-auto','bfd4f2'],['priority:P0','b60205'],['priority:P1','d93f0b'],['priority:P2','fbca04'],['priority:P3','c2e0c6']]){
    try {await github.rest.issues.createLabel({owner,repo,name,color});}catch(e){if(e.status!==422)throw e;}
  }
  const commentsFor=n=>github.paginate(github.rest.issues.listComments,{owner,repo,issue_number:n,per_page:100});
  const own=(comments,key)=>comments.some(c=>c.user?.id===me.id&&(c.body||'').includes(`${PREFIX}${key} -->`));
  async function once(n,key,body){const comments=await commentsFor(n);if(own(comments,key))return false;await github.rest.issues.createComment({owner,repo,issue_number:n,body:body+`\n\n${PREFIX}${key} -->`});return true;}
  if(!cloudMode(env) || !env.CLAUDE_ROUTINE_URL || !env.CLAUDE_ROUTINE_TOKEN){core.info('Configure cloud mode and this repository routine before dispatch.');return;}
  async function dispatch(n,key,task){
    if(own(await commentsFor(n),key))return false;
    const tail=`\n\n${PREFIX}${key} -->\n${CLOUD_MARKER}`;
    const {data:lease}=await github.rest.issues.createComment({owner,repo,issue_number:n,body:'Dispatching to a Claude cloud session.'+tail});
    try{
      const session=await fireRoutine({url:env.CLAUDE_ROUTINE_URL,token:env.CLAUDE_ROUTINE_TOKEN,fetch,text:`Repository: ${full}\nTarget: #${n}\n\n${task}`});
      await github.rest.issues.updateComment({owner,repo,comment_id:lease.id,body:`Claude cloud session started: ${session}`+tail});
      return true;
    }catch(e){
      await github.rest.issues.deleteComment({owner,repo,comment_id:lease.id});
      core.warning(`#${n}: cloud dispatch failed: ${e.message}`);
      return false;
    }
  }
  const {data:meta}=await github.rest.repos.get({owner,repo});
  const all=await github.paginate(github.rest.issues.listForRepo,{owner,repo,state:'open',per_page:100});
  const prs=await github.paginate(github.rest.pulls.list,{owner,repo,state:'all',base:meta.default_branch,per_page:100});
  // Cloud-only: there is no runner implementation workflow to poll. Scheduled work is
  // still serialized across tasks; comment and resume runs keep their own locks.
  let busy=false;
  const associations=new Map();
  for(const pr of prs){for(const n of linkedIssues(pr)){const prev=associations.get(n);if(!prev || pr.state==='open' || (prev.state!=='open'&&pr.number>prev.number))associations.set(n,pr);}}
  const projectSync=!!(env.PROJECT_OWNER&&env.PROJECT_NUMBER);
  async function status(issue,name){if(!projectSync)return;try{await projectStatus(github,issue.node_id,name,env);}catch(e){core.warning(`#${issue.number}: project status not updated: ${e.message}`);}}
  for(const issue of all.filter(i=>!i.pull_request&&trusted(i))){
    if(label(issue,'automation-paused'))continue;
    const pr=associations.get(issue.number);
    const comments=await commentsFor(issue.number);
    const recovery=comments.map(R.parseState).filter(Boolean).pop();
    if(pr?.merged_at){await status(issue,'Done');continue;}
    if(pr?.state==='open'){await status(issue,'In Review');continue;}
    const started=own(comments,`start:${issue.number}`);
    if(started){await status(issue,'In Progress');
      if(!cloudLeased(comments,me.id,now))await once(issue.number,`no-pr-cloud:${issue.number}`,'Automation needs attention: the Claude cloud session has not opened a PR for this issue. Open the session linked above, then continue it or close it.');
      continue;
    }
    if(busy||!label(issue,'ready-for-claude')||recovery)continue;
    if(!await approvedReady(github,owner,repo,issue)){core.warning(`#${issue.number}: readiness approval lacks verified writer permission`);continue;}
    // Re-check readiness immediately before the mutation.
    const {data:fresh}=await github.rest.issues.get({owner,repo,issue_number:issue.number});
    if(fresh.state!=='open'||!label(fresh,'ready-for-claude')||label(fresh,'automation-paused'))continue;
    if(await dispatch(issue.number,`start:${issue.number}`,'Plan and execute this issue in English. Read the complete acceptance criteria and repository guidance. Use an issue/'+issue.number+'- branch from current main, reuse any linked existing PR, run relevant tests, commit and push, and actually create a PR with Closes #'+issue.number+'. Maintain the recovery checkpoint. Report blockers honestly.')){busy=true;await status(issue,'In Progress');}
  }
  for(const initial of prs.filter(p=>p.state==='open'&&!p.draft&&p.head.repo?.full_name===full&&(trusted(p)||isClaude(p.user)))){
    const {data:pr}=await github.rest.pulls.get({owner,repo,pull_number:initial.number});
    if(!isClaude(pr.user)&&!await canWrite(github,owner,repo,pr.user.login))continue;
    if(label(pr,'automation-paused')||label(pr,'manual-merge'))continue;
    const files=await github.paginate(github.rest.pulls.listFiles,{owner,repo,pull_number:pr.number,per_page:100});
    if(files.some(f=>protectedPath(f.filename)||protectedPath(f.previous_filename)))continue;
    const discussion=await commentsFor(pr.number);
    if(discussion.map(R.parseState).filter(Boolean).some(s=>['waiting','dispatched','running','blocked','exhausted','cancelled'].includes(s.status)))continue;
    let paused=false;
    for(const origin of linkedIssues(pr)){
      const {data:issue}=await github.rest.issues.get({owner,repo,issue_number:origin});
      if(label(issue,'automation-paused'))paused=true;
      const ic=await commentsFor(origin);
      if(ic.map(R.parseState).filter(Boolean).some(s=>['waiting','dispatched','running','blocked','exhausted','cancelled'].includes(s.status)))paused=true;
      if(cloudLeased(ic,me.id,now))paused=true;
    }
    if(paused||cloudLeased(discussion,me.id,now))continue;
    if(busy)continue;
    const reviews=await github.paginate(github.rest.pulls.listReviews,{owner,repo,pull_number:pr.number,per_page:100});
    const inline=await github.paginate(github.rest.pulls.listReviewComments,{owner,repo,pull_number:pr.number,per_page:100});
    const cis=await github.paginate(github.rest.actions.listWorkflowRuns,{owner,repo,workflow_id:'ci.yml',head_sha:pr.head.sha,event:'pull_request',per_page:100});
    const ci=cis.filter(r=>r.pull_requests.some(p=>p.number===pr.number)).sort((a,b)=>b.id-a.id)[0];
    let reason=fixReason(pr,reviews,inline,ci);
    const {data:main}=await github.rest.repos.getBranch({owner,repo,branch:meta.default_branch});
    const {data:cmp}=await github.rest.repos.compareCommits({owner,repo,base:main.commit.sha,head:pr.head.sha});
    if(!['ahead','identical'].includes(cmp.status))reason=reason||'update branch from current main and resolve any conflicts';
    if(!reason)continue;
    const fixes=discussion.filter(c=>c.user?.id===me.id&&(c.body||'').includes(`${PREFIX}fix:`)).length;
    if(fixes>=MAX_FIXES){await once(pr.number,'exhausted','Automation needs attention: three automatic correction attempts have been used. CI and clean review are still required; this PR remains open. Use an explicit human instruction to continue.');continue;}
    const key=`fix:${pr.head.sha}:${main.commit.sha}`;
    if(await dispatch(pr.number,key,`Continue this existing PR on branch ${pr.head.ref}; do not create a duplicate PR. Address ${reason}. Read current-head Codex inline findings and the latest CI failure logs, make focused corrections, update from current main if needed, run relevant tests, and push the same branch. Keep English checkpoints and actual validation. If a conflict or missing credential cannot be resolved safely, explain the blocker. Correction attempt ${fixes+1}/${MAX_FIXES}.`))busy=true;
  }
  // Closed issues including Closes-linked merged PRs must reach Done too. This only
  // reads issues when project sync is actually configured; otherwise status() is a
  // no-op and the extra API calls would be pure rate-limit burn.
  if(projectSync)for(const pr of prs.filter(p=>p.merged_at)){for(const n of linkedIssues(pr)){try{const {data:i}=await github.rest.issues.get({owner,repo,issue_number:n});await status(i,'Done');}catch(e){core.warning(`Done synchronization failed: ${e.status||e.name}`);}}}
}
// Project sync is opt-in: with no explicit PROJECT_OWNER/PROJECT_NUMBER this throws
// rather than falling back to any default board. The owner may be a user or an
// organization, so both are queried and whichever resolves is used.
async function projectStatus(github,content,name,env=process.env){
  const owner=env.PROJECT_OWNER,number=Number(env.PROJECT_NUMBER);
  if(!owner||!Number.isInteger(number)||number<=0)throw Error('Set PROJECT_OWNER and PROJECT_NUMBER to enable project sync');
  const result=await github.graphql(`query($owner:String!,$number:Int!){user(login:$owner){projectV2(number:$number){id fields(first:100){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}organization(login:$owner){projectV2(number:$number){id fields(first:100){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}`,{owner,number});
  const project=result.user?.projectV2||result.organization?.projectV2;if(!project)throw Error('Project not accessible');
  const field=project.fields.nodes.find(f=>f.name==='Status'&&f.options);if(!field)throw Error('Status field missing');
  const desired=env['PROJECT_'+name.toUpperCase().replace(/ /g,'_')+'_STATUS']||name;
  let option=field.options.find(o=>normalize(o.name)===normalize(desired));
  if(!option && name==='In Review') option=field.options.find(o=>normalize(o.name)==='inprogress');
  if(!option)throw Error('Configure status option '+desired);
  const r=await github.graphql(`mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`,{project:project.id,content});
  await github.graphql(`mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`,{project:project.id,item:r.addProjectV2ItemById.item.id,field:field.id,option:option.id});
}
module.exports={run,fixReason,linkedIssue,trusted,projectStatus,approvedReady,canWrite,fireRoutine,cloudLeased,CLOUD_MARKER};
