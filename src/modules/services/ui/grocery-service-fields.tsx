"use client";
import {useId} from "react";
import {useTranslations} from "next-intl";
import {taskTypeSchema} from "@/platform/config/task-type";
import {groceryOrderTermsSchema} from "@/platform/config/grocery-order-policy";
import type {z} from "zod";
export type GroceryServiceForm={enabled:boolean;taskType:string};
export function initialGroceryForm(value:z.infer<typeof groceryOrderTermsSchema>|undefined):GroceryServiceForm{return{enabled:Boolean(value),taskType:value?.task_type??""};}
export function groceryTermsFromForm(value:GroceryServiceForm){return groceryOrderTermsSchema.parse({schemaVersion:1,task_type:value.taskType,purchases:"CANONICAL_PROPERTY_EXPENSE",reimbursement:"CONFIGURED_NATIVE_SETTLEMENT"});}
export function GroceryServiceFields({value,onChange}:{value:GroceryServiceForm;onChange:(value:GroceryServiceForm)=>void}){const t=useTranslations("Groceries"),ops=useTranslations("Operations.manage"),id=useId();return<section data-testid="grocery-service-fields"><label className="checkbox-field"><input type="checkbox" checked={value.enabled} onChange={event=>onChange({...value,enabled:event.target.checked})}/>{t("service")}</label>{value.enabled?<div className="field"><label htmlFor={id}>{t("taskType")}</label><select id={id} required value={value.taskType} onChange={event=>onChange({...value,taskType:event.target.value})}><option value="">{t("chooseTaskType")}</option>{taskTypeSchema.options.map(type=><option key={type} value={type}>{ops("types."+type)}</option>)}</select><p>{t("serviceHelp")}</p></div>:null}</section>;}
