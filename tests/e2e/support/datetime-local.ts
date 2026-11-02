/** Chromium omits zero seconds in datetime-local values; retain the exact same instant. */
export function datetimeLocalValue(date:Date){return date.toISOString().slice(0,19).replace(/:00$/u,"");}
