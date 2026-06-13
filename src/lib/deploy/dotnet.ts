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
