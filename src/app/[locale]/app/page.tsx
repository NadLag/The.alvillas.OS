import { commandSearchKinds } from "@/platform/command-center/search";
import { canViewCommandFinance } from "@/modules/finance/application/command-center-finance";
import { CommandCenterExceptionsLink } from "@/platform/command-center/exceptions-link";
import { CommandCenterTodaySummary } from "@/modules/reservations/ui/command-center-today";
import { ReservationCommandExceptions } from "@/modules/reservations/ui/command-exceptions";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { LocaleSwitch } from "@/i18n/locale-switch";
import { LogoutForm } from "@/platform/offline/logout-form";
import { routing, safeLocale } from "@/i18n/routing";
import {
  logoutAction,
  updatePreferredLocaleAction
} from "@/modules/identity/application/session-actions";
import { resolveFeatureFlag } from "@/platform/config/feature-flags";
import { authorize,authorizeCollection } from "@/platform/authz/authorize";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import {canViewServiceAllocation} from "@/platform/authz/service-allocation-resource";
import { canViewAccountantExport } from "@/platform/authz/accountant-export-resource";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function AppPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();

  if (!session?.user?.id || !session.user.organizationId) {
    redirect(`/${appLocale}/login`);
  }
  if (session.user.securitySetupRequired) redirect(`/${appLocale}/app/security`);

  const [t, dsnT, ownerPortalFlag, crmT] = await Promise.all([
    getTranslations("AppShell"),
    getTranslations("DesignSystem"),
    resolveFeatureFlag({
      organizationId: session.user.organizationId,
      key: "owner_portal",
      defaultEnabled: true
    }),
    getTranslations("LeadWorkspace")
  ]);

  const reservationContext = await reservationActorContextFromSession(session);
  return (
    <AdminShell className="app-shell" testId="app-shell">
      <ShellHeader
        actions={
          <nav className="app-actions" aria-label={t("actions")}>
          <Link className="secondary-button" href={`/${appLocale}/app/organization`}>
            {t("organization")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/owners`}>
            {t("owners")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/identity`}>
            {t("identity")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/team`}>
            {t("team")}
          </Link>
          {reservationContext && authorizeCollection(reservationContext.authContext, "view", "report") ? (
            <Link className="secondary-button" href={`/${appLocale}/app/reports`}>{t("reports")}</Link>
          ) : null}
          {reservationContext?.authContext.permissions.has("asset:view") ?
            <Link className="secondary-button" prefetch={false} href={`/${appLocale}/app/assets`}>{(await getTranslations("Assets"))("title")}</Link> : null}
          {reservationContext && authorizeOrganizationSource(reservationContext.authContext,"view",{type:"inventory_item",organizationId:session.user.organizationId,dataClass:"operational"},new Date()) ?
            <Link className="secondary-button" data-testid="inventory-items-link" prefetch={false} href={`/${appLocale}/app/inventory/items`}>{(await getTranslations("InventoryItems"))("title")}</Link> : null}
          {reservationContext && authorizeOrganizationSource(reservationContext.authContext,"view",{type:"inventory_location",organizationId:session.user.organizationId,dataClass:"operational"},new Date()) ?
            <Link className="secondary-button" data-testid="inventory-locations-link" prefetch={false} href={`/${appLocale}/app/inventory/locations`}>{(await getTranslations("InventoryLocations"))("title")}</Link> : null}
          {reservationContext && ["inventory_movement","inventory_item","inventory_location"].every(type=>authorizeOrganizationSource(reservationContext.authContext,"view",{type,organizationId:session.user.organizationId,dataClass:"operational"},new Date())) ?
            <Link className="secondary-button" data-testid="inventory-movements-link" prefetch={false} href={`/${appLocale}/app/inventory/movements`}>{(await getTranslations("InventoryMovements"))("title")}</Link> : null}
          {reservationContext && ["inventory_movement","inventory_item","inventory_location"].every(type=>authorizeOrganizationSource(reservationContext.authContext,"view",{type,organizationId:session.user.organizationId,dataClass:"operational"},new Date())) ?
            <Link className="secondary-button" data-testid="inventory-stock-link" prefetch={false} href={`/${appLocale}/app/inventory/stock`}>{(await getTranslations("InventoryStockLevels"))("title")}</Link> : null}
          {reservationContext && ["inventory_movement","inventory_item","inventory_location"].every(type=>authorizeOrganizationSource(reservationContext.authContext,"view",{type,organizationId:session.user.organizationId,dataClass:"operational"},new Date())) ?
            <Link className="secondary-button" data-testid="inventory-stocktakes-link" prefetch={false} href={`/${appLocale}/app/inventory/stocktakes`}>{(await getTranslations("InventoryStocktakes"))("title")}</Link> : null}
          {reservationContext && ["inventory_movement","inventory_item","inventory_location","config_rule"].every(type=>authorizeOrganizationSource(reservationContext.authContext,"view",{type,organizationId:session.user.organizationId,dataClass:"operational"},new Date())) ?
            <Link className="secondary-button" data-testid="inventory-reorder-link" prefetch={false} href={`/${appLocale}/app/inventory/reorder`}>{(await getTranslations("InventoryReorder"))("title")}</Link> : null}
          {reservationContext && ["inventory_movement","inventory_item","inventory_location","config_rule"].every(type=>authorizeOrganizationSource(reservationContext.authContext,"view",{type,organizationId:session.user.organizationId,dataClass:"operational"},new Date())) ?
            <Link className="secondary-button" data-testid="inventory-stays-link" prefetch={false} href={`/${appLocale}/app/inventory/stays`}>{(await getTranslations("InventoryStayConsumption"))("title")}</Link> : null}
          {reservationContext && ["inventory_movement","inventory_item","inventory_location","config_rule"].every(type=>authorizeOrganizationSource(reservationContext.authContext,"view",{type,organizationId:session.user.organizationId,dataClass:"operational"},new Date())) ?
            <Link className="secondary-button" data-testid="inventory-procurement-link" prefetch={false} href={`/${appLocale}/app/inventory/procurement`}>{(await getTranslations("InventoryProcurement"))("title")}</Link> : null}
          {reservationContext && ["inventory_movement","inventory_item","inventory_location","config_rule"].every(type=>authorizeOrganizationSource(reservationContext.authContext,"view",{type,organizationId:session.user.organizationId,dataClass:"operational"},new Date())) ?
            <Link className="secondary-button" data-testid="linen-pool-link" prefetch={false} href={`/${appLocale}/app/inventory/linen`}>{(await getTranslations("LinenPool"))("title")}</Link> : null}
          {reservationContext && ["inventory_movement","inventory_item","inventory_location"].every(type=>authorizeOrganizationSource(reservationContext.authContext,"view",{type,organizationId:session.user.organizationId,dataClass:"operational"},new Date())) ?
            <Link className="secondary-button" data-testid="laundry-batches-link" prefetch={false} href={`/${appLocale}/app/inventory/laundry`}>{(await getTranslations("LaundryBatches"))("title")}</Link> : null}
          {reservationContext && authorizeCollection(reservationContext.authContext,"view","config_rule") && [{type:"inventory_item",dataClass:"operational"as const},{type:"supplier",dataClass:"personal"as const},{type:"supplier_invoice",dataClass:"financial"as const}].every(source=>authorizeOrganizationSource(reservationContext.authContext,"view",{...source,organizationId:session.user.organizationId},new Date())) ?
            <Link className="secondary-button" data-testid="supplier-prices-link" prefetch={false} href={`/${appLocale}/app/inventory/supplier-prices`}>{(await getTranslations("SupplierPrices"))("title")}</Link> : null}
          <Link className="secondary-button" href={`/${appLocale}/app/security`}>
            {t("security")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/audit`}>
            {t("audit")}
          </Link>
          {reservationContext && authorizeOrganizationSource(reservationContext.authContext, "view", { type: "supplier", organizationId: session.user.organizationId, dataClass: "personal" }, new Date()) ?
            <Link className="secondary-button" data-testid="suppliers-link" href={`/${appLocale}/app/finance/suppliers`}>{t("suppliers")}</Link> : null}
          {reservationContext && authorizeOrganizationSource(reservationContext.authContext, "view", { type: "supplier_invoice", organizationId: session.user.organizationId, dataClass: "financial" }, new Date()) && authorizeOrganizationSource(reservationContext.authContext, "view", { type: "supplier", organizationId: session.user.organizationId, dataClass: "personal" }, new Date()) ?
            <Link className="secondary-button" data-testid="supplier-invoices-link" href={`/${appLocale}/app/finance/supplier-invoices`}>{t("supplierInvoices")}</Link> : null}
          {reservationContext && ["company_expense","financial_transaction"].every(type=>authorizeOrganizationSource(reservationContext.authContext,"view",{type,organizationId:session.user.organizationId,dataClass:"financial"},new Date())) ?
            <Link className="secondary-button" data-testid="company-expenses-link" href={`/${appLocale}/app/finance/company-expenses`} prefetch={false}>{(await getTranslations("CompanyExpenses"))("title")}</Link> : null}
          {reservationContext && canViewServiceAllocation(reservationContext.authContext,{type:"service_allocation",organizationId:session.user.organizationId,dataClass:"financial"},new Date()) ?
            <Link className="secondary-button" data-testid="service-allocations-link" href={`/${appLocale}/app/finance/service-allocations`} prefetch={false}>{(await getTranslations("ServiceAllocations"))("title")}</Link> : null}
          {reservationContext && authorizeOrganizationSource(reservationContext.authContext,"view",{type:"financial_transaction",organizationId:session.user.organizationId,dataClass:"financial"},new Date()) ?
            <Link className="secondary-button" data-testid="guest-deposits-link" href={`/${appLocale}/app/finance/guest-deposits`} prefetch={false}>{(await getTranslations("GuestDeposits"))("title")}</Link> : null}
          {reservationContext && ["bank_statement","financial_transaction"].every(type=>authorizeOrganizationSource(reservationContext.authContext,"view",{type,organizationId:session.user.organizationId,dataClass:"financial"},new Date())) ?
            <Link className="secondary-button" data-testid="bank-statements-link" href={`/${appLocale}/app/finance/bank-statements`} prefetch={false}>{(await getTranslations("BankStatements"))("title")}</Link> : null}
          {reservationContext && ["financial_transaction","task"].some(type=>authorizeOrganizationSource(reservationContext.authContext,"view",{type,organizationId:session.user.organizationId,dataClass:type==="task"?"operational":"financial"},new Date())) ?
            <Link className="secondary-button" data-testid="variance-center-link" href={`/${appLocale}/app/finance/variances`} prefetch={false}>{(await getTranslations("VarianceCenter"))("title")}</Link> : null}
          {reservationContext && authorize(reservationContext.authContext, "view", { type: "company_ledger", organizationId: session.user.organizationId, dataClass: "financial" }) ?
            <Link className="secondary-button" data-testid="company-ledger-link" href={`/${appLocale}/app/finance/company-ledger`}>{t("companyLedger")}</Link> : null}
          {reservationContext && authorize(reservationContext.authContext, "view", { type: "employee_payable", organizationId: session.user.organizationId, dataClass: "financial", amount: "0.00", occurredAt: new Date() }) ?
            <Link className="secondary-button" data-testid="compensation-link" href={`/${appLocale}/app/finance/compensation`} prefetch={false}>{t("compensation")}</Link> : null}
          {reservationContext && ["receivable","financial_transaction","staff_compensation"].every(type=>authorizeOrganizationSource(reservationContext.authContext,"view",{type,organizationId:session.user.organizationId,dataClass:"financial"},new Date())) ?
            <Link className="secondary-button" data-testid="receivables-link" href={`/${appLocale}/app/finance/receivables`} prefetch={false}>{t("receivables")}</Link> : null}
          {reservationContext && authorize(reservationContext.authContext, "view", { type: "financial_transaction", organizationId: session.user.organizationId, dataClass: "financial" }) ?
            <Link className="secondary-button" data-testid="financial-accounts-link" href={`/${appLocale}/app/finance/accounts`}>{t("financialAccounts")}</Link> : null}
          {reservationContext && ["financial_attachment:view","financial_transaction:view"].every(key=>reservationContext.authContext.permissions.has(key)) ?
            <Link className="secondary-button" data-testid="financial-attachments-link" href={`/${appLocale}/app/finance/attachments`} prefetch={false}>{(await getTranslations("FinancialAttachments"))("title")}</Link> : null}
          {reservationContext?.authContext.permissions.has("document:view") ?
            <Link className="secondary-button" data-testid="documents-link" href={`/${appLocale}/app/documents`} prefetch={false}>{(await getTranslations("DocumentArchive"))("title")}</Link> : null}
          {reservationContext&&(["view","create"]as const).some(action=>authorizeCollection(reservationContext.authContext,action,"lead"))?
            <Link className="secondary-button" data-testid="crm-link" href={`/${appLocale}/app/crm`} prefetch={false}>{crmT("title")}</Link>:null}
          {reservationContext && canViewAccountantExport(reservationContext.authContext, "export", new Date()) ?
            <Link className="secondary-button" data-testid="accountant-exports-link" href={`/${appLocale}/app/finance/accountant-exports`} prefetch={false}>{(await getTranslations("AccountantExports"))("title")}</Link> : null}
          {reservationContext && authorize(reservationContext.authContext, "view", { type: "financial_transaction", organizationId: session.user.organizationId, dataClass: "financial" }) ?
            <Link className="secondary-button" data-testid="transaction-groups-link" href={`/${appLocale}/app/finance/groups`}>{t("transactionGroups")}</Link> : null}
          {reservationContext && authorize(reservationContext.authContext, "view", { type: "financial_transaction", organizationId: session.user.organizationId, dataClass: "financial" }) ?
            <Link className="secondary-button" data-testid="accounting-periods-link" href={`/${appLocale}/app/finance/periods`}>{t("accountingPeriods")}</Link> : null}
          <Link className="secondary-button" href={`/${appLocale}/app/configuration`}>
            {t("configuration")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/automations`}>
            {t("automations")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/templates`}>
            {t("templates")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/properties`}>
            {t("properties")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/reservations`}>
            {t("reservations")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/operations`}>
            {t("operations")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app/field`}>
            {t("field")}
          </Link>
          {ownerPortalFlag.enabled ? (
            <Link className="secondary-button" href={`/${appLocale}/app/owner-portal`}>
              {t("ownerPortal")}
            </Link>
          ) : null}
          <Link className="secondary-button" href={`/${appLocale}/app/design-system`}>
            {dsnT("nav")}
          </Link>
          <LocaleSwitch compact currentLocale={appLocale} label={t("language")} path="/app" />
          <LogoutForm action={logoutAction.bind(null, appLocale)} label={t("logout")} />
        </nav>
        }
        eyebrow={t("eyebrow")}
        title={t("title")}
      />
      <div className="workspace-grid">
        <section className="workspace-main">
          <p className="panel-label">{t("todayLabel")}</p>
          <h2>{t("welcome", { name: session.user?.name ?? session.user?.email ?? t("fallbackName") })}</h2>
          <p>{t("summary")}</p>
          {reservationContext ? <>
            <CommandCenterExceptionsLink context={reservationContext.authContext} locale={appLocale} />
            <ReservationCommandExceptions ctx={reservationContext} locale={appLocale} />
            <CommandCenterTodaySummary actor={reservationContext} locale={appLocale} />
            {commandSearchKinds(reservationContext.authContext).length ?
              <Link className="secondary-button" href={`/${appLocale}/app/command-center/search`}>{(await getTranslations("CommandSearch"))("title")}</Link> : null}
            {authorizeCollection(reservationContext.authContext, "view", "task") ?
              <Link className="secondary-button" href={`/${appLocale}/app/command-center/operations`}>{(await getTranslations("CommandOperations"))("title")}</Link> : null}
            {canViewCommandFinance(reservationContext.authContext) ?
              <Link className="secondary-button" href={`/${appLocale}/app/command-center/finance`}>{(await getTranslations("CommandFinance"))("title")}</Link> : null}
          </> : null}
        </section>
        <aside className="workspace-side" aria-label={t("sessionLabel")}>
          <form
            action={updatePreferredLocaleAction.bind(null, appLocale)}
            className="preference-form"
            data-testid="preferred-locale-form"
          >
            <label className="field">
              <span>{t("languagePreference")}</span>
              <select
                data-testid="preferred-locale-select"
                defaultValue={safeLocale(session.user.preferredLocale)}
                name="preferredLocale"
              >
                <option value="en">{t("languageNames.en")}</option>
                <option value="fr">{t("languageNames.fr")}</option>
                <option value="ar">{t("languageNames.ar")}</option>
              </select>
            </label>
            <button className="secondary-button" data-testid="preferred-locale-submit" type="submit">
              {t("saveLanguagePreference")}
            </button>
          </form>
          <dl>
            <div>
              <dt>{t("signedInAs")}</dt>
              <dd>{session.user?.email}</dd>
            </div>
            <div>
              <dt>{t("sessionScope")}</dt>
              <dd>{t("organizationScope")}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </AdminShell>
  );
}
