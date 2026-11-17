import process from "node:process";
import {readFileSync,writeFileSync} from "node:fs";
import {relative,sep} from "node:path";
import {ESLint} from "eslint";
const input=JSON.parse(readFileSync(0,"utf8")),lint=new ESLint({cwd:input.root}),results=await lint.lintFiles(input.files);
const formatter=await lint.loadFormatter("stylish"),formatted=formatter.format(results);if(formatted)process.stdout.write(formatted);
const report={files:results.map(value=>relative(input.root,value.filePath).split(sep).join("/")).sort(),errors:results.reduce((total,value)=>total+value.errorCount,0),warnings:results.reduce((total,value)=>total+value.warningCount,0)};
writeFileSync(input.report,JSON.stringify(report));process.exitCode=report.errors||report.warnings?1:0;
