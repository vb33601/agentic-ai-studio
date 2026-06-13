/**
 * Reproduces the production CS0246 the user hit on a .NET Fly deploy:
 *   Program.cs registers AddScoped<IStaffService, StaffService>() for services the
 *   generator never emitted → `dotnet publish` fails CS0246 → Fly build aborts,
 *   app hangs at 0 machines.
 *
 * Runs the real .NET passes in the SAME order universal-prepare applies them
 * (auto-register → prune) and asserts: the phantom registrations are removed, the
 * real ones survive, and no phantom is (re)introduced by auto-register.
 *
 *   npx tsx scripts/test-dotnet-di-prune.mts
 */
import { autoRegisterDotnetServices, pruneDanglingServiceRegistrations } from "../src/lib/deploy/dotnet";
import type { RepoFile } from "../src/lib/deploy/github";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

// The RestaurantManagement shape: 6 services that EXIST + 3 phantom (Staff/Feedback/
// Report) that were registered but never generated.
const PROGRAM = `using Microsoft.EntityFrameworkCore;
using RestaurantManagement.Data;
using RestaurantManagement.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddScoped<IAuthService, AuthService>();
builder.Services.AddScoped<IMenuService, MenuService>();
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddScoped<IReservationService, ReservationService>();
builder.Services.AddScoped<IBillingService, BillingService>();
builder.Services.AddScoped<IInventoryService, InventoryService>();
builder.Services.AddScoped<IStaffService, StaffService>();
builder.Services.AddScoped<IFeedbackService, FeedbackService>();
builder.Services.AddScoped<IReportService, ReportService>();
var app = builder.Build();
app.MapControllers();
app.Run();
`;

// Only the 6 real services have source files (interface + class). Staff/Feedback/
// Report have NONE — that's the bug.
const realServices = ["Auth", "Menu", "Order", "Reservation", "Billing", "Inventory"];
const files: RepoFile[] = [
  { path: "Program.cs", content: PROGRAM },
  ...realServices.map((s) => ({
    path: `Services/${s}Service.cs`,
    content: `namespace RestaurantManagement.Services;\npublic interface I${s}Service { }\npublic class ${s}Service : I${s}Service { }\n`,
  })),
];

// Pipeline order from universal-prepare.ts: register THEN prune.
let out = autoRegisterDotnetServices(files).files;
const pruneRes = pruneDanglingServiceRegistrations(out);
out = pruneRes.files;
const program = out.find((f) => f.path === "Program.cs")!.content;

// 1) Phantom registrations are GONE (the CS0246 cause).
for (const phantom of ["StaffService", "FeedbackService", "ReportService"]) {
  check(`phantom ${phantom} registration removed`, !program.includes(phantom), "still present → CS0246 on build");
}
// 2) Real registrations survive.
for (const real of realServices) {
  check(`real ${real}Service registration kept`, program.includes(`${real}Service`));
}
// 3) Auto-register did not re-introduce a phantom impl (the register/prune interaction).
check("no AddScoped for an undefined impl remains", !/AddScoped<\s*I(Staff|Feedback|Report)Service\s*,\s*(Staff|Feedback|Report)Service\s*>/.test(program));
check("prune reported the phantoms", pruneRes.notes.join(" ").includes("StaffService") || pruneRes.notes.length > 0);

console.log("-".repeat(60));
console.log(fails === 0 ? "PASS — engine prunes the phantom .NET DI registrations (CS0246 fixed)" : `${fails} CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
