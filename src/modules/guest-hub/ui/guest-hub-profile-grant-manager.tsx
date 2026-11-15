"use client";
import type {AppLocale} from "@/i18n/routing";
import {GuestHubFormGrantManager} from "./guest-hub-form-grant-manager";
const definition={messages:"GuestProfileManagement",path:"profile/grant/",noncePrefix:"alvillas:guest-profile-grant:",testId:"guest-profile-grant"} as const;
export function GuestHubProfileGrantManager(props:{locale:AppLocale;scope:string;reservationId:string;linkId:string;onClose:()=>void}){return <GuestHubFormGrantManager {...props} definition={definition}/>;}
