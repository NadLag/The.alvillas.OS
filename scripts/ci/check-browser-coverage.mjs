import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readdirSync,readFileSync,writeFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import process from "node:process";
import console from "node:console";

const directory=process.argv[2]??"ci-browser-evidence",reference=JSON.parse(readFileSync("ci-evidence/checks-start.json","utf8")),projects=["chromium","field-mobile"];
const read=path=>JSON.parse(readFileSync(path,"utf8"));
function cases(report){const result=[];function visit(suite,parents=[]){const titles=[...parents,suite.title];for(const spec of suite.specs??[])for(const test of spec.tests??[])result.push({id:JSON.stringify([test.projectName,spec.file??suite.file,spec.line,spec.column,...titles,spec.title]),project:test.projectName,test});for(const child of suite.suites??[])visit(child,titles);}for(const suite of report.suites??[])visit(suite);return result;}
const folders=readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>join(directory,entry.name)),proof=[];
assert.equal(folders.length,projects.length,"Exactly both original browser project artifacts are required");
for(const project of projects){
 const matches=folders.filter(folder=>existsSync(join(folder,`playwright-${project}-start.json`)));assert.equal(matches.length,1,"Every original project must have exactly one source manifest");const folder=matches[0],start=read(join(folder,`playwright-${project}-start.json`)),end=read(join(folder,`playwright-${project}-end.json`));
 assert.equal(start.stage,"start");assert.equal(end.stage,"end");for(const manifest of[start,end]){assert.equal(manifest.job,"playwright");assert.equal(manifest.browserProject,project);assert.equal(manifest.sourceHead,reference.sourceHead);assert.equal(manifest.expectedHead,reference.sourceHead);assert.equal(manifest.sourceTree,reference.sourceTree);assert.equal(manifest.testContentSha256,reference.testContentSha256);assert.equal(manifest.lockSha256,reference.lockSha256);assert.equal(manifest.runId,reference.runId);assert.equal(manifest.runAttempt,reference.runAttempt);assert.equal(manifest.browserRetries,0);}assert.equal(end.status,"success");
 const expected=cases(read(join(folder,"playwright-expected.json"))),report=read(join(folder,"playwright.json")),actual=cases(report),expectedIds=expected.map(item=>item.id).sort(),actualIds=actual.map(item=>item.id).sort();assert(expected.length>0);assert.equal(new Set(expectedIds).size,expected.length);assert(expected.every(item=>item.project===project));assert.deepEqual(actualIds,expectedIds,"Every discovered original case must be reported exactly once");assert.equal(report.config.workers,1);assert.equal(report.config.projects.find(value=>value.name===project)?.retries,0);assert.equal(report.stats.skipped,0);assert.equal(report.stats.unexpected,0);assert.equal(report.stats.flaky,0);assert.equal(report.stats.expected,expected.length);
 for(const item of actual){assert.equal(item.project,project);assert.equal(item.test.expectedStatus,"passed");assert.equal(item.test.status,"expected");assert.equal(item.test.results.length,1,"Browser retries cannot satisfy mandatory acceptance");assert.equal(item.test.results[0].status,"passed");assert.equal(item.test.results[0].retry,0);}
 proof.push({project,cases:expected.length,caseIdentitySha256:createHash("sha256").update(JSON.stringify(expectedIds)).digest("hex"),browserRetries:0});
}
const output="ci-evidence/browser-coverage.json";assert(!existsSync(output),"Retain the original coverage evidence");const result={at:new Date().toISOString(),sourceHead:reference.sourceHead,sourceTree:reference.sourceTree,testContentSha256:reference.testContentSha256,lockSha256:reference.lockSha256,projects:proof,totalPassed:proof.reduce((sum,project)=>sum+project.cases,0),skipped:0,unexpected:0,flaky:0,browserRetries:0};writeFileSync(output,JSON.stringify(result,null,2)+"\n",{flag:"wx"});console.log(JSON.stringify(result));
