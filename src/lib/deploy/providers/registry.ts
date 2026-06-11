import type { ProviderId, ProviderInfo, RoutePlan } from "./types";
import { detectStackPlan, type DockSourceFile } from "../dockerfile";

/**
 * The provider registry + capability-based router.
 *
 * `PROVIDERS` is the single source of truth for what each platform can do.
 * `routeApp()` classifies a generated project (stack + role via the universal
 * detector) and returns an ordered, credential-filtered list of providers for
 * its backend/container side and its frontend/static side. The deploy routes
 * consume this instead of hard-coding "Render for backend, Vercel for frontend".
 */

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "vercel",
    name: "Vercel",
    logo: "▲",
    capabilities: {
      roles: ["frontend", "static", "fullstack"],
      languages: ["node", "static"],
      mechanisms: ["inline-files"],
      managedDatabase: false,
    },
    requiredEnv: ["VERCEL_TOKEN"],
  },
  {
    id: "render",
    name: "Render",
    logo: "◆",
    capabilities: {
      // Node native + Docker runtime ⇒ hosts any language as a container.
      roles: ["backend", "fullstack"],
      languages: "any",
      mechanisms: ["git-repo", "container"],
      managedDatabase: true,
    },
    requiredEnv: ["RENDER_API_KEY", "GITHUB_TOKEN"],
  },
  {
    id: "railway",
    name: "Railway",
    logo: "⊞",
    capabilities: {
      // Railpack auto-builds any stack; can host front, back, or both.
      roles: ["backend", "frontend", "fullstack"],
      languages: "any",
      mechanisms: ["git-repo", "container"],
      managedDatabase: true,
    },
    requiredEnv: ["RAILWAY_API_TOKEN", "GITHUB_TOKEN"],
  },
  {
    id: "netlify",
    name: "Netlify",
    logo: "◢",
    capabilities: {
      roles: ["frontend", "static"],
      languages: ["node", "static"],
      mechanisms: ["inline-files"],
      managedDatabase: false,
    },
    requiredEnv: ["NETLIFY_AUTH_TOKEN"],
  },
  {
    id: "fly",
    name: "Fly.io",
    logo: "✦",
    capabilities: {
      roles: ["backend", "fullstack"],
      languages: "any",
      mechanisms: ["container"],
      managedDatabase: true,
    },
    // Fly builds via a remote-build GitHub Actions workflow, so it needs repo
    // access (GITHUB_TOKEN) in addition to the Fly token.
    requiredEnv: ["FLY_API_TOKEN", "GITHUB_TOKEN"],
  },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id)!;
}

/** A provider is usable only when every required server env var is present. */
export function isConfigured(id: ProviderId): boolean {
  return providerInfo(id).requiredEnv.every((k) => !!process.env[k]);
}

/** Configured providers, in declared (preference) order. */
export function configuredProviders(): ProviderId[] {
  return PROVIDERS.filter((p) => isConfigured(p.id)).map((p) => p.id);
}

// Best-fit ORDER for each side. The router intersects these with what's
// actually configured, so we can list ideals and degrade gracefully.
const BACKEND_ORDER: ProviderId[] = ["render", "railway", "fly"];
const FRONTEND_ORDER: ProviderId[] = ["vercel", "netlify", "railway"];

/**
 * Classify a generated app and pick ordered, credential-filtered providers for
 * its backend (container) and frontend (static) sides.
 */
export function routeApp(files: DockSourceFile[]): RoutePlan {
  const plan = detectStackPlan(files);
  const configured = new Set(configuredProviders());
  const notes: string[] = [...plan.notes];

  const isJsFrontend = plan.stack === "node" && (plan.role === "frontend");
  const isStatic = plan.role === "static";

  // Frontend/static candidates (only meaningful for JS/static apps).
  const frontend =
    isJsFrontend || isStatic
      ? FRONTEND_ORDER.filter((id) => configured.has(id))
      : [];

  // Backend/container candidates. A Node frontend-only app has no backend side.
  const backend =
    isJsFrontend || isStatic
      ? []
      : BACKEND_ORDER.filter((id) => configured.has(id));

  if (backend.length === 0 && frontend.length === 0) {
    notes.push(
      "No deploy provider is configured for this app's stack. Set the relevant API token(s): " +
        "RENDER_API_KEY+GITHUB_TOKEN (any backend), RAILWAY_API_TOKEN, FLY_API_TOKEN, VERCEL_TOKEN, or NETLIFY_AUTH_TOKEN.",
    );
  }

  return {
    role: plan.role,
    framework: plan.framework,
    stack: plan.stack,
    backend,
    frontend,
    notes,
  };
}
