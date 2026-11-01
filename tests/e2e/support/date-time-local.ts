/** HTML datetime-local values omit zero seconds and trailing fractional zeros without changing the instant. */
export function utcDateTimeLocalValue(instant:Date):string{
 return instant.toISOString().slice(0,-1).replace(/\.000$/u,"").replace(/(\.\d*?[1-9])0+$/u,"$1").replace(/:00$/u,"");
}
