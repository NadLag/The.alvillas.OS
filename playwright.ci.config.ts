import {defineConfig} from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({...base,retries:0,reporter:[["list"],["json",{outputFile:"ci-evidence/playwright.json"}]]});
