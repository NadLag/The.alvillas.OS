import type {AuthContext,Scope} from "@/platform/authz/authorize";
import {authorizeUnconditionalSource} from "@/platform/authz/organization-authority";
/** Reuse the native evaluator for grant validity and conditions. Only actual
 * property, city, region and organization sources can select property records. */
export function inventoryPropertyScopes(auth:AuthContext,now:Date){
 const scopes:Scope[]=[];
 const permitted=(scope:Scope,authority:AuthContext)=>{
  const kind=scope.scopeType??scope.resourceType,id=scope.scopeId??scope.resourceId;
  if(!["organization","property","city","region"].includes(kind??"")||kind!=="organization"&&!id)return;
  if(authorizeUnconditionalSource(authority,"view",{type:"property",organizationId:auth.organizationId,id,propertyId:id,city:id,region:id,dataClass:"operational"},now))scopes.push(scope);
 };
 if(auth.assignments)for(const assignment of auth.assignments)permitted(assignment.scope,{...auth,assignments:[assignment]});
 else for(const scope of auth.scopes)permitted(scope,{...auth,scopes:[scope]});
 return scopes;
}
