import { permissionKey, type Action, type DataClass } from "@/platform/authz/authorize";

export const permissionActions = [
  "view",
  "create",
  "edit",
  "void",
  "approve",
  "reject",
  "assign",
  "validate",
  "export",
  "pay",
  "reconcile",
  "configure",
  "override"
] as const satisfies readonly Action[];

export const permissionResources = [
  "organization",
  "identity",
  "team_member",
  "staff_compensation",
  "staff_document",
  "role",
  "permission",
  "field_policy",
  "region",
  "city",
  "owner",
  "property",
  "reservation",
  "guest",
  "task",
  "issue",
  "service",
  "wallet",
  "financial_transaction",
  "owner_portal",
  "owner_portal_property",
  "owner_statement",
  "report",
  "audit_log",
  "config_rule"
] as const;

export type PermissionResource = (typeof permissionResources)[number];

export type PermissionCatalogEntry = {
  key: string;
  resource: PermissionResource;
  action: Action;
  description: string;
};

function describePermission(resource: PermissionResource, action: Action): string {
  return `${action} ${resource.replaceAll("_", " ")}`;
}

export const permissionCatalog: PermissionCatalogEntry[] = permissionResources.flatMap((resource) =>
  permissionActions.map((action) => ({
    key: permissionKey(resource, action),
    resource,
    action,
    description: describePermission(resource, action)
  }))
);

function permissionsFor(
  resources: readonly PermissionResource[],
  actions: readonly Action[]
): string[] {
  return resources.flatMap((resource) => actions.map((action) => permissionKey(resource, action)));
}

const operationalFull = permissionsFor(
  ["property", "reservation", "guest", "task", "issue", "service"],
  ["view", "create", "edit", "assign", "validate"]
);

const geographyView = permissionsFor(["region", "city"], ["view"]);

const financeFull = permissionsFor(
  ["financial_transaction", "wallet", "owner_statement", "report"],
  ["view", "create", "edit", "void", "approve", "reject", "export", "pay", "reconcile"]
);

const ownerPortalPermissions = [
  permissionKey("owner_portal", "view"),
  permissionKey("owner_portal_property", "view"),
  permissionKey("owner_statement", "view"),
  permissionKey("owner_statement", "export")
];

export type StandardRoleKey =
  | "admin"
  | "operations_manager"
  | "property_manager"
  | "co_host"
  | "field_staff"
  | "housekeeper"
  | "pool_technician"
  | "gardener"
  | "maintenance"
  | "chef"
  | "driver"
  | "qa_inspector"
  | "finance"
  | "accountant"
  | "procurement"
  | "guest_experience"
  | "revenue_manager"
  | "regional_manager"
  | "contractor"
  | "temporary_worker"
  | "owner"
  | "owner_representative";

export type StandardRoleTemplate = {
  key: StandardRoleKey;
  name: string;
  description: string;
  permissions: readonly string[];
  mfaRequired: boolean;
};

