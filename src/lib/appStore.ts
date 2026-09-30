import { createHash } from "node:crypto";
import {
  APIError,
  APIException,
  AppStoreServerAPIClient,
  Environment,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function iosBundleId(): string {
  return requireEnv("IOS_BUNDLE_ID");
}

const clients = new Map<Environment, AppStoreServerAPIClient>();

function getClient(environment: Environment): AppStoreServerAPIClient {
  let client = clients.get(environment);
  if (!client) {
    client = new AppStoreServerAPIClient(
      requireEnv("APPLE_IAP_PRIVATE_KEY").replace(/\\n/g, "\n"),
      requireEnv("APPLE_IAP_KEY_ID"),
      requireEnv("APPLE_IAP_ISSUER_ID"),
      iosBundleId(),
      environment,
    );
    clients.set(environment, client);
  }
  return client;
}

// Decodes a JWS payload without checking its signature. Only use this on
// data we fetched from Apple ourselves over the authenticated App Store
// Server API — never on anything a client or webhook caller sent us.
export function decodeJwsPayload<T>(jws: string): T {
  const payload = jws.split(".")[1];
  if (!payload) throw new Error("Malformed JWS");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof APIException &&
    (err.httpStatusCode === 404 ||
      err.apiError === APIError.TRANSACTION_ID_NOT_FOUND ||
      err.apiError === APIError.INVALID_TRANSACTION_ID)
  );
}

// Looks a transaction up with Apple — the server-side source of truth.
// Production is tried first; sandbox covers TestFlight and App Review
// purchases, which Apple routes to sandbox even for a production build.
export async function getAppStoreTransaction(transactionId: string): Promise<JWSTransactionDecodedPayload | null> {
  for (const environment of [Environment.PRODUCTION, Environment.SANDBOX]) {
    try {
      const { signedTransactionInfo } = await getClient(environment).getTransactionInfo(transactionId);
      if (!signedTransactionInfo) return null;
      return decodeJwsPayload<JWSTransactionDecodedPayload>(signedTransactionInfo);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  return null;
}

// StoreKit's appAccountToken must be a UUID, but Firebase UIDs aren't, so
// each user gets a stable UUID derived from their UID. The app passes it
// when purchasing and we check it on verify, so a transaction can only be
// credited to the account that made it.
export function appAccountTokenFor(userId: string): string {
  const hex = createHash("sha256").update(`videofy-app-account:${userId}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
