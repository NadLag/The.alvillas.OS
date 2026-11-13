type QueryLogEvent = {query:string};

/** Prisma's native query log callback may arrive after the query promise resolves. */
export function transactionQueryMeter(subscribe:(listener:(event:QueryLogEvent)=>void)=>void,options:{transactions?:number}={}){
  const expected=options.transactions??1;if(!Number.isSafeInteger(expected)||expected<1)throw new Error("A complete positive native transaction count is required");
  let active:{queries:number;connectionProbes:number;begins:number;commits:number;outsideStatement:boolean;commit:()=>void}|null=null;
  subscribe(event=>{
    if(!active)return;
    const query=event.query.trim().replace(/;$/u,"").toUpperCase();
    // The pool may validate a previously idle connection before BEGIN. Retain
    // that exact probe separately; every statement inside BEGIN/COMMIT counts.
    if(active.begins===active.commits&&query==="SELECT 1"){active.connectionProbes++;return;}
    const open=active.begins-active.commits;
    if(query==="BEGIN"?open!==0:open!==1)active.outsideStatement=true;
    active.queries++;
    if(query==="BEGIN")active.begins++;
    if(query==="COMMIT"){active.commits++;if(active.commits===expected)active.commit();}
  });
  return async function measure<T>(work:()=>Promise<T>):Promise<{result:T;queries:number;connectionProbes:number;elapsedMs:number}>{
    if(active)throw new Error("An isolated transaction measurement is already active");
    let received!:()=>void;
    const receipt=new Promise<void>(resolve=>{received=resolve;}),sample={queries:0,connectionProbes:0,begins:0,commits:0,outsideStatement:false,commit:received};
    active=sample;
    try{
      const started=performance.now(),result=await work(),elapsedMs=performance.now()-started;
      // Keep counting every actual statement, including the terminal COMMIT.
      // The existing test deadline still bounds a missing native log receipt.
      await receipt;
      if(sample.begins!==expected||sample.commits!==expected||sample.outsideStatement)throw new Error((expected===1?"One complete native transaction":expected+" complete native transactions")+" required for query measurement");
      return{result,queries:sample.queries,connectionProbes:sample.connectionProbes,elapsedMs};
    }finally{active=null;}
  };
}