export const standardRoleTemplates: readonly StandardRoleTemplate[] = [
  {
    key: "admin",
    name: "Administrator",
    description: "Organization-wide administration, role management, finance, exports and overrides.",
    permissions: permissionCatalog.map((permission) => permission.key),
    mfaRequired: true
  },
  {
    key: "operations_manager",
    name: "Operations Manager",
    description: "Full scoped operational control without default financial visibility.",
    permissions: [...geographyView, ...operationalFull, permissionKey("owner", "view")],
    mfaRequired: false
  },
  {
    key: "property_manager",
    name: "Property Manager",
    description: "Full assigned-property operations, reservations and guest visibility.",
    permissions: operationalFull,
    mfaRequired: false
  },
  {
    key: "co_host",
    name: "Co-host",
    description: "Assigned-property reservations, guests, tasks, issues and services without finance.",
    permissions: permissionsFor(
      ["property", "reservation", "guest", "task", "issue", "service"],
      ["view", "create", "edit"]
    ),
    mfaRequired: false
  },
  {
    key: "field_staff",
    name: "Field Staff",
    description: "General assigned field jobs and own task updates.",
    permissions: [permissionKey("task", "view"), permissionKey("task", "edit")],
    mfaRequired: false
  },
  {
    key: "housekeeper",
    name: "Housekeeper",
    description: "Assigned field jobs and own task updates.",
    permissions: [permissionKey("task", "view"), permissionKey("task", "edit")],
    mfaRequired: false
  },
  {
    key: "pool_technician",
    name: "Pool Technician",
    description: "Assigned pool jobs and own task updates.",
    permissions: [permissionKey("task", "view"), permissionKey("task", "edit")],
    mfaRequired: false
  },
  {
    key: "gardener",
    name: "Gardener",
    description: "Assigned garden jobs and own task updates.",
    permissions: [permissionKey("task", "view"), permissionKey("task", "edit")],
    mfaRequired: false
  },
  {
    key: "maintenance",
    name: "Maintenance",
    description: "Assigned maintenance work orders and own estimates.",
    permissions: [
      permissionKey("task", "view"),
      permissionKey("task", "edit"),
      permissionKey("issue", "view"),
      permissionKey("issue", "edit")
    ],
    mfaRequired: false
  },
  {
    key: "chef",
    name: "Chef",
    description: "Assigned food service orders, menu work and own compensation.",
    permissions: [
      permissionKey("task", "view"),
      permissionKey("task", "edit"),
      permissionKey("service", "view"),
      permissionKey("service", "edit")
    ],
    mfaRequired: false
  },
  {
    key: "driver",
    name: "Driver",
    description: "Assigned transfers and own cash collection work.",
    permissions: [permissionKey("task", "view"), permissionKey("task", "edit")],
    mfaRequired: false
  },
  {
    key: "qa_inspector",
    name: "QA Inspector",
    description: "Inspections, issues and audited task validation for assigned scope.",
    permissions: [
      permissionKey("property", "view"),
      permissionKey("task", "view"),
      permissionKey("task", "validate"),
      permissionKey("issue", "view"),
      permissionKey("issue", "create"),
      permissionKey("issue", "edit")
    ],
    mfaRequired: false
  },
  {
    key: "finance",
    name: "Finance",
    description: "Organization financial operations without role administration.",
    permissions: [
      permissionKey("identity", "view"),
      permissionKey("owner", "view"),
      permissionKey("property", "view"),
      permissionKey("reservation", "view"),
      ...financeFull
    ],
    mfaRequired: true
  },
  {
    key: "accountant",
    name: "Accountant",
    description: "Audited read/export financial access for accounting review.",
    permissions: permissionsFor(
      ["financial_transaction", "owner_statement", "report"],
      ["view", "export"]
    ),
    mfaRequired: true
  },
  {
    key: "procurement",
    name: "Procurement",
    description: "Supplier, inventory and purchase visibility without owner ledgers.",
    permissions: [
      permissionKey("property", "view"),
      permissionKey("task", "view"),
      permissionKey("service", "view"),
      permissionKey("financial_transaction", "view")
    ],
    mfaRequired: false
  },
  {
    key: "guest_experience",
    name: "Guest Experience",
    description: "Assigned-property guest, service and hub work without ledgers.",
    permissions: permissionsFor(["reservation", "guest", "service"], ["view", "create", "edit"]),
    mfaRequired: false
  },
  {
    key: "revenue_manager",
    name: "Revenue Manager",
    description: "Revenue KPIs and reservation/rate analysis without expenses or payables.",
    permissions: [
      permissionKey("property", "view"),
      permissionKey("reservation", "view"),
      permissionKey("financial_transaction", "view"),
      permissionKey("report", "view"),
      permissionKey("report", "export")
    ],
    mfaRequired: true
  },
  {
    key: "regional_manager",
    name: "Regional Manager",
    description: "Scoped regional operations with optional scope-level finance grants.",
    permissions: [...geographyView, ...operationalFull, permissionKey("owner", "view"), permissionKey("report", "view")],
    mfaRequired: false
  },
  {
    key: "contractor",
    name: "Contractor",
    description: "Explicit expiring job access only.",
    permissions: [permissionKey("task", "view"), permissionKey("task", "edit")],
    mfaRequired: false
  },
  {
    key: "temporary_worker",
    name: "Temporary Worker",
    description: "Time-boxed explicit job access only.",
    permissions: [permissionKey("task", "view"), permissionKey("task", "edit")],
    mfaRequired: false
  },
  {
    key: "owner",
    name: "Owner",
    description: "Own-property owner portal, statements and approvals only.",
    permissions: ownerPortalPermissions,
    mfaRequired: false
  },
  {
    key: "owner_representative",
    name: "Owner Representative",
    description: "Delegated owner access as recorded and revocable.",
    permissions: ownerPortalPermissions,
    mfaRequired: false
  }
];

export const standardRoles = standardRoleTemplates;
export const standardRoleKeys = standardRoleTemplates.map((role) => role.key) as [
  StandardRoleKey,
  ...StandardRoleKey[]
];

