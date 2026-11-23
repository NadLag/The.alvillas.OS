import {expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {planInventoryMovement,planInventoryMovementReversal,inventoryStockAvailability,inventoryMovementDraftSchema,InventoryStockUnavailableError,InventoryReservationUnavailableError,type InventoryMovementPosition} from "@/modules/inventory/domain/movement";
const item=randomUUID(),property=randomUUID(),store=randomUUID(),laundry=randomUUID(),transit=randomUUID(),reservation=randomUUID(),reason="Actual original physical stock movement";
const position=(quantity="20",reserved="0",damaged="0"):InventoryMovementPosition=>({quantity,reserved,damaged,revision:"0"});
const context=(source=position())=>({item:{id:item,category:"LINEN"as const,archived:false},locations:[{id:property,kind:"PROPERTY"as const,archived:false},{id:store,kind:"STORE"as const,archived:false},{id:laundry,kind:"LAUNDRY"as const,archived:false},{id:transit,kind:"IN_TRANSIT"as const,archived:false}],positions:new Map([[property,source],[store,position("0")],[laundry,position("0")],[transit,position("0")]]),reservation:{id:reservation,active:true,outstanding:source.reserved}});
const base={itemId:item,locationId:property,quantity:"3",reason};
it("derives physical, damaged, reserved, available and shortage quantities exactly beyond JavaScript integer precision",()=>{
 expect(inventoryStockAvailability(position("9007199254740993","7","2"))).toMatchObject({available:"9007199254740984",shortage:"0"});expect(inventoryStockAvailability(position("3","4","1"))).toMatchObject({available:"-2",shortage:"2"});expect(inventoryStockAvailability(position("3","0","4"))).toMatchObject({quantity:"3",damaged:"4",conditionShortage:"1"});expect(()=>inventoryStockAvailability(position("-1"))).toThrow();
});
it("records purchases and real two-location transfers without fabricating stock",()=>{
 expect(planInventoryMovement({...base,kind:"PURCHASE"},context()).projected[0].position.quantity).toBe("23");const transfer=planInventoryMovement({...base,kind:"TRANSFER",destinationLocationId:store},context());expect(transfer.lines.map(line=>line.quantity)).toEqual(["-3","3"]);expect(transfer.projected.map(value=>value.position.quantity)).toEqual(["17","3"]);expect(transfer.lines.reduce((sum,line)=>sum+BigInt(line.quantity),0n)).toBe(0n);
});
it("keeps damage physically present, loss distinct and disposal tied to its actual original condition",()=>{
 const damage=planInventoryMovement({...base,kind:"DAMAGE"},context());expect(damage.projected[0].position).toMatchObject({quantity:"20",damaged:"3",available:"17"});expect(planInventoryMovement({...base,kind:"LOSS"},context()).projected[0].position).toMatchObject({quantity:"17",damaged:"0"});expect(planInventoryMovement({...base,kind:"DISPOSAL",condition:"DAMAGED"},context(position("20","0","3"))).projected[0].position).toMatchObject({quantity:"17",damaged:"0",available:"17"});
});
it("records real write-down shortages without silently changing an original guest commitment",()=>{
 const damaged=planInventoryMovement({...base,kind:"DAMAGE"},context(position("5","4")));expect(damaged.projected[0].position).toMatchObject({quantity:"5",reserved:"4",damaged:"3",shortage:"2"});const lost=planInventoryMovement({...base,kind:"LOSS"},context(position("5","4")));expect(lost.projected[0].position).toMatchObject({quantity:"2",reserved:"4",shortage:"2"});
});
it("requires available units for outgoing transfers and unreserved consumption",()=>{
 for(const draft of[{...base,kind:"TRANSFER",destinationLocationId:store},{...base,kind:"CONSUMPTION"}])expect(()=>planInventoryMovement(draft,context(position("5","3")))).toThrow(InventoryStockUnavailableError);expect(()=>planInventoryMovement({...base,kind:"TRANSFER",destinationLocationId:property},context())).toThrow();
});
it("reserves and releases actual guest commitments without changing physical stock or other reservations",()=>{
 const held=planInventoryMovement({...base,kind:"RESERVATION",reservationId:reservation},context());expect(held.projected[0].position).toMatchObject({quantity:"20",reserved:"3",available:"17"});const released=planInventoryMovement({...base,kind:"RELEASE",reservationId:reservation},context(position("20","3")));expect(released.projected[0].position).toMatchObject({quantity:"20",reserved:"0"});expect(()=>planInventoryMovement({...base,kind:"RELEASE",reservationId:randomUUID()},context(position("20","3")))).toThrow(InventoryReservationUnavailableError);expect(()=>planInventoryMovement({...base,kind:"RELEASE",reservationId:reservation},context(position("20","2")))).toThrow(InventoryReservationUnavailableError);
});
it("consumes the actual reservation's own outstanding stock while retaining other commitments",()=>{
 const consumed=planInventoryMovement({...base,kind:"CONSUMPTION",reservationId:reservation},context(position("20","5")));expect(consumed.projected[0].position).toMatchObject({quantity:"17",reserved:"2",available:"15"});expect(()=>planInventoryMovement({...base,kind:"CONSUMPTION",reservationId:reservation},context(position("20","2")))).toThrow(InventoryStockUnavailableError);
});
it("requires an active original reservation for a new hold, while allowing an existing cancelled hold to be released",()=>{
 const ctx=context(position("20","3"));ctx.reservation.active=false;expect(()=>planInventoryMovement({...base,kind:"RESERVATION",reservationId:reservation},ctx)).toThrow(InventoryReservationUnavailableError);expect(planInventoryMovement({...base,kind:"RELEASE",reservationId:reservation},ctx).projected[0].position.reserved).toBe("0");
});
it("preserves original linen through actual laundry and in-transit movement pairs",()=>{
 const sent=planInventoryMovement({...base,kind:"LAUNDRY_SEND",destinationLocationId:transit},context());expect(sent.lines.map(line=>line.quantity)).toEqual(["-3","3"]);const ctx=context();ctx.positions.set(laundry,position("8"));expect(planInventoryMovement({...base,locationId:laundry,kind:"LAUNDRY_RETURN",destinationLocationId:property},ctx).projected.map(value=>value.position.quantity)).toEqual(["5","23"]);expect(()=>planInventoryMovement({...base,kind:"LAUNDRY_SEND",destinationLocationId:laundry},{...context(),item:{id:item,category:"EQUIPMENT",archived:false}})).toThrow();
});
it("transfers damaged physical stock with its original condition, without turning it into usable stock",()=>{
 const transferred=planInventoryMovement({...base,kind:"TRANSFER",condition:"DAMAGED",destinationLocationId:store},context(position("20","0","4")));expect(transferred.projected.map(value=>({quantity:value.position.quantity,damaged:value.position.damaged,available:value.position.available}))).toEqual([{quantity:"17",damaged:"1",available:"16"},{quantity:"3",damaged:"3",available:"0"}]);
});
it("records explicit signed adjustment movements and rejects direct balance edits, fractional counts and zero movements",()=>{
 expect(planInventoryMovement({...base,kind:"ADJUSTMENT",direction:"REMOVE"},context()).lines[0].quantity).toBe("-3");expect(planInventoryMovement({...base,kind:"ADJUSTMENT",direction:"ADD",condition:"DAMAGED"},context()).projected[0].position).toMatchObject({quantity:"23",damaged:"3",available:"20"});for(const quantity of["0","-3","1.5","1e3"])expect(inventoryMovementDraftSchema.safeParse({...base,kind:"PURCHASE",quantity}).success).toBe(false);expect(inventoryMovementDraftSchema.safeParse({...base,kind:"PURCHASE",balance:"100"}).success).toBe(false);
});
it("appends exact reversal deltas and blocks reversal after stock is consumed or reserved elsewhere",()=>{
 const original=planInventoryMovement({...base,kind:"TRANSFER",destinationLocationId:store},context()),positions=new Map(original.projected.map(value=>[value.line.locationId,{quantity:value.position.quantity,reserved:value.position.reserved,damaged:value.position.damaged,revision:value.position.revision}]));expect(planInventoryMovementReversal(original.lines,positions).map(value=>value.position.quantity)).toEqual(["20","0"]);positions.set(store,position("2"));expect(()=>planInventoryMovementReversal(original.lines,positions)).toThrow(InventoryStockUnavailableError);positions.set(store,position("3","1"));expect(()=>planInventoryMovementReversal(original.lines,positions)).toThrow(InventoryStockUnavailableError);
});
it("retains actual stocktake quantities and outstanding commitments while condition history is explicitly corrected",()=>{
 const ctx=context(position("3","2","5"));expect(inventoryStockAvailability(ctx.positions.get(property)!)).toMatchObject({quantity:"3",damaged:"5",reserved:"2",available:"-4",conditionShortage:"2"});const release=planInventoryMovement({...base,quantity:"2",kind:"RELEASE",reservationId:reservation},ctx);expect(release.projected[0].position).toMatchObject({quantity:"3",reserved:"0",damaged:"5",conditionShortage:"2"});const reversed=planInventoryMovementReversal([{locationId:property,itemId:item,quantity:"0",reserved:"0",damaged:"5",reservationId:null}],ctx.positions);expect(reversed[0].position).toMatchObject({quantity:"3",reserved:"2",damaged:"0",available:"1",conditionShortage:"0"});
});
