const test=require('node:test'),assert=require('node:assert/strict');
const A=require('./task_automation.cjs');
const bot={id:199175422,login:'chatgpt-codex-connector[bot]',type:'Bot'};
const pr={head:{sha:'new',ref:'issue/8-task'},body:'Closes #8'};
test('link same task without guessing ambiguous issue references',()=>{
 assert.equal(A.linkedIssue(pr),8);
 assert.equal(A.linkedIssue({head:{ref:'feature/a'},body:'Closes #8\nFixes #10'}),null);
 assert.equal(A.linkedIssue({head:{ref:'feature/a'},body:'Closes #8'}),8);
});
test('only exact-head authentic Codex findings trigger correction',()=>{
 assert.equal(A.fixReason(pr,[],[{user:bot,original_commit_id:'old',commit_id:'new'}],null),null);
 assert.equal(A.fixReason(pr,[],[{user:{...bot,id:4},commit_id:'new'}],null),null);
 assert.equal(A.fixReason(pr,[{user:bot,commit_id:'new',state:'COMMENTED'}],[],null),'Codex review findings');
 assert.equal(A.fixReason(pr,[{user:bot,commit_id:'new',state:'APPROVED'}],[],null),null);
});
test('pending, skipped or cancelled CI do not start a correction loop',()=>{
 for(const conclusion of ['success','skipped','cancelled',null])assert.equal(A.fixReason(pr,[],[],{status:'completed',conclusion}),null);
 assert.equal(A.fixReason(pr,[],[],{status:'completed',conclusion:'failure'}),'failed Automation CI');
});
test('untrusted issue authors are not admitted',()=>{
 assert.equal(A.trusted({author_association:'NONE'}),false);
 assert.equal(A.trusted({author_association:'OWNER'}),true);
});
test('readiness label actor must have actual write permission, association is insufficient',async()=>{
 const issue={number:8};
 const client=(permission,actor={login:'triager',type:'User'})=>({paginate:async()=>[{event:'labeled',label:{name:'ready-for-claude'},actor}],rest:{issues:{listEvents(){}},repos:{getCollaboratorPermissionLevel:async()=>({data:{permission}})}}});
 assert.equal(await A.approvedReady(client('triage'),'o','r',issue),false);
 assert.equal(await A.approvedReady(client('read'),'o','r',issue),false);
 assert.equal(await A.approvedReady(client('write'),'o','r',issue),true);
 assert.equal(await A.approvedReady(client('admin',{login:'bot',type:'Bot'}),'o','r',issue),false);
});

const URL='https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire';
const okFetch=calls=>async(url,init)=>{calls.push({url,init});return {ok:true,json:async()=>({claude_code_session_url:'https://claude.ai/code/session_1'})};};
test('routine fire sends bearer token, beta header and text, and returns the session URL',async()=>{
 const calls=[];
 assert.equal(await A.fireRoutine({url:URL,token:'tok',text:'do #8',fetch:okFetch(calls)}),'https://claude.ai/code/session_1');
 assert.equal(calls[0].init.headers.authorization,'Bearer tok');
 assert.equal(calls[0].init.headers['anthropic-beta'],'experimental-cc-routine-2026-04-01');
 assert.deepEqual(JSON.parse(calls[0].init.body),{text:'do #8'});
});
test('routine fire refuses foreign URLs, missing tokens and failed responses',async()=>{
 const calls=[];
 await assert.rejects(A.fireRoutine({url:'https://evil.example/v1/claude_code/routines/trig_1/fire',token:'tok',text:'x',fetch:okFetch(calls)}));
 await assert.rejects(A.fireRoutine({url:URL,token:'',text:'x',fetch:okFetch(calls)}));
 assert.equal(calls.length,0);
 await assert.rejects(A.fireRoutine({url:URL,token:'tok',text:'x',fetch:async()=>({ok:false,status:401})}),/401/);
 await assert.rejects(A.fireRoutine({url:URL,token:'tok',text:'x',fetch:async()=>({ok:true,json:async()=>({})})}),/session URL/);
});
test('cloud lease only counts own recent dispatch comments',()=>{
 const now=Date.parse('2026-10-04T12:00:00Z');
 const c=(id,mins,marker=A.CLOUD_MARKER)=>({user:{id},body:`x\n${marker}`,created_at:new Date(now-mins*60e3).toISOString()});
 assert.equal(A.cloudLeased([c(1,10)],1,now),true);
 assert.equal(A.cloudLeased([c(1,120)],1,now),false);
 assert.equal(A.cloudLeased([c(2,10)],1,now),false);
 assert.equal(A.cloudLeased([c(1,10,'')],1,now),false);
});

