import { NextRequest, NextResponse } from "next/server";
import { type RenderEnvVar } from "@/lib/deploy/render";
import { prepareBackendForRender, appDatabaseUrl, containerDatabaseUrl } from "@/lib/deploy/render-prepare";
import { prepareForContainer, findBackendRoot } from "@/lib/deploy/universal-prepare";
import { verifyForDeploy } from "@/lib/deploy/verify-gate";
import { detectStack } from "@/lib/deploy/dockerfile";
import { prepareFrontendForVercel } from "@/lib/deploy/frontend-prepare";
import { prepareForDeploy } from "@/lib/deploy/prepare";
import { deployToVercel } from "@/lib/deploy/vercel";
import { deployContainer } from "@/lib/deploy/providers/container-deploy";
import type { ProviderId } from "@/lib/deploy/providers/types";
import { slugify } from "@/lib/utils";
import { serverToken } from "@/lib/deploy/env";
import { databaseEnvForFramework, appSchemaName, ensureAppSchema } from "@/lib/deploy/db-env";
import { preflightForFramework, seedRulesFor, applyStoredFixes, promoteFixes, techTagsFor, type PreflightRule } from "@/lib/deploy/preflight";
import { distillAndStore } from "@/lib/deploy/distill";
import type { WorkspaceFile } from "@/store/workspace";

export const maxDuration = 60; // Vercel Hobby caps function duration at 60s

/**
 * Full-stack one-click deploy: backend → Render (wired to Aiven Postgres),
 * frontend → Vercel (wired to the backend URL). Returns the frontend link.
 * Best-effort per side — if one fails, the other still deploys and the error is
 * reported.
 */
