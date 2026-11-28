import type {AuthContext,Scope} from "@/platform/authz/authorize";
import {authorizeUnconditionalSource} from "@/platform/authz/organization-authority";
/** Reuse the native evaluator for grant validity and conditions. Only actual
 * property, city, region and organization sources can select property records. */
export function inventorySourceScopes(auth:AuthContext,now:Date,type:"property"|"reservation"="property"){
 const scopes:Scope[]=[];
 const permitted=(scope:Scope,authority:AuthContext)=>{
  const kind=scope.scopeType??scope.resourceType,id=scope.scopeId??scope.resourceId;
  if(!["organization","property","city","region",...type==="reservation"?["reservation"]:[]].includes(kind??"")||kind!=="organization"&&!id)return;
  if(authorizeUnconditionalSource(authority,"view",{type,organizationId:auth.organizationId,id,reservationId:id,propertyId:id,city:id,region:id,dataClass:"operational"},now))scopes.push(scope);
 };
 if(auth.assignments)for(const assignment of auth.assignments)permitted(assignment.scope,{...auth,assignments:[assignment]});
 else for(const scope of auth.scopes)permitted(scope,{...auth,scopes:[scope]});
 return scopes;
}
export const inventoryPropertyScopes=(auth:AuthContext,now:Date)=>inventorySourceScopes(auth,now);