export const standardPermissions = [...new Set(standardRoleTemplates.flatMap((role) => role.permissions))];

export type FieldPolicyCatalogEntry = {
  resource: PermissionResource;
  field: string;
  dataClass: DataClass;
  requiredPermission: string;
  mask: "placeholder" | "omit";
};

export const fieldPolicyCatalog: readonly FieldPolicyCatalogEntry[] = [
  { resource: "staff_compensation", field: "amount", dataClass: "financial", requiredPermission: permissionKey("staff_compensation", "view"), mask: "placeholder" },
  { resource: "wallet", field: "balances", dataClass: "financial", requiredPermission: permissionKey("wallet", "view"), mask: "placeholder" },
  {
    resource: "reservation",
    field: "totalAmount",
    dataClass: "financial",
    requiredPermission: permissionKey("financial_transaction", "view"),
    mask: "placeholder"
  },
  {
    resource: "reservation",
    field: "revenue",
    dataClass: "financial",
    requiredPermission: permissionKey("financial_transaction", "view"),
    mask: "placeholder"
  },
  {
    resource: "reservation",
    field: "ownerPayout",
    dataClass: "financial",
    requiredPermission: permissionKey("owner_statement", "view"),
    mask: "placeholder"
  },
  {
    resource: "reservation",
    field: "guestEmail",
    dataClass: "guest",
    requiredPermission: permissionKey("guest", "view"),
    mask: "placeholder"
  },
  {
    resource: "reservation",
    field: "guestPhone",
    dataClass: "guest",
    requiredPermission: permissionKey("guest", "view"),
    mask: "placeholder"
  },
  {
    resource: "financial_transaction",
    field: "amount",
    dataClass: "financial",
    requiredPermission: permissionKey("financial_transaction", "view"),
    mask: "placeholder"
  },
  {
    resource: "financial_transaction",
    field: "ledgerAccountCode",
    dataClass: "financial",
    requiredPermission: permissionKey("financial_transaction", "view"),
    mask: "placeholder"
  },
  {
    resource: "financial_transaction",
    field: "ownerProfitability",
    dataClass: "financial",
    requiredPermission: permissionKey("financial_transaction", "view"),
    mask: "placeholder"
  },
  {
    resource: "financial_transaction",
    field: "alvillasProfit",
    dataClass: "financial",
    requiredPermission: permissionKey("financial_transaction", "view"),
    mask: "placeholder"
  },
  {
    resource: "owner_statement",
    field: "lines",
    dataClass: "financial",
    requiredPermission: permissionKey("owner_statement", "view"),
    mask: "placeholder"
  },
  {
    resource: "owner_statement",
    field: "closingBalance",
    dataClass: "financial",
    requiredPermission: permissionKey("owner_statement", "view"),
    mask: "placeholder"
  },
  {
    resource: "owner_statement",
    field: "internalLocationCode",
    dataClass: "sensitive",
    requiredPermission: permissionKey("financial_transaction", "view"),
    mask: "omit"
  },
  {
    resource: "owner_statement",
    field: "ownerBankDetails",
    dataClass: "sensitive",
    requiredPermission: permissionKey("owner_statement", "view"),
    mask: "omit"
  },
  {
    resource: "wallet",
    field: "balance",
    dataClass: "financial",
    requiredPermission: permissionKey("wallet", "view"),
    mask: "placeholder"
  },
  {
    resource: "wallet",
    field: "movements",
    dataClass: "financial",
    requiredPermission: permissionKey("wallet", "view"),
    mask: "placeholder"
  },
  {
    resource: "property",
    field: "ownerProfitability",
    dataClass: "financial",
    requiredPermission: permissionKey("financial_transaction", "view"),
    mask: "placeholder"
  },
  {
    resource: "property",
    field: "bankAccount",
    dataClass: "sensitive",
    requiredPermission: permissionKey("financial_transaction", "view"),
    mask: "omit"
  },
  {
    resource: "task",
    field: "staffCompensation",
    dataClass: "personal",
    requiredPermission: permissionKey("wallet", "view"),
    mask: "placeholder"
  },
  {
    resource: "service",
    field: "supplierCost",
    dataClass: "financial",
    requiredPermission: permissionKey("financial_transaction", "view"),
    mask: "placeholder"
  },
  {
    resource: "guest",
    field: "passportUrl",
    dataClass: "sensitive",
    requiredPermission: permissionKey("guest", "view"),
    mask: "omit"
  }
];
