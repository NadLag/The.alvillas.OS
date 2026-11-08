import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Font } from "@react-pdf/renderer";

export const alvillasPdfFontFamily = "Alvillas Source Sans 3";
let registered:Promise<void>|undefined;
type Glyph={readonly codePoints?:readonly number[]};
type NativeFont={getGlyph:(id:number,characters?:number[])=>Glyph|null};

/** Shared local, licensed font assets keep every native PDF independent of a CDN. */
export function registerAlvillasPdfFonts():Promise<void> {
  if (registered) return registered;
  const regular = readFileSync(join(process.cwd(), "src/platform/exports/fonts/SourceSans3-Regular.ttf"));
  const bold = readFileSync(join(process.cwd(), "src/platform/exports/fonts/SourceSans3-Bold.ttf"));
  Font.register({ family: alvillasPdfFontFamily, fonts: [
    { src: "data:font/ttf;base64," + regular.toString("base64"), fontWeight: 400 },
    { src: "data:font/ttf;base64," + bold.toString("base64"), fontWeight: 700 }
  ] });
  const descriptors=[{fontFamily:alvillasPdfFontFamily,fontWeight:400},{fontFamily:alvillasPdfFontFamily,fontWeight:700}];
  registered=Promise.all(descriptors.map(descriptor=>Font.load(descriptor))).then(()=>{
    for(const descriptor of descriptors){
      const font=Font.getFont(descriptor).data as unknown as NativeFont|null;if(!font||typeof font.getGlyph!=="function")throw Error("Native PDF font initialization failed");
      const getGlyph=font.getGlyph.bind(font);
      // fontkit can cache a glyph by ID before its source characters are known.
      // Preserve those later characters on a per-lookup clone, leaving the
      // shared cached glyph untouched for concurrent document/accounting work.
      font.getGlyph=(id,characters=[])=>{const glyph=getGlyph(id,characters);if(!glyph||!characters.length||glyph.codePoints?.length)return glyph;const clone=Object.create(Reflect.getPrototypeOf(glyph)) as Glyph;return Object.assign(clone,glyph,{codePoints:[...characters]});};
    }
  });
  return registered;
}
