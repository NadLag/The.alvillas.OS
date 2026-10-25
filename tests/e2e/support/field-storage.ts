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

export function storedFieldPhotoDigests(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("alvillas.field.v1"); request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const rows = await new Promise<Array<{ blob: Blob; manifest: { localId: string; sha256: string } }>>((resolve, reject) => {
        const request = db.transaction("photos").objectStore("photos").getAll();
        request.onsuccess = () => resolve(request.result as Array<{ blob: Blob; manifest: { localId: string; sha256: string } }>);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB photo read failed"));
      });
      return Promise.all(rows.map(async row => ({ localId: row.manifest.localId, expected: row.manifest.sha256,
        actual: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await row.blob.arrayBuffer())), value => value.toString(16).padStart(2, "0")).join("") })));
    } finally { db.close(); }
  });
}
