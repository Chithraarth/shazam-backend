import { google } from "googleapis";
import { androidpublisher_v3 } from "googleapis";

function buildAuth() {
  const clientEmail = process.env.GOOGLE_PLAY_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PLAY_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw new Error(
      "Missing Google Play service account credentials — set GOOGLE_PLAY_CLIENT_EMAIL, GOOGLE_PLAY_PRIVATE_KEY",
    );
  }

  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
}

let publisher: androidpublisher_v3.Androidpublisher | null = null;

function getPublisher(): androidpublisher_v3.Androidpublisher {
  if (!publisher) {
    publisher = google.androidpublisher({ version: "v3", auth: buildAuth() });
  }
  return publisher;
}

export function androidPackageName(): string {
  const packageName = process.env.ANDROID_PACKAGE_NAME;
  if (!packageName) throw new Error("Missing ANDROID_PACKAGE_NAME");
  return packageName;
}

export type SubscriptionState =
  | "active"
  | "expired"
  | "canceled"
  | "in_grace_period"
  | "on_hold"
  | "paused"
  | "pending"
  | "unspecified";

export type SubscriptionStatus = {
  state: SubscriptionState;
  isActive: boolean;
  expiryTimeMillis: number | null;
  productId: string | null;
  obfuscatedExternalAccountId: string | null;
  acknowledgementState: "acknowledged" | "pending" | "unspecified";
};

const STATE_MAP: Record<string, SubscriptionState> = {
  SUBSCRIPTION_STATE_ACTIVE: "active",
  SUBSCRIPTION_STATE_EXPIRED: "expired",
  SUBSCRIPTION_STATE_CANCELED: "canceled",
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "in_grace_period",
  SUBSCRIPTION_STATE_ON_HOLD: "on_hold",
  SUBSCRIPTION_STATE_PAUSED: "paused",
  SUBSCRIPTION_STATE_PENDING: "pending",
};

// Verifies a purchase token against the Play Developer API — this is the
// server-side source of truth. Never trust a client's claim that it paid;
// the purchase token alone proves nothing until Google confirms it.
export async function verifySubscriptionPurchase(purchaseToken: string): Promise<SubscriptionStatus> {
  const publisher = getPublisher();
  const packageName = androidPackageName();

  const { data } = await publisher.purchases.subscriptionsv2.get({
    packageName,
    token: purchaseToken,
  });

  const state = STATE_MAP[data.subscriptionState ?? ""] ?? "unspecified";
  const latestLineItem = data.lineItems?.[0] ?? null;
  const expiryTimeMillis = latestLineItem?.expiryTime
    ? new Date(latestLineItem.expiryTime).getTime()
    : null;

  const ackState = data.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"
    ? "acknowledged"
    : data.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING"
      ? "pending"
      : "unspecified";

  return {
    state,
    isActive: state === "active" || state === "in_grace_period",
    expiryTimeMillis,
    productId: latestLineItem?.productId ?? null,
    obfuscatedExternalAccountId: data.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
    acknowledgementState: ackState,
  };
}

// Play auto-refunds a purchase if it isn't acknowledged within 3 days —
// must be called once after verifying a brand-new purchase.
export async function acknowledgeSubscriptionPurchase(productId: string, purchaseToken: string): Promise<void> {
  const publisher = getPublisher();
  const packageName = androidPackageName();

  await publisher.purchases.subscriptions.acknowledge({
    packageName,
    subscriptionId: productId,
    token: purchaseToken,
    requestBody: {},
  });
}
