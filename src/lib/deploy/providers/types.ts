import type { AppRole, Stack } from "../dockerfile";

/**
 * Provider-abstraction layer.
 *
 * Every deploy target (Vercel, Render, Railway, Netlify, Fly…) is described by a
 * capability record: which app ROLES it can host (frontend/backend/fullstack/
 * static), which LANGUAGES it accepts, and how it builds (inline files, a Git
 * repo, or a container image). A capability-based ROUTER (see registry.ts) then
 * matches a detected app to the best-fit, credential-available provider(s) with
 * ordered fallback — so adding a new platform is just adding one record + client,
 * never touching the routing logic.
 */

export type ProviderId = "vercel" | "render" | "railway" | "netlify" | "fly";

/** How a provider ingests an app. */
export type BuildMechanism =
  | "inline-files" // upload the file set directly (Vercel, Netlify)
  | "git-repo" // build from a pushed Git repo (Render native, Railway)
  | "container"; // build/run a Docker image (Render Docker, Railway, Fly)

export interface ProviderCapabilities {
  /** Roles this provider can host. */
  roles: AppRole[];
  /** Languages it accepts — "any" means containerized/buildpack (all stacks). */
  languages: Stack[] | "any";
  mechanisms: BuildMechanism[];
  /** Provides a managed database it can wire automatically. */
  managedDatabase: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  logo: string;
  capabilities: ProviderCapabilities;
  /** Server env vars that must be present for this provider to be usable. */
  requiredEnv: string[];
}

/** A single concrete deploy request the router emits for one provider. */
export interface DeployRequest {
  provider: ProviderId;
  role: AppRole;
  reason: string;
}

/** What the router decided for an app. */
export interface RoutePlan {
  role: AppRole;
  framework: string;
  stack: Stack;
  /** Ordered backend/container candidates (best first), already filtered to
   *  providers whose credentials are configured. */
  backend: ProviderId[];
  /** Ordered frontend/static candidates. */
  frontend: ProviderId[];
  /** Why these were chosen / what's missing. */
  notes: string[];
}
