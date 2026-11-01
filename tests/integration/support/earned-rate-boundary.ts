/** Select a UTC rate-change boundary whose complete later segment precedes actual completion. */
export function completedRateBoundary(completedAt:Date,millisecondsAfterBoundary:number):Date{
 if(!Number.isSafeInteger(millisecondsAfterBoundary)||millisecondsAfterBoundary<0)throw new RangeError("Exact nonnegative fixture margin required");
 const latest=new Date(completedAt.getTime()-millisecondsAfterBoundary);
 return new Date(latest.toISOString().slice(0,10)+"T00:00:00.000Z");
}
