import { randomBytes } from "node:crypto";

const apiKey = requiredEnv("RENDER_API_KEY");
const repoURL = requiredEnv("GITHUB_REPO_URL");
const serviceName = process.env.RENDER_SERVICE_NAME ?? "gameping";
const branch = process.env.GITHUB_BRANCH ?? "main";
const plan = process.env.RENDER_PLAN ?? "free";
const region = process.env.RENDER_REGION ?? "oregon";
const appToken = process.env.GAMEPING_API_TOKEN ?? randomBytes(24).toString("hex");

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function renderAPI(path, options = {}) {
  const response = await fetch(`https://api.render.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }

  return body;
}

function servicePayload(ownerId) {
  const envVars = [
    { key: "NODE_ENV", value: "production" },
    { key: "HOST", value: "0.0.0.0" },
    { key: "GAMEPING_DATA_DIR", value: plan === "free" ? "/tmp/gameping-data" : "/var/data" },
    { key: "GAMEPING_API_TOKEN", value: appToken }
  ];

  const details = {
    runtime: "node",
    plan,
    region,
    healthCheckPath: "/health",
    numInstances: 1,
    envSpecificDetails: {
      buildCommand: "npm run check",
      startCommand: "npm run start:prod"
    }
  };

  if (plan !== "free") {
    details.disk = {
      name: "gameping-data",
      mountPath: "/var/data",
      sizeGB: 1
    };
  }

  return {
    type: "web_service",
    name: serviceName,
    ownerId,
    repo: repoURL,
    branch,
    autoDeploy: "yes",
    rootDir: "Server",
    envVars,
    serviceDetails: details
  };
}

const owners = await renderAPI("/owners?limit=20");
const owner = owners[0]?.owner;
if (!owner?.id) {
  throw new Error("No Render workspace was found for this API key.");
}

console.log(`Using Render workspace: ${owner.name ?? owner.email ?? owner.id}`);
console.log(`Creating service: ${serviceName}`);

const service = await renderAPI("/services", {
  method: "POST",
  body: JSON.stringify(servicePayload(owner.id))
});

const serviceID = service?.service?.id ?? service?.id;
const dashboardURL = serviceID ? `https://dashboard.render.com/web/${serviceID}` : "Render dashboard";
const publicURL = service?.service?.serviceDetails?.url ?? service?.serviceDetails?.url ?? "(check Render dashboard)";

console.log("");
console.log("Render service created.");
console.log(`Dashboard: ${dashboardURL}`);
console.log(`Public URL: ${publicURL}`);
console.log(`GamePing token: ${appToken}`);
if (typeof publicURL === "string" && publicURL.startsWith("http")) {
  console.log(`Friend link: ${publicURL}/?token=${encodeURIComponent(appToken)}`);
}
