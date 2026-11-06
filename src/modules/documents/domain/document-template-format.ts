export const documentTemplateMediaType = "application/vnd.alvillas.document-template+json";
export const documentTemplateMaximumBytes = 1024 * 1024;
export function documentTemplateFileName(templateKey:string,locale:string){return templateKey+"."+locale+".template.json";}
