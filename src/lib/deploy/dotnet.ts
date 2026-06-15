import type { RepoFile } from "./github";

/**
 * Resolve the .NET package-downgrade conflict (NU1605) at its SOURCE instead of
 * suppressing it.
 *
 * Generated ASP.NET auth apps habitually add an explicit, OUTDATED pin on the
 * JWT/IdentityModel packages while also referencing a newer
 * `Microsoft.AspNetCore.Authentication.JwtBearer`, e.g.:
 *
 *   <PackageReference Include="Microsoft.AspNetCore.Authentication.JwtBearer" Version="8.0.0" />
 *   <PackageReference Include="System.IdentityModel.Tokens.Jwt" Version="7.0.0" />   <-- too low
 *
 * JwtBearer 8.0.0 pulls System.IdentityModel.Tokens.Jwt 7.0.3 transitively, so the
 * explicit 7.0.0 is a *downgrade* — NuGet raises NU1605 (an error) and the restore
 * aborts. Suppressing it (NoWarn=NU1605) is WORSE than the build break: NuGet then
 * honours the lower pin and ships 7.0.0, but the JwtBearer assembly was compiled
 * against 7.0.3, so at runtime EVERY request throws
 *   FileNotFoundException: Could not load 'System.IdentityModel.Tokens.Jwt, Version=7.0.3.0'
 * → a green build that 500s on first use.
 *
 * The correct fix is to delete the redundant explicit pin: the package is provided
 * transitively at the version JwtBearer was built against, so restore is conflict-
 * free AND the right assembly ships. These IdentityModel packages are framework-
 * supplied — apps virtually never need to pin them by hand.
 */
const REDUNDANT_PIN =
  /[ \t]*<PackageReference\s+Include="(?:System\.IdentityModel\.Tokens\.Jwt|Microsoft\.IdentityModel\.[A-Za-z.]+)"[^>]*\/>[ \t]*\r?\n/g;

export interface DotnetFixResult {
  files: RepoFile[];
  notes: string[];
}

export function fixDotnetPackageConflicts(files: RepoFile[]): DotnetFixResult {
  const notes: string[] = [];
  const csprojs = files.filter((f) => /\.csproj$/.test(f.path));
  // Only strip the IdentityModel pins when a higher-level package supplies them
  // transitively — otherwise removing the reference would drop the package entirely.
  const broughtTransitively = csprojs.some((f) =>
    /Microsoft\.AspNetCore\.Authentication\.JwtBearer|Microsoft\.IdentityModel\.Protocols\.OpenIdConnect/.test(f.content),
  );
  if (!broughtTransitively) return { files, notes };

  let removed = 0;
  const out = files.map((f) => {
    if (!/\.csproj$/.test(f.path)) return f;
    const content = f.content.replace(REDUNDANT_PIN, () => {
      removed++;
      return "";
    });
    return content === f.content ? f : { path: f.path, content };
  });

  if (removed > 0) {
    notes.push(
      `.NET: removed ${removed} redundant IdentityModel package pin(s) that downgraded JwtBearer's ` +
        `transitive deps (root cause of the NU1605 build error and the runtime assembly-load 500).`,
    );
  }
  return { files: out, notes };
}

/**
 * Strip a hallucinated `var x = builder.CreateBuilder(...)` statement from Program.cs.
 *
 * `CreateBuilder` exists ONLY as the static factory `WebApplication.CreateBuilder`.
 * Generators sometimes emit a SECOND, bogus assignment that calls it on the builder
 * INSTANCE — e.g. `var app = builder.CreateBuilder();` — right before the real
 * `var webApp = builder.Build();`. That is a hard CS1061
 * ('WebApplicationBuilder' does not contain a definition for 'CreateBuilder'), so
 * `dotnet publish` fails to compile. On Fly that is invisible and fatal: the remote
 * build dies, `flyctl deploy` never creates a release, and the app sits forever in
 * `pending` with no machine (no compiler is run before deploy to catch it).
 *
 * The declared variable is a dead end (the app uses the real builder / Build()
 * result), so we drop the line — but only when that variable is referenced nowhere
 * else, so we can never turn a CS1061 into a CS0103 ("name does not exist").
 */
