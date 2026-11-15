"use client";
import type {AppLocale} from "@/i18n/routing";
import {GuestHubFormGrantManager} from "./guest-hub-form-grant-manager";
const definition={messages:"GuestHouseRulesManagement",path:"house-rules/grant/",noncePrefix:"alvillas:guest-house-rules-grant:",testId:"guest-house-rules-grant"} as const;
export function GuestHubHouseRulesGrantManager(props:{locale:AppLocale;scope:string;reservationId:string;linkId:string;onClose:()=>void}){return <GuestHubFormGrantManager {...props} definition={definition}/>;}
