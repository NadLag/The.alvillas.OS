type LeadSource={id:string|undefined;organizationId:string;createdAt:Date};
export type AssignmentSource={representativeId:string|null;representativePersonId:string|null}|null;

/** A stored assignment restricts an existing permission; it never creates a grant. */
export function leadResource(lead:LeadSource,stage:string,assignment:AssignmentSource=null){
  return{type:"lead",id:lead.id,organizationId:lead.organizationId,dataClass:"personal" as const,status:stage,occurredAt:lead.createdAt,
    assignedUserAccountId:assignment?.representativeId??null,assignedPersonId:assignment?.representativePersonId??null};
}
