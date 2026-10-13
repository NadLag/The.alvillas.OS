"use client";

import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useLegacyTable,
  type LegacyColumnDef
} from "@tanstack/react-table/legacy";
import { flexRender } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Bookmark, Download, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

type DataTableLabels = {
  search: string;
  exportCsv: string;
  saveView: string;
  viewName: string;
  rows: string;
  empty: string;
};

export type DataTableColumn<TData> = {
  id: string;
  header: string;
  value: (row: TData) => string;
  cell?: (row: TData) => ReactNode;
  align?: "start" | "end";
};

type SavedView = {
  name: string;
  filter: string;
  sorting: Array<{ id: string; desc: boolean }>;
};

function escapeCsvCell(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function savedViewsKey(storageKey: string): string {
  return `alvillas.dsn.table.${storageKey}.views.v1`;
}

function readSavedViews(storageKey: string): SavedView[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(savedViewsKey(storageKey)) ?? "[]") as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (item): item is SavedView =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as SavedView).name === "string" &&
        typeof (item as SavedView).filter === "string" &&
        Array.isArray((item as SavedView).sorting)
    );
  } catch {
    return [];
  }
}

function writeSavedViews(storageKey: string, views: SavedView[]): void {
  window.localStorage.setItem(savedViewsKey(storageKey), JSON.stringify(views.slice(-6)));
}

export function DataTable<TData extends { id: string }>({
  rows,
  columns,
  labels,
  storageKey,
  testId
}: {
  rows: TData[];
  columns: Array<DataTableColumn<TData>>;
  labels: DataTableLabels;
  storageKey: string;
  testId?: string;
}) {
  const [globalFilter, setGlobalFilter] = useState("");
  const [sorting, setSorting] = useState<Array<{ id: string; desc: boolean }>>([]);
  const [viewName, setViewName] = useState("");
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const scrollParentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSavedViews(readSavedViews(storageKey));
  }, [storageKey]);

  const columnDefs = useMemo<Array<LegacyColumnDef<TData, unknown>>>(
    () =>
      columns.map((column) => ({
        accessorFn: column.value,
        cell: ({ row }) => column.cell?.(row.original) ?? column.value(row.original),
        header: column.header,
        id: column.id
      })),
    [columns]
  );

  const table = useLegacyTable({
    columns: columnDefs,
    data: rows,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: (row, columnId, filterValue) => {
      const needle = String(filterValue).trim().toLowerCase();

      if (!needle) {
        return true;
      }

      return String(row.getValue(columnId)).toLowerCase().includes(needle);
    },
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
    state: {
      globalFilter,
      sorting
    }
  });

  const tableRows = table.getRowModel().rows;
  // TanStack Virtual intentionally returns imperative measurement helpers.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    estimateSize: () => 56,
    getScrollElement: () => scrollParentRef.current,
    overscan: 8
  });

  function exportCsv(): void {
    const header = columns.map((column) => escapeCsvCell(column.header)).join(",");
    const body = tableRows
      .map((row) => columns.map((column) => escapeCsvCell(column.value(row.original))).join(","))
      .join("\n");
    const blob = new Blob([[header, body].filter(Boolean).join("\n")], {
      type: "text/csv;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${storageKey}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function saveView(): void {
    const trimmedName = viewName.trim();

    if (!trimmedName) {
      return;
    }

    const next = [
      ...savedViews.filter((view) => view.name !== trimmedName),
      { name: trimmedName, filter: globalFilter, sorting }
    ];

    setSavedViews(next);
    writeSavedViews(storageKey, next);
    setViewName("");
  }

  return (
    <section className="data-table-panel" data-testid={testId}>
      <div className="data-table-toolbar">
        <label className="data-table-search">
          <Search aria-hidden="true" size={17} />
          <span className="sr-only">{labels.search}</span>
          <input
            aria-label={labels.search}
            onChange={(event) => setGlobalFilter(event.target.value)}
            placeholder={labels.search}
            value={globalFilter}
          />
        </label>
        <div className="data-table-view-controls">
          <input
            aria-label={labels.viewName}
            onChange={(event) => setViewName(event.target.value)}
            placeholder={labels.viewName}
            value={viewName}
          />
          <button className="secondary-button icon-text-button" onClick={saveView} type="button">
            <Bookmark aria-hidden="true" size={16} />
            <span>{labels.saveView}</span>
          </button>
          <button className="secondary-button icon-text-button" onClick={exportCsv} type="button">
            <Download aria-hidden="true" size={16} />
            <span>{labels.exportCsv}</span>
          </button>
        </div>
      </div>
      {savedViews.length > 0 ? (
        <div className="saved-view-row">
          {savedViews.map((view) => (
            <button
              className="quiet-pill"
              key={view.name}
              onClick={() => {
                setGlobalFilter(view.filter);
                setSorting(view.sorting);
              }}
              type="button"
            >
              {view.name}
            </button>
          ))}
        </div>
      ) : null}
      <p className="data-table-count" data-testid={`${testId ?? storageKey}-count`}>
        {tableRows.length} {labels.rows}
      </p>
      <div className="data-table-scroll" ref={scrollParentRef}>
        <div
          className="data-table-grid"
          role="table"
          style={
            {
              "--table-columns": columns.length,
              minHeight: rowVirtualizer.getTotalSize() + 56
            } as CSSProperties
          }
        >
          <div className="data-table-head" role="row">
            {table.getHeaderGroups()[0]?.headers.map((header) => (
              <button
                className="data-table-header-cell"
                key={header.id}
                onClick={header.column.getToggleSortingHandler()}
                role="columnheader"
                type="button"
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
                <span aria-hidden="true">
                  {header.column.getIsSorted() === "asc" ? "^" : header.column.getIsSorted() === "desc" ? "v" : ""}
                </span>
              </button>
            ))}
          </div>
          {tableRows.length === 0 ? (
            <div className="data-table-empty" role="row">
              <span role="cell">{labels.empty}</span>
            </div>
          ) : (
            rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = tableRows[virtualRow.index];

              return (
                <div
                  className="data-table-row"
                  data-testid={`${testId ?? storageKey}-row`}
                  key={row.id}
                  role="row"
                  style={{ transform: `translateY(${virtualRow.start + 56}px)` }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <div className="data-table-cell" key={cell.id} role="cell">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
