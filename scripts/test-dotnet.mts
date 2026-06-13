/**
 * Tests for the .NET deploy fixes (dotnet.ts). Safety-critical: the prune must
 * remove ONLY phantom registrations, never valid app or framework ones.
 *
 *   npx tsx scripts/test-dotnet.mts
 */
import { fixDotnetPackageConflicts, autoRegisterDotnetServices, pruneDanglingServiceRegistrations, ensureDotnetCors } from "../src/lib/deploy/dotnet";

type F = { path: string; content: string };
let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
}
const prog = (files: F[]) => files.find((f) => f.path === "Program.cs")!.content;

// --- prune: remove phantom service regs, keep defined + framework ones ---
{
  const files: F[] = [
    {
      path: "Program.cs",
      content:
        "var builder = WebApplication.CreateBuilder(args);\n" +
        "builder.Services.AddScoped<IAuthService, AuthService>();\n" +
        "builder.Services.AddScoped<IStaffService, StaffService>();\n" +
        "builder.Services.AddScoped<IHttpContextAccessor, HttpContextAccessor>();\n" +
        "builder.Services.AddSingleton<IMemoryCache, MemoryCache>();\n" +
        "var app = builder.Build();\n",
    },
    { path: "Services/AuthService.cs", content: "namespace X; public interface IAuthService {} public class AuthService : IAuthService {}" },
  ];
  const r = pruneDanglingServiceRegistrations(files);
  const p = prog(r.files);
  console.log("prune:");
  check("removes phantom IStaffService", !/IStaffService/.test(p), p);
  check("keeps defined IAuthService", /IAuthService, AuthService/.test(p), p);
  check("keeps framework IHttpContextAccessor (Accessor suffix)", /IHttpContextAccessor/.test(p), p);
  check("keeps framework IMemoryCache (Cache suffix)", /IMemoryCache/.test(p), p);
}

// --- auto-register: add defined-but-unregistered injected service ---
{
  const files: F[] = [
    { path: "Program.cs", content: "var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\n" },
    { path: "Services/JwtService.cs", content: "namespace App.Services; public interface IJwtService {} public class JwtService : IJwtService {}" },
    { path: "Controllers/AuthController.cs", content: "public class AuthController { public AuthController(IJwtService j){} }" },
  ];
  const r = autoRegisterDotnetServices(files);
  const p = prog(r.files);
  console.log("auto-register:");
  check("registers IJwtService", /AddScoped<IJwtService, JwtService>/.test(p), p);
  check("adds using App.Services", /using App\.Services;/.test(p), p);
}

// --- package conflict: drop redundant IdentityModel pin when JwtBearer present ---
{
  const files: F[] = [
    {
      path: "App.csproj",
      content:
        '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup>\n' +
        '<PackageReference Include="Microsoft.AspNetCore.Authentication.JwtBearer" Version="8.0.0" />\n' +
        '<PackageReference Include="System.IdentityModel.Tokens.Jwt" Version="7.0.0" />\n' +
        "</ItemGroup></Project>",
    },
  ];
  const r = fixDotnetPackageConflicts(files);
  const csproj = r.files.find((f) => f.path === "App.csproj")!.content;
  console.log("package conflict:");
  check("removes System.IdentityModel.Tokens.Jwt pin", !/System\.IdentityModel\.Tokens\.Jwt/.test(csproj), csproj);
  check("keeps JwtBearer", /JwtBearer/.test(csproj), csproj);
}

// --- CORS: inject when absent, leave when present ---
{
  const noCors: F[] = [{ path: "Program.cs", content: "var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\napp.UseAuthorization();\napp.Run();\n" }];
  const r = ensureDotnetCors(noCors);
  const p = prog(r.files);
  console.log("cors:");
  check("injects AddCors default policy", /AddCors\(o => o\.AddDefaultPolicy/.test(p), p);
  check("injects app.UseCors() before auth", p.indexOf("UseCors") < p.indexOf("UseAuthorization"), p);
  check("uses reflect-origin + credentials (not literal *)", /SetIsOriginAllowed\(_ => true\)/.test(p) && /AllowCredentials/.test(p), p);

  const hasCors: F[] = [{ path: "Program.cs", content: 'var builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddCors();\nvar app = builder.Build();\napp.UseCors("My");\napp.Run();\n' }];
  const r2 = ensureDotnetCors(hasCors);
  check("leaves an app that already uses CORS untouched", r2.files === hasCors && r2.notes.length === 0);
}

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL .NET TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
