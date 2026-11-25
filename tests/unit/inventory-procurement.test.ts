import {it,expect} from "vitest";
import {inventoryProcurementCsv} from "@/modules/inventory/domain/procurement-list";
it("exports original Unicode and exact quantities while quoting cells and neutralizing spreadsheet formulas",()=>{
 const rows=[["المخزون","Fournitures","9007199254740993"],['A "quoted" item','line\nwrap'," =HYPERLINK(1)"]],before=JSON.stringify(rows),csv=inventoryProcurementCsv(rows);expect(csv).toBe('\uFEFF"المخزون","Fournitures","9007199254740993"\r\n"A ""quoted"" item","line\nwrap","\' =HYPERLINK(1)"\r\n');expect(JSON.stringify(rows)).toBe(before);
});
