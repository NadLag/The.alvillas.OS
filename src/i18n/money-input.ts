/** Shared field/admin normalization; domain Money validation still controls accepted amounts. */
export function normalizeMoneyInput(value:string):string{
  return value.replace(/[\u0660-\u0669\u06f0-\u06f9]/gu,digit=>String(digit.charCodeAt(0)-(digit.charCodeAt(0)>=0x6f0?0x6f0:0x660)))
    .replace(/[\u066b,]/gu,".").replace(/^0+(?=\d)/u,"");
}
