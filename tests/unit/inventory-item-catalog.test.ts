import {expect,it} from "vitest";
import {inventoryItemDefinition,inventoryItemDraftSchema,assertInventoryItemCanRetire,selectInventoryItems,InventoryItemDefinitionError,InventoryItemStockHeldError} from "@/modules/inventory/domain/item-catalog";
import {configuredInventoryItem} from "@/modules/inventory/domain/item-definition";
const item={key:"linen.sheet",name:{en:"Sheet",fr:"Drap",ar:"ملاءة"},category:"LINEN"as const,unit:"piece"};
it("resolves property thresholds through the canonical item while preserving explicit legacy definitions",()=>{
 const stored={category:item.category,unit:item.unit,labels:item.name};
 expect(configuredInventoryItem({item:item.key,quantity:8},stored)).toEqual({key:item.key,category:item.category,unit:item.unit,name:item.name});
 expect(configuredInventoryItem({item:item.key,quantity:8,category:"CONSUMABLE",unit:"pack",name:{en:"Explicit pack",fr:"Paquet explicite"}},stored)).toMatchObject({category:"CONSUMABLE",unit:"pack",name:{en:"Explicit pack"}});
 expect(configuredInventoryItem({item:item.key,quantity:8})).toBeNull();
});
it("preserves canonical categories and actual multilingual names without creating a competing item type",()=>{
 expect(inventoryItemDefinition(item)).toEqual(item);expect(inventoryItemDefinition({...item,key:"asset.table",category:"EQUIPMENT",name:{en:"Table",fr:"Table",ar:"طاولة"}}).category).toBe("EQUIPMENT");expect(inventoryItemDefinition({...item,key:"water.bottle",category:"CONSUMABLE"}).category).toBe("CONSUMABLE");
 expect(inventoryItemDraftSchema.safeParse({...item,name:{en:"Sheet"}}).success).toBe(false);expect(inventoryItemDraftSchema.safeParse({...item,balance:"100"}).success).toBe(false);
});
it("requires explicit units for new stock streams and retains original category, unit and key through renaming",()=>{
 expect(inventoryItemDefinition({...item,name:{en:"Original sheet, renamed",fr:"Drap renommé"}},item).unit).toBe("piece");
 for(const changed of[{unit:"dozen"},{category:"EQUIPMENT"},{key:"different.sheet"}])expect(()=>inventoryItemDefinition({...item,...changed},item)).toThrow(InventoryItemDefinitionError);
 expect(()=>inventoryItemDefinition({...item,unit:null})).toThrow(InventoryItemDefinitionError);expect(inventoryItemDefinition({...item,unit:null},{...item,unit:null}).unit).toBeNull();
});
it("does not retire stock held at one location even when another location has an equal negative variance",()=>{
 expect(()=>assertInventoryItemCanRetire([{quantity:"10"},{quantity:"-10"}])).toThrow(InventoryItemStockHeldError);expect(()=>assertInventoryItemCanRetire([{quantity:"9007199254740993"}])).toThrow(InventoryItemStockHeldError);expect(()=>assertInventoryItemCanRetire([{quantity:"0"},{quantity:"0"}])).not.toThrow();
});
it("filters current or retired canonical items in every language with stable bounded cursor pages",()=>{
 const rows=Array.from({length:53},(_,index)=>({...item,key:"item."+String(index).padStart(3,"0"),archivedAt:null}));
 const first=selectInventoryItems(rows,{});expect(first.items).toHaveLength(50);expect(first.next).toBe("item.049");expect(selectInventoryItems(rows,{after:first.next}).items.map(row=>row.key)).toEqual(["item.050","item.051","item.052"]);
 expect(selectInventoryItems(rows,{query:"ملاءة"}).items).toHaveLength(50);expect(selectInventoryItems(rows,{category:"EQUIPMENT"}).items).toEqual([]);expect(selectInventoryItems([{...item,archivedAt:new Date()}],{}).items).toEqual([]);expect(selectInventoryItems([{...item,archivedAt:new Date()}],{archived:true}).items).toHaveLength(1);
});
