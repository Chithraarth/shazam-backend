import { createHash } from "node:crypto";
import {
  Environment,
  SignedDataVerifier,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import { APPLE_ROOT_CERTS } from "./apple-root-certs";
import { logger } from "./logger";

// Apple In-App Purchase (StoreKit 2) verification.
//
// The app never just tells us "I paid": it sends the JWS-signed transaction
// StoreKit gave it, and we verify Apple's signature chain (up to Apple Root
// CA G3) locally before trusting any field. App Store Server Notifications
// V2 are verified the same way. No App Store Server API key is needed.
//
// Env:
//  - IOS_BUNDLE_ID  (default com.videofy.app)
//  - APPLE_APP_ID   numeric App Store app id (App Store Connect → App
//                   Information → Apple ID). Apple's library needs it to
//                   verify PRODUCTION data; until it's set only Sandbox /
//                   TestFlight purchases verify.
export const IOS_BUNDLE_ID = process.env.IOS_BUNDLE_ID || "com.videofy.app";
const APPLE_APP_ID = process.env.APPLE_APP_ID ? Number(process.env.APPLE_APP_ID) : undefined;

const verifiers: { env: Environment; verifier: SignedDataVerifier }[] = [];
if (APPLE_APP_ID) {
  verifiers.push({
    env: Environment.PRODUCTION,
    verifier: new SignedDataVerifier(APPLE_ROOT_CERTS, true, Environment.PRODUCTION, IOS_BUNDLE_ID, APPLE_APP_ID),
  });
} else {
  logger.warn("APPLE_APP_ID is not set - only Sandbox/TestFlight Apple purchases can be verified");
}
verifiers.push({
  env: Environment.SANDBOX,
  verifier: new SignedDataVerifier(APPLE_ROOT_CERTS, true, Environment.SANDBOX, IOS_BUNDLE_ID),
});

export class AppleVerificationError extends Error {}

// Production first, then Sandbox (TestFlight, App Review and sandbox testers).
async function firstVerified<T>(fn: (v: SignedDataVerifier) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (const { verifier } of verifiers) {
    try {
      return await fn(verifier);
    } catch (err) {
      lastErr = err;
    }
  }
  logger.warn({ err: lastErr }, "Apple signed data failed verification in every environment");
  throw new AppleVerificationError("Apple couldn't confirm this purchase.");
}

export function verifyAppleTransaction(signedTransaction: string): Promise<JWSTransactionDecodedPayload> {
  return firstVerified((v) => v.verifyAndDecodeTransaction(signedTransaction));
}

export function verifyAppleNotification(signedPayload: string): Promise<ResponseBodyV2DecodedPayload> {
  return firstVerified((v) => v.verifyAndDecodeNotification(signedPayload));
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
