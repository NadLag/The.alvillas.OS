import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Font } from "@react-pdf/renderer";

export const alvillasPdfFontFamily = "Alvillas Source Sans 3";
let registered = false;

/** Shared local, licensed font assets keep every native PDF independent of a CDN. */
export function registerAlvillasPdfFonts() {
  if (registered) return;
  const regular = readFileSync(join(process.cwd(), "src/platform/exports/fonts/SourceSans3-Regular.ttf"));
  const bold = readFileSync(join(process.cwd(), "src/platform/exports/fonts/SourceSans3-Bold.ttf"));
  Font.register({ family: alvillasPdfFontFamily, fonts: [
    { src: "data:font/ttf;base64," + regular.toString("base64"), fontWeight: 400 },
    { src: "data:font/ttf;base64," + bold.toString("base64"), fontWeight: 700 }
  ] });
  registered = true;
}