function sweep({fetch,env,comments=[],runs=[]}){
 const issue={number:8,title:'Task',node_id:'I8',author_association:'OWNER',labels:[{name:'ready-for-claude'}],state:'open'};
 const log={created:[],updated:[],deleted:[],warnings:[],labels:[]};
 const fn=name=>Object.assign(async(...a)=>impl[name](...a),{key:name});
 const impl={
  listForRepo:()=>[issue],pullsList:()=>[],runs:()=>runs,listMatchingRefs:()=>[],listComments:()=>comments,
  listEvents:()=>[{event:'labeled',label:{name:'ready-for-claude'},actor:{login:'owner',type:'User'}}],
 };
 const github={
  paginate:async(f,args)=>impl[f.key](args),
  graphql:async()=>{throw Error('no project');},
  rest:{
   users:{getAuthenticated:async()=>({data:{id:1}})},
   repos:{get:async()=>({data:{default_branch:'main'}}),getCollaboratorPermissionLevel:async()=>({data:{permission:'admin'}})},
   pulls:{list:fn('pullsList')},
   actions:{listWorkflowRuns:fn('runs')},
   git:{listMatchingRefs:fn('listMatchingRefs')},
   issues:{listForRepo:fn('listForRepo'),listComments:fn('listComments'),listEvents:fn('listEvents'),get:async()=>({data:issue}),
    createComment:async a=>{log.created.push(a.body);return {data:{id:77}};},
    createLabel:async a=>{log.labels.push(a.name);},
    updateComment:async a=>{log.updated.push(a.body);},
    deleteComment:async a=>{log.deleted.push(a.comment_id);}},
  },
 };
 const core={warning:m=>log.warnings.push(m),info(){}};
 return A.run({github,context:{repo:{owner:'o',repo:'r'}},core,env,fetch}).then(()=>log);
}
const CLOUD={CLAUDE_EXECUTION_MODE:'cloud',CLAUDE_ROUTINE_URL:URL,CLAUDE_ROUTINE_TOKEN:'tok'};
test('cloud mode fires the routine instead of posting an @claude comment',async()=>{
 const calls=[];
 const log=await sweep({fetch:okFetch(calls),env:CLOUD});
 assert.equal(calls.length,1);
 assert.match(JSON.parse(calls[0].init.body).text,/^Repository: o\/r\nTarget: #8\n/);
 assert.equal(log.created.length,1);
 assert.doesNotMatch(log.created[0],/@claude/);
 assert.match(log.updated[0],/session_1[\s\S]*doclight-task:v1:start:8 -->[\s\S]*doclight-task:cloud/);
});
test('a failed fire releases the lease so the next sweep retries',async()=>{
 const log=await sweep({fetch:async()=>({ok:false,status:500}),env:CLOUD});
 assert.deepEqual(log.deleted,[77]);
 assert.match(log.warnings.join(),/HTTP 500/);
});
test('unconfigured cloud never dispatches a runner task',async()=>{
 const calls=[];const log=await sweep({fetch:okFetch(calls),env:{}});
 assert.equal(calls.length,0);assert.equal(log.created.length,0);
});
test('an issue already dispatched to the cloud is not fired again',async()=>{
 const calls=[];
 const comments=[{user:{id:1},body:`started\n\n<!-- doclight-task:v1:start:8 -->\n${A.CLOUD_MARKER}`,created_at:new Date().toISOString()}];
 const log=await sweep({fetch:okFetch(calls),env:CLOUD,comments});
 assert.equal(calls.length,0);
 assert.equal(log.created.length,0);
});
test('the coordinator provisions triage labels for the issue triage routine',async()=>{
 const log=await sweep({fetch:okFetch([]),env:{}});
 for(const name of ['no-auto','priority:P0','priority:P1','priority:P2','priority:P3'])assert.ok(log.labels.includes(name),name);
});


const PROJECT_FIELDS={fields:{nodes:[{id:'F',name:'Status',options:[{id:'o1',name:'In Progress'},{id:'o2',name:'Done'}]}]}};
function projectClient(shape){
 const calls=[];
 return {calls,github:{graphql:async(q,v)=>{calls.push({q,v});
  if(/^query/.test(q))return shape;
  if(/addProjectV2ItemById/.test(q))return {addProjectV2ItemById:{item:{id:'IT'}}};
  return {updateProjectV2ItemFieldValue:{projectV2Item:{id:'IT'}}};}}};
}
test('project sync refuses to fall back to any default board when unconfigured',async()=>{
 const {github,calls}=projectClient({user:null,organization:null});
 await assert.rejects(A.projectStatus(github,'I8','Done',{}),/Set PROJECT_OWNER and PROJECT_NUMBER/);
 await assert.rejects(A.projectStatus(github,'I8','Done',{PROJECT_OWNER:'o'}),/Set PROJECT_OWNER and PROJECT_NUMBER/);
 await assert.rejects(A.projectStatus(github,'I8','Done',{PROJECT_OWNER:'o',PROJECT_NUMBER:'0'}),/Set PROJECT_OWNER and PROJECT_NUMBER/);
 await assert.rejects(A.projectStatus(github,'I8','Done',{PROJECT_OWNER:'o',PROJECT_NUMBER:'x'}),/Set PROJECT_OWNER and PROJECT_NUMBER/);
 assert.equal(calls.length,0,'no project is queried without explicit configuration');
});
test('an organization-owned project board is resolved, not only a user one',async()=>{
 const {github,calls}=projectClient({user:null,organization:{projectV2:{id:'P',...PROJECT_FIELDS}}});
 await A.projectStatus(github,'I8','Done',{PROJECT_OWNER:'doclight-lab',PROJECT_NUMBER:'3'});
 assert.deepEqual(calls[0].v,{owner:'doclight-lab',number:3});
 assert.match(calls[1].q,/addProjectV2ItemById/);
 assert.equal(calls[2].v.option,'o2');
});
test('a user-owned project board still resolves and honours a status name override',async()=>{
 const {github,calls}=projectClient({user:{projectV2:{id:'P',...PROJECT_FIELDS}},organization:null});
 await A.projectStatus(github,'I8','In Review',{PROJECT_OWNER:'degerahmet',PROJECT_NUMBER:'3',PROJECT_IN_REVIEW_STATUS:'done'});
 assert.equal(calls[2].v.option,'o2','the injected override is used instead of process.env');
});
test('an inaccessible project or missing Status field is reported, never guessed',async()=>{
 const cfg={PROJECT_OWNER:'o',PROJECT_NUMBER:'3'};
 await assert.rejects(A.projectStatus(projectClient({user:null,organization:null}).github,'I8','Done',cfg),/Project not accessible/);
 await assert.rejects(A.projectStatus(projectClient({user:{projectV2:{id:'P',fields:{nodes:[]}}}}).github,'I8','Done',cfg),/Status field missing/);
 await assert.rejects(A.projectStatus(projectClient({user:{projectV2:{id:'P',fields:{nodes:[{id:'F',name:'Status',options:[{id:'o1',name:'Backlog'}]}]}}}}).github,'I8','Done',cfg),/Configure status option/);
});
