/**
 * C# truncation repair + the no-false-positive guarantee.
 *
 *   npx tsx scripts/test-truncation-cs.mts
 *
 * Reproduces the real Fly .NET failure (MenuService.cs(130): CS1513 } expected —
 * file cut off mid-method) and asserts the engine completes it so it compiles,
 * while staying a strict NO-OP on valid C# (interpolation, verbatim strings, char
 * literals holding braces). A false positive would corrupt a valid backend file.
 */
import { repairTruncatedCSharp, repairTruncatedSource, detectTruncatedSources } from "../src/lib/deploy/truncation";

let fails = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
};

// The exact production shape: a service truncated mid-method (CreateModifierAsync),
// where IMenuService DECLARES that method (so it must be completed, not dropped).
const MENU_SERVICE_TRUNCATED = `using Microsoft.EntityFrameworkCore;
namespace RestaurantManagement.Services;

public class MenuService : IMenuService
{
    private readonly AppDbContext _context;
    public MenuService(AppDbContext context) { _context = context; }

    public async Task<Modifier?> GetModifierByIdAsync(int id)
    {
        return await _context.Modifiers.FindAsync(id);
    }

    public async Task<Modifier> CreateModifierAsync(Modifier modifier)
    {
        modifier.CreatedAt = DateTime.UtcNow;
`;

const fixed = repairTruncatedCSharp("Services/MenuService.cs", MENU_SERVICE_TRUNCATED);
check("truncated MenuService.cs is detected + repaired", fixed !== null);
check("repair keeps the truncated method present (interface stays satisfied)", !!fixed && /CreateModifierAsync/.test(fixed!));
check("repair terminates the dangling body with throw (definite-return)", !!fixed && /NotImplementedException/.test(fixed!));
check("repaired file is brace-balanced (re-analyzes clean)", !!fixed && repairTruncatedCSharp("Services/MenuService.cs", fixed!) === null);
check("repair is idempotent", !!fixed && repairTruncatedCSharp("x.cs", fixed!) === null);
check("detector clears after repair", detectTruncatedSources([{ path: "Services/MenuService.cs", content: fixed! }]).length === 0);

// Class-level truncation (methods complete, class+namespace braces left open).
const CLASS_CUT = `namespace App;
public class Repo
{
    public int Count() { return 0; }
`;
const f2 = repairTruncatedCSharp("Repo.cs", CLASS_CUT);
check("class-level truncation closes braces", f2 !== null && repairTruncatedCSharp("Repo.cs", f2!) === null);
check("class-level repair adds NO spurious throw", !!f2 && !/NotImplementedException/.test(f2!));

// Mid-EXPRESSION truncation → NOT safely completable → null (caller blocks deploy).
const MID_EXPR = `namespace App;
public class C {
    public int F() {
        var x = 1 +
`;
check("mid-expression truncation is NOT auto-repaired (blocks instead)", repairTruncatedCSharp("C.cs", MID_EXPR) === null);

// NO-OP on valid C#. A hit here is a false positive that corrupts working code.
const GOOD: Array<[string, string]> = [
  ["interpolated string with braces", `class C { string M(int id) => $"User {id} has {{literal}} braces"; }`],
  ["verbatim string with quotes/backslash", `class C { string P = @"C:\\path\\to ""quoted"" file"; }`],
  ["char literal holding a brace", `class C { char Open = '{'; char Close = '}'; char Quote = '"'; }`],
  ["nested interpolation with a string call", `class C { string M() => $"hi {Format("x")} end"; string Format(string s) => s; }`],
  ["collection initializer", `class C { int[] A = new[] { 1, 2, 3 }; Dictionary<int,int> D = new() { { 1, 2 } }; }`],
  ["block comment with stray brace", `class C { /* } { unbalanced in comment */ public int X = 1; }`],
  ["expression-bodied + generics", `public class Repo<T> where T : class { public T? Get(int id) => default; }`],
  ["full service class", `namespace A;\npublic class S : IS {\n  public async Task<int> N() { return await Task.FromResult(1); }\n}`],
];
for (const [name, content] of GOOD) {
  check(`no-op on valid C#: ${name}`, repairTruncatedCSharp("f.cs", content) === null, "FALSE POSITIVE — would corrupt valid code");
}

// repairTruncatedSource dispatches .cs correctly alongside JS.
const mixed = repairTruncatedSource([
  { path: "Services/MenuService.cs", content: MENU_SERVICE_TRUNCATED },
  { path: "src/App.jsx", content: `export default function App(){ return <div/>; }` },
]);
check("repairTruncatedSource repairs the .cs and reports it", mixed.repaired.includes("Services/MenuService.cs"));
check("repairTruncatedSource leaves the valid .jsx alone", !mixed.repaired.includes("src/App.jsx"));

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL C# TRUNCATION TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
