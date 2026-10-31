import { z } from "zod";
export const employeeCompensationNoticeSchema=z.object({id:z.uuid(),propertyName:z.string().nullable(),purpose:z.string(),category:z.string(),withdrawn:z.boolean(),amount:z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u),
  ownerAmount:z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u),currency:z.string().regex(/^[A-Z]{3}$/u),occurredOn:z.iso.date()}).strict();
