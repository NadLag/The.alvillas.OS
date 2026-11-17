import process from "node:process";
import {readdirSync,statSync} from "node:fs";
import {join,relative,resolve,sep} from "node:path";
import {pathToFileURL} from "node:url";
import {ESLint} from "eslint";

/** Use the actual flat configuration to retain ESLint's original target set.
 * Only unconditional global directory ignores prune traversal. File eligibility
 * always comes from ESLint, including its extension and processor configuration. */
export async function prepareLintPlan(root=process.cwd(),batchSize=96){
 if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>128)throw Error("Lint batches must contain 1–128 files");
 root=resolve(root);const lint=new ESLint({cwd:root}),configPath=await lint.findConfigFile();if(!configPath)throw Error("Original ESLint configuration required");
 const imported=(await import(pathToFileURL(configPath).href)).default,config=Array.isArray(imported)?imported:[imported];
 const ignores=config.filter(value=>value&&Object.keys(value).every(key=>key==="ignores"||key==="name")).flatMap(value=>value.ignores??[]).filter(value=>typeof value==="string");
 const prefixes=ignores.some(value=>value.startsWith("!"))?[]:ignores.flatMap(value=>/^[.\w-]+(?:\/[.\w-]+)*\/\*\*$/u.test(value)?[value.slice(0,-3)]:[]),files=[];
 async function walk(directory){
  for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
   const full=join(directory,entry.name),name=relative(root,full).split(sep).join("/");
   if(entry.name==="node_modules"||entry.name===".git"||prefixes.some(prefix=>name===prefix||name.startsWith(prefix+"/")))continue;
   if(entry.isDirectory())await walk(full);
   else if(entry.isSymbolicLink()&&statSync(full).isDirectory())throw Error("Unignored source directory links require explicit lint configuration");
   else if((entry.isFile()||entry.isSymbolicLink())&&await lint.calculateConfigForFile(full))files.push(name);
  }
 }
 await walk(root);files.sort();if(!files.length)throw Error("No original ESLint targets were discovered");
 return{root,files,batches:Array.from({length:Math.ceil(files.length/batchSize)},(_,index)=>files.slice(index*batchSize,(index+1)*batchSize))};
}
