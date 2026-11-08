type QueryLogEvent = {query:string};

/** Prisma's native query log callback may arrive after the query promise resolves. */
export function transactionQueryMeter(subscribe:(listener:(event:QueryLogEvent)=>void)=>void){
  let active:{queries:number;begins:number;commits:number;commit:()=>void}|null=null;
  subscribe(event=>{
    if(!active)return;
    active.queries++;
    const query=event.query.trim().replace(/;$/u,"").toUpperCase();
    if(query==="BEGIN")active.begins++;
    if(query==="COMMIT"){active.commits++;active.commit();}
  });
  return async function measure<T>(work:()=>Promise<T>):Promise<{result:T;queries:number;elapsedMs:number}>{
    if(active)throw new Error("An isolated transaction measurement is already active");
    let received!:()=>void;
    const receipt=new Promise<void>(resolve=>{received=resolve;}),sample={queries:0,begins:0,commits:0,commit:received};
    active=sample;
    try{
      const started=performance.now(),result=await work(),elapsedMs=performance.now()-started;
      // Keep counting every actual statement, including the terminal COMMIT.
      // The existing test deadline still bounds a missing native log receipt.
      await receipt;
      if(sample.begins!==1||sample.commits!==1)throw new Error("One complete native transaction is required for query measurement");
      return{result,queries:sample.queries,elapsedMs};
    }finally{active=null;}
  };
}
