"use client";
import type {AppLocale} from "@/i18n/routing";
import {GuestHubFormGrantManager} from "./guest-hub-form-grant-manager";
const definition={messages:"GuestIdentityManagement",path:"identity-documents/grant/",noncePrefix:"alvillas:guest-identity-grant:",testId:"guest-identity-grant"}as const;
export function GuestHubIdentityGrantManager(props:{locale:AppLocale;scope:string;reservationId:string;linkId:string;onClose:()=>void}){return <GuestHubFormGrantManager {...props} definition={definition}/>;}