export function repairDotnetProgramBuilder(files: RepoFile[]): DotnetFixResult {
  const notes: string[] = [];
  const out = files.map((f) => {
    if (!/\.cs$/.test(f.path) || !/WebApplication\.CreateBuilder/.test(f.content) || !/\.Build\s*\(\s*\)/.test(f.content)) {
      return f;
    }
    const re = /^[ \t]*var\s+(\w+)\s*=\s*([A-Za-z_]\w*)\.CreateBuilder\s*\([^;]*\)\s*;[ \t]*\r?\n/gm;
    const content = f.content.replace(re, (full, varName: string, receiver: string) => {
      if (receiver === "WebApplication") return full; // the legitimate static factory
      // Drop the line only if the declared variable is never USED as code elsewhere
      // (member access `x.`, call `x(`, index `x[`, or passed/assigned `= x` / `(x` /
      // `, x`). A plain word match would also count the variable's name in a comment
      // like `// Build the app`, wrongly keeping a line that can't compile.
      const rest = f.content.replace(full, "");
      const usedAsCode = new RegExp(`\\b${varName}\\s*[.([]|[=,(]\\s*${varName}\\b`).test(rest);
      return usedAsCode ? full : "";
    });
    if (content !== f.content) {
      notes.push(`.NET: removed a hallucinated '<var> = <builder>.CreateBuilder(...)' statement in ${f.path} (CS1061 that broke the publish and stranded the Fly deploy in 'pending').`);
      return { path: f.path, content };
    }
    return f;
  });
  return { files: out, notes };
}

/**
 * Auto-register app-defined services that controllers inject but Program.cs never
 * wires into DI.
 *
 * Generated ASP.NET apps habitually define `interface IFooService` + `class
 * FooService : IFooService`, inject `IFooService` into a controller, and then
 * forget `builder.Services.AddScoped<IFooService, FooService>()`. The build
 * succeeds (it all compiles), but at runtime the controller can't be activated:
 *   InvalidOperationException: Unable to resolve service for type 'IFooService'
 *   while attempting to activate 'AuthController'
 * → every request to that controller 500s. This is the exact reason a freshly
 * deployed app's login/register never works despite correct frontend wiring.
 *
 * We pair every app-declared interface with its implementing class and inject the
 * missing `AddScoped` registrations (plus the `using` for their namespace) right
 * before `builder.Build()`. Scoped is the safe lifetime for request services.
 */
