import { z } from "zod";

/** The date field explicitly uses UTC; neither browser nor server timezone can reinterpret it. */
const field = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u).refine(value => {
  const iso=value+":00.000Z",time=Date.parse(iso);return Number.isFinite(time)&&new Date(time).toISOString()===iso;
},"invalid_document_effective_time");
export function documentEffectiveFromUtc(value:string):string|null{return value===""?null:field.parse(value)+":00.000Z";}
export const documentEffectiveHistoryFormat="DOCUMENT_EFFECTIVE_HISTORY_V1";