export async function POST(req: NextRequest) {
  try {
    const { files, name, provider } = (await req.json()) as {
      files: WorkspaceFile[];
      name?: string;
      /** Backend container target: "render" (default) | "fly" | "railway". */
      provider?: ProviderId;
    };
    if (!Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: "No files to deploy." }, { status: 400 });
    }
    const slug = (slugify(name || "ai-app") || "ai-app").slice(0, 70);
    // Unique backend name so repeated deploys never collide with an existing repo/service.
    const backendName = `${slug}-api-${Math.random().toString(36).slice(2, 7)}`;
    const repoFiles = files.map((f) => ({ path: f.path, content: f.content }));

    // The frontend's Vercel project name is the slug, so its production URL is
    // predictable. We expose it to the backend as FRONTEND_URL and seed CORS_ORIGIN
    // with it. (The backend also reflects any *.vercel.app origin, so the immutable
    // per-deploy URL works too without a second deploy.)
    const predictedFrontendUrl = `https://${slug}.vercel.app`;

    let backendUrl: string | null = null;
    let backendDashboard: string | null = null;
    let repoUrl: string | null = null;
    let dbWired = false;
    let backendError: string | null = null;
    let backendProvider: ProviderId | null = null;
    // Why no backend service was created, when there isn't one (so the UI can
    // explain it instead of silently shipping only the frontend).
    let backendNote: string | null = null;

    // ---- Backend → Render ----
    // Node backends take the optimized native path. Non-Node backends (Django,
    // Rails, Spring, Laravel, Go, .NET, …) — even when they sit in a backend/
    // subdir next to a JS frontend — take the universal Docker path.
    const backendPrep = prepareBackendForRender(repoFiles);
    let hasBackend = backendPrep.hasBackend;
    let backendDir = backendPrep.backendDir;
    let backendWarnings: string[] = backendPrep.hasBackend ? backendPrep.warnings : [];

    // Non-Node container backend detection (only when no Node backend was found).
    const containerRoot = !hasBackend ? findBackendRoot(repoFiles) : null;
    const container = containerRoot && detectStack(containerRoot.files) !== "node"
      ? { dir: containerRoot.dir, prep: prepareForContainer(containerRoot.files) }
      : null;
    if (container) { hasBackend = true; backendDir = container.dir; backendWarnings = container.prep.notes; }

    if (!hasBackend) {
      backendNote =
        "No backend/server was detected in the selected files (no Express/Fastify/Prisma/Django/Rails/Spring/etc. or server entry), so only the frontend was deployed. If this app should have a backend, ask the builder to generate it, then redeploy.";
    }
    if (hasBackend) {
      try {
        const token = serverToken("GITHUB_TOKEN");
        if (!token) throw new Error("GITHUB_TOKEN is not configured on the server — set it in the platform host's environment to enable backend deploys.");
        const dbUrl = serverToken("DEFAULT_DATABASE_URL");

        if (container) {
          // ---- Universal Docker backend (Render / Fly / Railway) ----
          const envVars: RenderEnvVar[] = [
            { key: "CORS_ORIGIN", value: predictedFrontendUrl },
            { key: "FRONTEND_URL", value: predictedFrontendUrl },
          ];
          if (container.prep.needsDatabase && dbUrl) {
            // Isolate this app in its OWN schema so container apps sharing the
            // managed DB can't collide (App A's `users` ≠ App B's `users`).
            const schema = appSchemaName(backendName);
            await ensureAppSchema(schema);
            const cleanUrl = containerDatabaseUrl(dbUrl); // for parsing (Npgsql/JDBC)
            envVars.push({ key: "DATABASE_URL", value: containerDatabaseUrl(dbUrl, schema) });
            // Translate into the framework's expected key/shape (.NET/Npgsql, Spring,
            // …), schema-pinned, so a stack that can't read a postgres:// URL still connects.
            envVars.push(...databaseEnvForFramework(container.prep.plan.framework, cleanUrl, schema));
            dbWired = true;
          }
          // Django: allow the deploy domain (else 400 DisallowedHost). Harmless otherwise.
          if (container.prep.plan.framework === "django") {
            envVars.push(
              { key: "DJANGO_ALLOWED_HOSTS", value: "*" },
              { key: "ALLOWED_HOSTS", value: "*" },
              { key: "CSRF_TRUSTED_ORIGINS", value: "https://*.fly.dev,https://*.onrender.com" },
            );
          }
          // Apply the registry's VERIFIED (incl. distilled-then-promoted) fixes for
          // this stack before pushing the repo.
          const backendFiles = (await applyStoredFixes(container.prep.files, container.prep.plan.framework)).files;
          const r = await deployContainer({
            githubToken: token, name: backendName, files: backendFiles, runtime: "docker",
            dockerfilePath: container.prep.dockerfilePath, envVars, provider,
            description: `Container backend (${container.prep.plan.framework}) from agentic-ai-studio`,
          });
          backendUrl = r.url; backendDashboard = r.dashboardUrl; repoUrl = r.repoUrl; backendProvider = r.provider;
        } else {
          // ---- Optimized Node backend (Render / Fly / Railway) ----
          // Pin Node 22 LTS. Render defaults to Node 24, which has no prebuilt
          // binaries for common native deps (e.g. better-sqlite3) and fails to
          // compile them; 22 has prebuilts and runs everything generated apps use.
          const envVars: RenderEnvVar[] = [
            { key: "NODE_ENV", value: "production" },
            { key: "NODE_VERSION", value: "22" },
            // CORS allow-list for the frontend (honored by the wired backend).
            // FRONTEND_URL is exposed too for apps that read their own client URL.
            { key: "CORS_ORIGIN", value: predictedFrontendUrl },
            { key: "FRONTEND_URL", value: predictedFrontendUrl },
          ];
          if (backendPrep.usesPrisma && dbUrl) { envVars.push({ key: "DATABASE_URL", value: appDatabaseUrl(dbUrl, backendName) }); dbWired = true; }
          const nodeFiles = (await applyStoredFixes(backendPrep.files, "node")).files;
          // Pre-deploy verification gate (the Node path has no container prepare to
          // gate it): repair truncated source, and BLOCK with a precise error if a
          // file is still truncated — don't push a build that's certain to fail.
          const gate = verifyForDeploy({ files: nodeFiles });
          if (!gate.ok) throw new Error(`Backend deploy blocked: ${gate.blockers.join("; ")}`);
          const r = await deployContainer({
            githubToken: token, name: backendName, files: gate.files, runtime: "node",
            buildCommand: backendPrep.buildCommand, startCommand: backendPrep.startCommand, envVars, provider,
            description: "Backend from agentic-ai-studio",
          });
          backendUrl = r.url; backendDashboard = r.dashboardUrl; repoUrl = r.repoUrl; backendProvider = r.provider;
        }
      } catch (e) {
        backendError = e instanceof Error ? e.message : String(e);
      }
    }

    // ---- Frontend → Vercel (wired to the backend URL) ----
    // If the app HAS a backend but it failed to deploy (backendUrl null), shipping
    // the frontend anyway points its API calls at nothing: the login/auth request
    // returns no body and the app crashes on the client (e.g. "Cannot destructure
    // property 'token' of res.data as it is undefined"). Make that explicit rather
    // than letting the broken frontend look like a success.
    const frontendUnwired = hasBackend && !backendUrl;
    let frontendUrl: string | null = null;
    let frontendId: string | null = null;
    let frontendError: string | null = null;
    const front = prepareFrontendForVercel(repoFiles, backendUrl);
    if (front.found) {
      try {
        if (!serverToken("VERCEL_TOKEN")) throw new Error("VERCEL_TOKEN is not configured.");
        const prep = prepareForDeploy(front.files);
        const result = await deployToVercel(prep.files as WorkspaceFile[], {
          name: slug,
          framework: prep.framework,
          buildCommand: prep.buildCommand,
          outputDirectory: prep.outputDirectory,
          rootDirectory: prep.rootDirectory,
        });
        frontendUrl = result.url;
        // The Vercel build runs async — return the id so the client can poll it
        // to readiness instead of optimistically reporting "live".
        frontendId = result.id;
      } catch (e) {
        frontendError = e instanceof Error ? e.message : String(e);
      }
    }

    if (!hasBackend && !front.found) {
      return NextResponse.json({ error: "No frontend or backend found in the selected files." }, { status: 400 });
    }

    // Preflight: research + grow the technology-tagged rule registry for this
    // stack (cache-first, so only an UNSEEN tech triggers a web search), and
    // surface the basic-correctness rules. Bounded + best-effort: never blocks or
    // fails the deploy.
    const backendFramework = container ? container.prep.plan.framework : hasBackend ? "node" : "static";
    const preflightFrameworks = [backendFramework, front.found ? "frontend" : null].filter(Boolean) as string[];
    const preflightRules = (
      await Promise.all(
        preflightFrameworks.map((fw) =>
          Promise.race([
            preflightForFramework(fw),
            new Promise<PreflightRule[]>((res) => setTimeout(() => res(seedRulesFor(fw)), 8000)),
          ]).catch(() => seedRulesFor(fw)),
        ),
      )
    ).flat();

    // Grow the engine for next time (best-effort, bounded, non-blocking): distill
    // researched advisories for this stack into candidate fixes, and promote any
    // whose outcome track record now clears the bar. Persisted for future deploys.
    const primaryTech = techTagsFor(backendFramework).slice(-1)[0];
    void Promise.race([
      Promise.all([distillAndStore(primaryTech).catch(() => 0), promoteFixes(primaryTech).catch(() => 0)]),
      new Promise((res) => setTimeout(res, 6000)),
    ]).catch(() => {});

    return NextResponse.json({
      frontendUrl,
      backendUrl,
      backendDashboard,
      backendProvider,
      repoUrl,
      dbWired,
      backendDir,
      backendRuntime: container ? "docker" : "node",
      backendFramework: container ? container.prep.plan.framework : "node",
      frontendDir: front.dir,
      hasBackend,
      backendError,
      backendNote,
      frontendId,
      frontendError,
      frontendUnwired,
      preflightRuleCount: preflightRules.length,
      preflightRules: preflightRules.map((rule) => ({ tech: rule.tech, title: rule.title, source: rule.source })),
      warnings: [
        ...(hasBackend ? backendWarnings : []),
        ...(frontendUnwired
          ? ["The backend failed to deploy, so the frontend was shipped without a working API URL — its login/data calls will fail in the browser. Fix the backend error above and redeploy."]
          : []),
      ],
    });
  } catch (error) {
    console.error("[deploy/fullstack]", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
