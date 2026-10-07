const test=require('node:test'),assert=require('node:assert/strict');
const {linkedIssues}=require('./task_links.cjs');
test('all branch/body task links are combined and deduplicated',()=>{
 assert.deepEqual(linkedIssues({head:{ref:'issue/8-x'},body:'Closes #10\nFixes #8\nResolves #12'}),[8,10,12]);
 assert.deepEqual(linkedIssues({head:{ref:'feature/x'},body:'Closes #10\nFixes #12'}),[10,12]);
 assert.deepEqual(linkedIssues({head:{ref:'feature/x'},body:'Discuss #8'}),[]);
});
