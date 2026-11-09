import {z} from "zod";

export function readCommandNonce(key:string){try{const value=z.uuid().safeParse(sessionStorage.getItem(key));return value.success?value.data:null;}catch{return null;}}
export function writeCommandNonce(key:string,value:string){try{sessionStorage.setItem(key,z.uuid().parse(value));}catch{/* The nonce also stays in the active operation's memory. */}}
export function clearCommandNonce(key:string,value:string){try{if(sessionStorage.getItem(key)===value)sessionStorage.removeItem(key);}catch{/* Storage is optional. */}}
