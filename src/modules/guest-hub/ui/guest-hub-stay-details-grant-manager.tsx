"use client";
import type {AppLocale} from "@/i18n/routing";
import {GuestHubFormGrantManager} from "./guest-hub-form-grant-manager";
const definition={messages:"GuestStayDetailsManagement",path:"stay-details/grant/",noncePrefix:"alvillas:guest-stay-details-grant:",testId:"guest-stay-details-grant"} as const;
export function GuestHubStayDetailsGrantManager(props:{locale:AppLocale;scope:string;reservationId:string;linkId:string;onClose:()=>void}){return <GuestHubFormGrantManager {...props} definition={definition}/>;}
