/** File values must never be converted into financial text fields. */
export function companyExpenseFormText(value:FormDataEntryValue|null){return typeof value==="string"?value:"";}
