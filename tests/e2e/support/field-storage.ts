import type { Page } from "@playwright/test";

export function storedFieldData(page: Page, table = "operations"): Promise<unknown[]> {
  return page.evaluate(table => new Promise<unknown[]>((resolve, reject) => {
    const request = indexedDB.open("alvillas.field.v1");
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(table)) { db.close(); resolve([]); return; }
      const rows = db.transaction(table).objectStore(table).getAll();
      rows.onsuccess = () => { db.close(); resolve(rows.result as unknown[]); };
      rows.onerror = () => { db.close(); reject(rows.error ?? new Error("IndexedDB read failed")); };
    };
  }), table);
}
