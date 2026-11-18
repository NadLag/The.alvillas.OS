import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { InventoryMoneyTotal, InventoryQuantityTotal } from "../domain/inventory-performance-report";

type Period = { propertyId: string | null; startsAt: Date; endsAt: Date; currency: string; supplierId?: string };

export class InventoryReportRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  quantities({ propertyId, startsAt, endsAt }: Period) {
    return this.tx.$queryRaw<InventoryQuantityTotal[]>(Prisma.sql`
      WITH movements AS (
        SELECT m.item_id, coalesce(prior.kind,m.kind) AS kind, coalesce(prior.leg,m.leg) AS leg,
          m.quantity_delta AS quantity, m.damaged_quantity_delta AS damaged,
          coalesce(location.property_id,reservation.property_id) AS property_id,
          batch_change.id AS native_laundry
        FROM inventory_movement m
        JOIN inventory_location location ON (location.organization_id,location.id)=(m.organization_id,m.location_id)
        LEFT JOIN inventory_movement prior ON (prior.organization_id,prior.id)=(m.organization_id,m.reverses_movement_id)
        LEFT JOIN reservation ON (reservation.organization_id,reservation.id)=(m.organization_id,coalesce(prior.reservation_id,m.reservation_id))
        LEFT JOIN laundry_batch_change batch_change ON (batch_change.organization_id,batch_change.movement_group_id)
          =(m.organization_id,coalesce(prior.movement_group_id,m.movement_group_id))
        WHERE m.organization_id=${this.organizationId}::uuid AND m.created_at>=${startsAt} AND m.created_at<${endsAt}
      ), activity AS (
        SELECT item_id, property_id,
          CASE WHEN kind='PURCHASE' THEN 'inventoryPurchased'
            WHEN kind='CONSUMPTION' THEN 'inventoryConsumed'
            WHEN kind='LOSS' THEN 'inventoryLost'
            WHEN kind='DAMAGE' THEN 'inventoryDamaged'
            WHEN kind='DISPOSAL' THEN 'inventoryDisposed'
            WHEN kind='LAUNDRY_SEND' THEN 'inventoryLaundrySent'
            WHEN kind='LAUNDRY_RETURN' THEN 'inventoryLaundryReturned' END AS key,
          CASE WHEN kind IN ('PURCHASE','LAUNDRY_RETURN') THEN quantity
            WHEN kind='DAMAGE' THEN damaged ELSE -quantity END AS quantity
        FROM movements
        WHERE kind IN ('PURCHASE','CONSUMPTION','LOSS','DAMAGE','DISPOSAL')
           OR native_laundry IS NULL AND (kind='LAUNDRY_SEND' AND leg=1 OR kind='LAUNDRY_RETURN' AND leg=2)
        UNION ALL
        SELECT line.item_id, coalesce(reservation.property_id,location.property_id),
          CASE coalesce(prior.operation,event.operation) WHEN 'SEND' THEN 'inventoryLaundrySent' ELSE 'inventoryLaundryReturned' END,
          CASE WHEN prior.id IS NULL THEN change.quantity ELSE -change.quantity END
        FROM laundry_batch_event event
        JOIN laundry_batch batch ON (batch.organization_id,batch.id)=(event.organization_id,event.batch_id)
        JOIN laundry_batch_change change ON (change.organization_id,change.event_id)=(event.organization_id,event.id)
        JOIN laundry_batch_line line ON (line.organization_id,line.id)=(change.organization_id,change.line_id)
        LEFT JOIN laundry_batch_event prior ON (prior.organization_id,prior.id)=(event.organization_id,event.reverses_event_id)
        JOIN inventory_location location ON (location.organization_id,location.id)=(batch.organization_id,
          CASE coalesce(prior.operation,event.operation) WHEN 'SEND' THEN batch.source_location_id ELSE batch.return_location_id END)
        LEFT JOIN reservation ON (reservation.organization_id,reservation.id)=(batch.organization_id,batch.reservation_id)
        WHERE event.organization_id=${this.organizationId}::uuid AND event.created_at>=${startsAt} AND event.created_at<${endsAt}
          AND coalesce(prior.operation,event.operation) IN ('SEND','RECEIVE_RETURN')
        UNION ALL
        SELECT count.item_id, coalesce(count.property_id,location.property_id), totals.key, totals.quantity
        FROM inventory_stocktake count
        JOIN inventory_location location ON (location.organization_id,location.id)=(count.organization_id,count.location_id)
        CROSS JOIN LATERAL (VALUES ('inventoryStocktakeExpected',count.expected_quantity),
          ('inventoryStocktakeCounted',count.counted_quantity), ('inventoryStocktakeVariance',count.counted_quantity-count.expected_quantity),
          ('inventoryStocktakes',1)) totals(key,quantity)
        WHERE count.organization_id=${this.organizationId}::uuid AND count.received_at>=${startsAt} AND count.received_at<${endsAt}
      )
      SELECT item.id AS "itemId", item.key AS "itemKey", item.labels,item.unit, activity.key,
        sum(activity.quantity)::text AS quantity
      FROM activity JOIN inventory_item item ON item.organization_id=${this.organizationId}::uuid AND item.id=activity.item_id
      WHERE ${propertyId}::uuid IS NULL OR activity.property_id=${propertyId}::uuid
      GROUP BY item.id,activity.key ORDER BY item.key,item.id,activity.key`);
  }

  money({ propertyId, startsAt, endsAt, currency, supplierId }: Period) {
    return this.tx.$queryRaw<InventoryMoneyTotal[]>(Prisma.sql`
      WITH receipts AS (
        SELECT (receipt.payload#>>'{source,amount,amount}')::numeric AS amount
        FROM outbox_event receipt
        JOIN financial_transaction txn ON txn.organization_id=receipt.organization_id AND txn.id::text=receipt.payload#>>'{source,transactionId}'
        WHERE receipt.organization_id=${this.organizationId}::uuid AND receipt.type='inventory.purchase.source_received'
          AND receipt.occurred_at>=${startsAt} AND receipt.occurred_at<${endsAt}
          AND receipt.payload#>>'{source,amount,currency}'=${currency} AND txn.sealed
          ${supplierId ? Prisma.sql`AND receipt.payload#>>'{source,supplierId}'=${supplierId}` : Prisma.empty}
          AND (${propertyId}::uuid IS NULL OR receipt.payload#>>'{source,propertyId}'=(${propertyId}::uuid)::text)
          AND NOT EXISTS (SELECT 1 FROM financial_transaction reversal
            WHERE reversal.organization_id=txn.organization_id AND reversal.reverses_transaction_id=txn.id
              AND reversal.sealed AND reversal.occurred_at<${endsAt})
      ), assessments AS (
        SELECT DISTINCT ON (expected.batch_id) expected.batch_id,expected.total,expected.created_at,expected.status,expected.currency,expected.pricing_property_id
        FROM laundry_expected_invoice expected
        JOIN laundry_batch batch ON (batch.organization_id,batch.id)=(expected.organization_id,expected.batch_id)
        WHERE expected.organization_id=${this.organizationId}::uuid
          AND expected.created_at<${endsAt}
          ${supplierId ? Prisma.sql`AND batch.supplier_id=${supplierId}::uuid` : Prisma.empty}
        ORDER BY expected.batch_id,expected.created_at DESC,expected.id DESC
      ), invoices AS (
        SELECT actual.total, CASE WHEN actual.currency=expected.currency AND expected.status IN ('READY','PROVISIONAL') THEN expected.total END AS compared
        FROM laundry_actual_invoice actual
        JOIN laundry_expected_invoice expected ON (expected.organization_id,expected.id)=(actual.organization_id,actual.expected_invoice_id)
        JOIN laundry_batch batch ON (batch.organization_id,batch.id)=(actual.organization_id,actual.batch_id)
        WHERE actual.organization_id=${this.organizationId}::uuid AND actual.currency=${currency}
          AND actual.created_at>=${startsAt} AND actual.created_at<${endsAt} AND actual.operation<>'VOID'
          ${supplierId ? Prisma.sql`AND batch.supplier_id=${supplierId}::uuid` : Prisma.empty}
          AND (${propertyId}::uuid IS NULL OR expected.pricing_property_id=${propertyId}::uuid)
          AND NOT EXISTS (SELECT 1 FROM laundry_actual_invoice successor
            WHERE successor.organization_id=actual.organization_id AND successor.supersedes_id=actual.id AND successor.created_at<${endsAt})
      )
      SELECT 'inventoryProcurementAmount' AS key,sum(amount)::text AS amount FROM receipts
      UNION ALL
      SELECT 'inventoryLaundryExpected',sum(total)::text FROM assessments
      WHERE status='READY' AND currency=${currency} AND created_at>=${startsAt} AND (${propertyId}::uuid IS NULL OR pricing_property_id=${propertyId}::uuid)
      UNION ALL SELECT 'inventoryLaundryActual',sum(total)::text FROM invoices
      UNION ALL SELECT 'inventoryLaundryVariance',sum(total-compared)::text FROM invoices
      ORDER BY key`);
  }
}
