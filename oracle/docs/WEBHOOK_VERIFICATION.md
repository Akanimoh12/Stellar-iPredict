# Webhook Signature Verification Guide

The iPredict Oracle Aggregator signs outgoing webhook payloads using HMAC-SHA256 to ensure authenticity and integrity, and to prevent replay attacks.

## Webhook Headers

Every signed webhook notification includes the following HTTP request headers:

* `X-Signature`: Hex-encoded HMAC-SHA256 signature of `${X-Timestamp}.${rawBody}`.
* `X-Timestamp`: Unix timestamp (in seconds) recorded when the delivery attempt was initiated.
* `Content-Type`: `application/json`

## Signature Verification Procedure

To verify a notification signature:

1. **Extract Headers**: Read `X-Signature` and `X-Timestamp` from the request headers.
2. **Prevent Replay Attacks**: Ensure `Math.abs(currentTimeSeconds - timestamp) <= 300` (5-minute tolerance window).
3. **Construct Signed Material**: Concatenate the timestamp string, a literal dot (`.`), and the exact raw HTTP request body string:
   ```
   signedMaterial = `${timestamp}.${rawBody}`
   ```
4. **Compute HMAC-SHA256**: Calculate the HMAC-SHA256 signature of `signedMaterial` using the shared `WEBHOOK_SIGNING_SECRET`:
   ```
   expectedSignature = hmac_sha256(secret, signedMaterial).toHex()
   ```
5. **Timing-Safe Comparison**: Compare `expectedSignature` with the `X-Signature` header value using a constant-time comparison algorithm.

---

## Example Implementation (TypeScript / Node.js)

```typescript
import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export function verifyWebhookSignature(
  rawBody: string,
  headers: IncomingHttpHeaders,
  secret: string,
  toleranceSeconds: number = 300
): boolean {
  const signature = headers["x-signature"];
  const timestampHeader = headers["x-timestamp"];

  if (!signature || typeof signature !== "string") {
    return false;
  }
  if (!timestampHeader || typeof timestampHeader !== "string") {
    return false;
  }

  const timestamp = parseInt(timestampHeader, 10);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  // Check timestamp age (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return false;
  }

  // Compute signature over `${timestamp}.${rawBody}`
  const signedMaterial = `${timestamp}.${rawBody}`;
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(signedMaterial);
  const expectedSignature = hmac.digest("hex");

  // Timing-safe comparison
  const signatureBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");

  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}
```

---

## Configuration

Set the environment variable in the Oracle Aggregator deployment:

```bash
WEBHOOK_SIGNING_SECRET=your_secure_random_secret_string
```
