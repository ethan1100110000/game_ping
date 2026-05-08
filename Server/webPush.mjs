import webPush from "web-push";

const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? "";
const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:gameping@example.com";

if (publicKey && privateKey) {
  webPush.setVapidDetails(subject, publicKey, privateKey);
}

export function hasWebPushConfig() {
  return Boolean(publicKey && privateKey);
}

export function getWebPushPublicKey() {
  return publicKey;
}

export async function sendWebPushNotification(subscription, payload) {
  if (!hasWebPushConfig()) {
    return {
      skipped: true,
      reason: "Web Push VAPID environment variables are not configured"
    };
  }

  if (!subscription?.endpoint) {
    return {
      skipped: true,
      reason: "No Web Push subscription is registered"
    };
  }

  const response = await webPush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: 60
  });

  return {
    skipped: false,
    statusCode: response.statusCode
  };
}
