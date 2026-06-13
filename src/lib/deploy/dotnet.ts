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
