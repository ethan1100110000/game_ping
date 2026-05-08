import { readFileSync } from "node:fs";
import { connect } from "node:http2";
import { createSign } from "node:crypto";

function base64URL(input) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function readPrivateKey() {
  if (process.env.APNS_PRIVATE_KEY) {
    return process.env.APNS_PRIVATE_KEY.replaceAll("\\n", "\n");
  }

  if (process.env.APNS_PRIVATE_KEY_PATH) {
    return readFileSync(process.env.APNS_PRIVATE_KEY_PATH, "utf8");
  }

  return null;
}

export function hasAPNsConfig() {
  return Boolean(
    process.env.APNS_TEAM_ID &&
      process.env.APNS_KEY_ID &&
      process.env.APNS_BUNDLE_ID &&
      readPrivateKey()
  );
}

function makeProviderToken() {
  const header = {
    alg: "ES256",
    kid: process.env.APNS_KEY_ID
  };
  const claims = {
    iss: process.env.APNS_TEAM_ID,
    iat: Math.floor(Date.now() / 1000)
  };

  const signingInput = `${base64URL(JSON.stringify(header))}.${base64URL(JSON.stringify(claims))}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();

  return `${signingInput}.${signer.sign(readPrivateKey()).toString("base64url")}`;
}

export async function sendAPNsNotification({ token, title, body, payload = {} }) {
  if (!hasAPNsConfig()) {
    return {
      skipped: true,
      reason: "APNs environment variables are not configured"
    };
  }

  const environment = process.env.APNS_ENV === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  const client = connect(`https://${environment}`);
  const requestBody = JSON.stringify({
    aps: {
      alert: { title, body },
      sound: "default"
    },
    gameping: payload
  });

  return await new Promise((resolve, reject) => {
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${makeProviderToken()}`,
      "apns-topic": process.env.APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(requestBody)
    });

    let responseBody = "";
    let statusCode = 0;

    request.setEncoding("utf8");
    request.on("response", headers => {
      statusCode = Number(headers[":status"] ?? 0);
    });
    request.on("data", chunk => {
      responseBody += chunk;
    });
    request.on("end", () => {
      client.close();

      if (statusCode >= 200 && statusCode < 300) {
        resolve({
          skipped: false,
          statusCode
        });
        return;
      }

      reject(new Error(`APNs returned ${statusCode}: ${responseBody}`));
    });
    request.on("error", error => {
      client.close();
      reject(error);
    });

    request.end(requestBody);
  });
}
