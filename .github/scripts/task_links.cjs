'use strict';
// Every controller uses the same union of branch and closing-reference task links.
function linkedIssues(pr){
 const branch=pr.head?.ref?.match(/^issue\/(\d+)-/);
 const body=[...(pr.body||'').matchAll(/\b(?:closes|fixes|resolves)\s+#(\d+)\b/gi)];
 return [...new Set([...(branch?[Number(branch[1])]:[]),...body.map(m=>Number(m[1]))])];
}
module.exports={linkedIssues};
