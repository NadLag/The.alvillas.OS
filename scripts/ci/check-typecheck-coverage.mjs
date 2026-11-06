import {readdirSync,readFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import process from "node:process";
import console from "node:console";
import {requireCompleteTypecheckCoverage,writeTypecheckEvidence} from "./typecheck-evidence.mjs";

const directory=process.argv[2]??"ci-typecheck-evidence",read=file=>JSON.parse(readFileSync(file,"utf8")),reference=read("ci-evidence/checks-start.json"),folders=readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>join(directory,entry.name));
const statics=folders.filter(folder=>existsSync(join(folder,"typecheck-complete.json")));if(statics.length!==1)throw Error("Exactly one complete static compiler manifest required");
const builds=folders.filter(folder=>existsSync(join(folder,"build-typecheck.json"))).map(folder=>read(join(folder,"build-typecheck.json"))),proof=requireCompleteTypecheckCoverage(reference,read(join(statics[0],"typecheck-complete.json")),builds);
writeTypecheckEvidence(process.cwd(),"typecheck-coverage.json",proof);console.log(JSON.stringify({sourceHead:proof.sourceHead,checkedProjects:proof.checkedProjects,applicationBuilds:proof.applicationBuilds,allOriginalInputs:true}));
