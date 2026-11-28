import {localizedTextSchema} from "@/i18n/content";
import {inventoryCategorySchema,type inventoryMinimumsSchema} from "@/platform/config/inventory-policy";
import type {z} from "zod";
type ConfiguredItem=z.infer<typeof inventoryMinimumsSchema>["minimums"][number];
type StoredItem={category:string;unit:string|null;labels:unknown};
/** Property rules may override their explicit operational presentation. Missing
 * definition fields resolve through the one canonical item, without conversion. */
export function configuredInventoryItem(value:ConfiguredItem,stored?:StoredItem){
 const category=inventoryCategorySchema.safeParse(value.category??stored?.category);if(!category.success)return null;
 const name=stored?localizedTextSchema.safeParse(stored.labels):null;
 return{key:value.item,category:category.data,unit:value.unit??stored?.unit??null,name:value.name??(name?.success?name.data:{en:value.item,fr:value.item})};
}
