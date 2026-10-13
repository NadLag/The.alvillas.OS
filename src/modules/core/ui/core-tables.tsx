"use client";

import Link from "next/link";
import { useMemo } from "react";

import { DataTable, type DataTableColumn } from "@/design-system/data-table";

type DataTableLabels = {
  search: string;
  exportCsv: string;
  saveView: string;
  viewName: string;
  rows: string;
  empty: string;
};

export type OwnerRegisterRow = {
  id: string;
  displayName: string;
  contact: string;
  propertyCountLabel: string;
  href: string;
};

export type PropertyRegisterRow = {
  id: string;
  name: string;
  meta: string;
  status: string;
  href: string;
};

export function OwnerRegisterTable({
  rows,
  labels
}: {
  rows: OwnerRegisterRow[];
  labels: DataTableLabels & {
    name: string;
    contact: string;
    properties: string;
  };
}) {
  const columns = useMemo<Array<DataTableColumn<OwnerRegisterRow>>>(
    () => [
      {
        cell: (row) => <Link href={row.href}>{row.displayName}</Link>,
        header: labels.name,
        id: "name",
        value: (row) => row.displayName
      },
      {
        header: labels.contact,
        id: "contact",
        value: (row) => row.contact
      },
      {
        header: labels.properties,
        id: "properties",
        value: (row) => row.propertyCountLabel
      }
    ],
    [labels.contact, labels.name, labels.properties]
  );

  return (
    <DataTable
      columns={columns}
      labels={labels}
      rows={rows}
      storageKey="owners"
      testId="owners-data-table"
    />
  );
}

export function PropertyRegisterTable({
  rows,
  labels
}: {
  rows: PropertyRegisterRow[];
  labels: DataTableLabels & {
    property: string;
    location: string;
    status: string;
  };
}) {
  const columns = useMemo<Array<DataTableColumn<PropertyRegisterRow>>>(
    () => [
      {
        cell: (row) => <Link href={row.href}>{row.name}</Link>,
        header: labels.property,
        id: "property",
        value: (row) => row.name
      },
      {
        header: labels.location,
        id: "location",
        value: (row) => row.meta
      },
      {
        header: labels.status,
        id: "status",
        value: (row) => row.status
      }
    ],
    [labels.location, labels.property, labels.status]
  );

  return (
    <DataTable
      columns={columns}
      labels={labels}
      rows={rows}
      storageKey="properties"
      testId="properties-data-table"
    />
  );
}
