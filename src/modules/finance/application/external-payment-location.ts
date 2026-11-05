import { PaymentMethodConfigurationError, type ConfiguredPaymentMethod } from "../domain/payment-method";

/** A provider capture is held in the configured merchant location until a real transfer moves it. */
export function assertExternalPaymentLocation(method: ConfiguredPaymentMethod, account: { code: string; accountType: string; normalSide: string; teamWallet?: unknown }) {
  if (method.adapter !== "paypal" || !method.provider_account_code || method.provider_account_code !== account.code ||
    account.accountType !== "ASSET_LOCATION" || account.normalSide !== "DEBIT" || account.teamWallet) throw new PaymentMethodConfigurationError();
}