export function autoRegisterDotnetServices(files: RepoFile[]): DotnetFixResult {
  const notes: string[] = [];
  const progIdx = files.findIndex(
    (f) => /\.cs$/.test(f.path) && /WebApplication\.CreateBuilder/.test(f.content) && /builder\.Build\(\)/.test(f.content),
  );
  if (progIdx === -1) return { files, notes };
  let prog = files[progIdx].content;

  // 1) Every interface the app itself declares (framework interfaces are excluded
  //    since they're never declared here).
  const interfaces = new Set<string>();
  for (const f of files) {
    if (!/\.cs$/.test(f.path)) continue;
    for (const m of f.content.matchAll(/\binterface\s+(I[A-Z]\w*)\b/g)) interfaces.add(m[1]);
  }
  if (interfaces.size === 0) return { files, notes };

  // 2) Map each interface to an implementing class + that class's namespace.
  const impl = new Map<string, { cls: string; ns: string }>();
  for (const f of files) {
    if (!/\.cs$/.test(f.path)) continue;
    const ns = f.content.match(/\bnamespace\s+([\w.]+)/)?.[1] ?? "";
    for (const m of f.content.matchAll(/\bclass\s+(\w+)\s*:\s*([^{]+?)[\s{]/g)) {
      const cls = m[1];
      for (const base of m[2].split(",").map((s) => s.trim().split(/[\s<]/)[0])) {
        if (interfaces.has(base) && !impl.has(base)) impl.set(base, { cls, ns });
      }
    }
  }

  // 3) Register the pairs that aren't already registered.
  const regs: string[] = [];
  const namespaces = new Set<string>();
  for (const [iface, { cls, ns }] of impl) {
    if (new RegExp(`Add(?:Scoped|Singleton|Transient)\\s*<\\s*${iface}\\b`).test(prog)) continue;
    regs.push(`builder.Services.AddScoped<${iface}, ${cls}>();`);
    if (ns) namespaces.add(ns);
  }
  if (regs.length === 0) return { files, notes };

  // 4) Ensure the implementations' namespaces are imported, then inject the
  //    registrations immediately before the app is built.
  prog = ensureUsings(prog, [...namespaces]);
  const block = regs.join("\n") + "\n";
  prog = /var\s+app\s*=\s*builder\.Build\(\)\s*;/.test(prog)
    ? prog.replace(/(var\s+app\s*=\s*builder\.Build\(\)\s*;)/, `${block}$1`)
    : prog.replace(/([^\n]*\bbuilder\.Build\(\)[^\n]*\n)/, `${block}$1`);

  const out = [...files];
  out[progIdx] = { path: files[progIdx].path, content: prog };
  notes.push(
    `.NET: auto-registered ${regs.length} DI service(s) (${[...impl.keys()].join(", ")}) that controllers ` +
      `inject but Program.cs never registered (cause of the runtime 500 "Unable to resolve service").`,
  );
  return { files: out, notes };
}

/**
 * Remove DI registrations that reference services the generator never created.
 *
 * Generated apps frequently over-register: Program.cs lists
 * `AddScoped<IStaffService, StaffService>()` for services it planned but never
 * emitted as files, so the build fails to COMPILE (not restore):
 *   Program.cs: error CS0246: 'IStaffService' could not be found
 * Nothing else references the phantom service, so dropping the dead registration
 * lets the build proceed with the services that DO exist.
 *
 * Scoped tightly to the app-domain naming convention (…Service/Repository/Handler/
 * …) and gated on the type being undefined in the entire source, so framework
 * registrations (IHttpContextAccessor, IMemoryCache, …) are never touched.
 */
const DOMAIN_SERVICE = /(?:Service|Repository|Manager|Handler|Provider|Store|Gateway|UseCase|Factory)$/;

export function pruneDanglingServiceRegistrations(files: RepoFile[]): DotnetFixResult {
  const notes: string[] = [];
  const progIdx = files.findIndex(
    (f) => /\.cs$/.test(f.path) && /WebApplication\.CreateBuilder/.test(f.content) && /builder\.Build\(\)/.test(f.content),
  );
  if (progIdx === -1) return { files, notes };

  // Every type the app actually defines.
  const defined = new Set<string>();
  for (const f of files) {
    if (!/\.cs$/.test(f.path)) continue;
    for (const m of f.content.matchAll(/\b(?:interface|class|record|struct|enum)\s+(\w+)/g)) defined.add(m[1]);
  }

  const removed: string[] = [];
  const kept = files[progIdx].content
    .split("\n")
    .filter((line) => {
      const m = line.match(/\bAdd(?:Scoped|Singleton|Transient)\s*<([^>]+)>\s*\(\s*\)/);
      if (!m) return true;
      const args = m[1].split(",").map((s) => s.trim().replace(/<.*>/, ""));
      // Drop the line if any arg is a domain service that isn't defined in the source.
      const phantom = args.find((a) => DOMAIN_SERVICE.test(a) && !defined.has(a));
      if (phantom) {
        removed.push(phantom);
        return false;
      }
      return true;
    })
    .join("\n");

  if (removed.length === 0) return { files, notes };
  const out = [...files];
  out[progIdx] = { path: files[progIdx].path, content: kept };
  notes.push(
    `.NET: removed ${removed.length} DI registration(s) for services the app never defined ` +
      `(${[...new Set(removed)].join(", ")}) — phantom registrations that fail the build with CS0246.`,
  );
  return { files: out, notes };
}

/**
 * Ensure the backend accepts cross-origin calls from its separately-deployed
 * frontend.
 *
 * In a split deploy (backend → Fly, frontend → Vercel) the browser makes a
 * cross-origin request from the Vercel origin to the Fly backend. If the backend
 * has no CORS policy — generated .NET APIs frequently ship none — every call is
 * blocked: "Access-Control-Allow-Origin: none / Failed to fetch", and login/
 * register die in the browser even though the API works via curl.
 *
 * The exact frontend origin is unknown when the backend builds (the backend
 * deploys FIRST to hand its URL to the frontend), so we install a policy that
 * reflects any origin. `SetIsOriginAllowed(_ => true)` (not AllowAnyOrigin) is
 * used deliberately: it echoes the caller's origin, which — unlike the literal
 * `*` — is valid together with AllowCredentials, so the policy works whether the
 * app authenticates via the Authorization header or cookies.
 *
 * Only injected when the app has NO CORS pipeline; an app that already calls
 * UseCors is left to its own configuration.
 */
export function ensureDotnetCors(files: RepoFile[]): DotnetFixResult {
  const notes: string[] = [];
  const progIdx = files.findIndex(
    (f) => /\.cs$/.test(f.path) && /WebApplication\.CreateBuilder/.test(f.content) && /builder\.Build\(\)/.test(f.content),
  );
  if (progIdx === -1) return { files, notes };
  let prog = files[progIdx].content;
  if (/\bUseCors\b/.test(prog)) return { files, notes }; // app configures its own CORS

  const POLICY = `builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.SetIsOriginAllowed(_ => true).AllowAnyHeader().AllowAnyMethod().AllowCredentials()));`;
  if (!/AddCors\s*\(/.test(prog)) {
    prog = /var\s+app\s*=\s*builder\.Build\(\)\s*;/.test(prog)
      ? prog.replace(/(var\s+app\s*=\s*builder\.Build\(\)\s*;)/, `${POLICY}\n$1`)
      : prog.replace(/([^\n]*\bbuilder\.Build\(\)[^\n]*\n)/, `${POLICY}\n$1`);
  }
  // UseCors must run before auth/authorization; placing it right after Build()
  // puts it ahead of UseAuthentication/UseAuthorization/MapControllers.
  prog = prog.replace(/(var\s+app\s*=\s*builder\.Build\(\)\s*;\n)/, `$1app.UseCors();\n`);

  const out = [...files];
  out[progIdx] = { path: files[progIdx].path, content: prog };
  notes.push(
    ".NET: injected an open CORS policy (reflect-any-origin + credentials) so the Vercel-hosted frontend's cross-origin API calls aren't blocked (was: Access-Control-Allow-Origin none → 'Failed to fetch').",
  );
  return { files: out, notes };
}

/**
 * Flag a backend that exposes NO HTTP endpoints.
 *
 * Some generations emit Models + Data + Services (and call `app.MapControllers()`)
 * but never write the Controllers — so the API the frontend calls doesn't exist
 * and every /api/* request 404s. The deploy engine can make such an app build,
 * run, and accept CORS, but it cannot invent a correct, frontend-matching API
 * surface (routes, DTOs, a registration flow the service may not even support).
 * That's a code-generation gap; the honest move is to surface it loudly rather
 * than ship a backend with no routes. Returns a warning note (does not block).
 */
export function detectMissingDotnetApi(files: RepoFile[]): DotnetFixResult {
  const progIdx = files.findIndex(
    (f) => /\.cs$/.test(f.path) && /WebApplication\.CreateBuilder/.test(f.content) && /builder\.Build\(\)/.test(f.content),
  );
  if (progIdx === -1) return { files, notes: [] };
  const prog = files[progIdx].content;

  const mapsControllers = /\bMapControllers\s*\(\s*\)/.test(prog);
  const hasController = files.some(
    (f) => /\.cs$/.test(f.path) && /:\s*(ControllerBase|Controller)\b/.test(f.content) && /\[(ApiController|Route|Http\w+)\b/.test(f.content),
  );
  const hasMinimalEndpoints = /\bapp\.Map(Get|Post|Put|Delete|Patch|Group)\s*\(/.test(prog) || /\bMapGroup\s*\(/.test(prog);

  if (mapsControllers && !hasController && !hasMinimalEndpoints) {
    return {
      files,
      notes: [
        "⚠ Backend exposes NO HTTP endpoints — MapControllers() is called but the app ships no controllers and no minimal-API routes, so every /api/* request 404s. The backend was generated without its API layer; it must be regenerated WITH controllers (the deploy engine can't synthesise a frontend-matching API).",
      ],
    };
  }
  return { files, notes: [] };
}

/** Add `using <ns>;` lines after the leading using block (top-level-statement safe). */
function ensureUsings(src: string, namespaces: string[]): string {
  const missing = namespaces.filter(
    (ns) => !new RegExp(`^\\s*using\\s+${ns.replace(/\./g, "\\.")}\\s*;`, "m").test(src),
  );
  if (missing.length === 0) return src;
  const block = missing.map((ns) => `using ${ns};`).join("\n");
  const lines = src.split("\n");
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*using\s+[\w.]+\s*;/.test(lines[i])) last = i;
    else if (lines[i].trim() !== "" && last >= 0) break;
  }
  if (last >= 0) {
    lines.splice(last + 1, 0, block);
    return lines.join("\n");
  }
  return `${block}\n${src}`;
}
