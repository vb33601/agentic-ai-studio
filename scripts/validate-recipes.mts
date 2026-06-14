/**
 * Live validation of EVERY sandbox recipe: run each stack's recipe in a real
 * Vercel Sandbox with a minimal valid app, and record the outcome.
 *
 *   VERCEL_TOKEN=… npx tsx scripts/validate-recipes.mts
 *
 * Outcomes:
 *   BUILT   ok && !setupSkipped  → toolchain installed + valid app built (fully verified)
 *   SKIP    ok && setupSkipped   → toolchain not installable here → fail-open (best-effort)
 *   BLOCK   !ok                  → blocked a VALID app → recipe bug (fix or demote)
 */
import { sandboxVerifyBuild, recipeFor } from "../src/lib/deploy/sandbox-verify";
import { vercelSandboxFactory } from "../src/lib/deploy/vercel-sandbox-runner";
import type { Stack } from "../src/lib/deploy/dockerfile";

type F = { path: string; content: string };
const APPS: Partial<Record<Stack, F[]>> = {
  node: [{ path: "package.json", content: '{"name":"m","private":true,"scripts":{"start":"node index.js"}}' }, { path: "index.js", content: "const h=require('http');h.createServer((_q,r)=>r.end('ok')).listen(process.env.PORT||3000);" }],
  bun: [{ path: "package.json", content: '{"name":"m","private":true,"scripts":{"start":"node index.js"}}' }, { path: "index.js", content: "const h=require('http');h.createServer((_q,r)=>r.end('ok')).listen(process.env.PORT||3000);" }],
  static: [{ path: "package.json", content: '{"name":"m","private":true}' }, { path: "index.html", content: "<!doctype html><h1>ok</h1>" }],
  python: [{ path: "main.py", content: "print('ok')\n" }],
  dotnet: [{ path: "m.csproj", content: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>' }, { path: "Program.cs", content: "class P{static void Main(){System.Console.WriteLine(\"ok\");}}" }],
  go: [{ path: "go.mod", content: "module m\n\ngo 1.21\n" }, { path: "main.go", content: "package main\nfunc main(){}\n" }],
  rust: [{ path: "Cargo.toml", content: "[package]\nname=\"m\"\nversion=\"0.1.0\"\nedition=\"2021\"\n" }, { path: "src/main.rs", content: "fn main(){}\n" }],
  cpp: [{ path: "main.cpp", content: "int main(){return 0;}\n" }],
  java: [{ path: "Main.java", content: "class Main{public static void main(String[] a){}}\n" }],
  ruby: [{ path: "app.rb", content: "puts 'ok'\n" }],
  php: [{ path: "index.php", content: "<?php echo 'ok';\n" }],
  deno: [{ path: "main.ts", content: "console.log('ok')\n" }],
  perl: [{ path: "app.pl", content: "print \"ok\\n\";\n" }],
  lua: [{ path: "app.lua", content: "print('ok')\n" }],
  r: [{ path: "app.R", content: "cat('ok')\n" }],
  elixir: [{ path: "mix.exs", content: "defmodule M.MixProject do\n  use Mix.Project\n  def project, do: [app: :m, version: \"0.1.0\"]\nend\n" }, { path: "lib/m.ex", content: "defmodule M do\nend\n" }],
  erlang: [{ path: "m.erl", content: "-module(m).\n-export([]).\n" }],
  ocaml: [{ path: "m.ml", content: "let () = print_string \"ok\"\n" }],
  haskell: [{ path: "Main.hs", content: "main :: IO ()\nmain = return ()\n" }],
  ada: [{ path: "m.adb", content: "procedure M is\nbegin\n  null;\nend M;\n" }],
  pascal: [{ path: "m.pas", content: "begin\nend.\n" }],
  nim: [{ path: "m.nim", content: "echo \"ok\"\n" }],
  d: [{ path: "m.d", content: "void main(){}\n" }],
  haxe: [{ path: "Main.hx", content: "class Main{static function main(){}}\n" }],
  lisp: [{ path: "m.lisp", content: "(print 1)\n" }],
  racket: [{ path: "m.rkt", content: "#lang racket\n1\n" }],
  clojure: [{ path: "m.clj", content: "(println 1)\n" }],
  tcl: [{ path: "m.tcl", content: "puts ok\n" }],
  prolog: [{ path: "m.pro", content: ":- initialization(halt).\n" }],
  julia: [{ path: "m.jl", content: "println(1)\n" }],
  raku: [{ path: "m.raku", content: "say 1\n" }],
  swift: [{ path: "m.swift", content: "print(\"ok\")\n" }],
  crystal: [{ path: "m.cr", content: "puts \"ok\"\n" }],
  zig: [{ path: "main.zig", content: "pub fn main() void {}\n" }],
  vlang: [{ path: "m.v", content: "fn main(){}\n" }],
  gleam: [{ path: "gleam.toml", content: "name = \"m\"\n" }, { path: "src/m.gleam", content: "pub fn main(){ 1 }\n" }],
  dart: [{ path: "m.dart", content: "void main(){}\n" }],
  ballerina: [{ path: "main.bal", content: "public function main(){}\n" }],
  powershell: [{ path: "m.ps1", content: "Write-Output 'ok'\n" }],
  hack: [{ path: "m.hack", content: "<?hh\nfunction main(): void {}\n" }],
};

const filter = (process.env.STACKS || "").split(",").map((s) => s.trim()).filter(Boolean);
const allStacks = (Object.keys(APPS) as Stack[]).filter((s) => filter.length === 0 || filter.includes(s));
const results: Array<{ stack: string; verdict: string; secs: number; note: string }> = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOne(stack: Stack) {
  const recipe = recipeFor(stack);
  const files = APPS[stack]!;
  const t0 = Date.now();
  try {
    // Retry on Vercel Sandbox rate limiting (429) with exponential backoff.
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = await sandboxVerifyBuild({ files, recipe: recipe!, factory: vercelSandboxFactory, sandboxTimeoutMs: 300_000 });
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/429|rate limit|too many/i.test(msg) && attempt < 6) { await sleep(8000 * (attempt + 1)); continue; }
        throw e;
      }
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    const verdict = !r.ok ? "BLOCK" : r.setupSkipped ? "SKIP" : "BUILT";
    results.push({ stack, verdict, secs, note: !r.ok ? (r.blocker || "").slice(0, 70) : (r.runChecked ? `runOk=${r.runOk}` : "") });
    console.log(`  ${verdict.padEnd(6)} ${stack.padEnd(12)} ${secs}s ${!r.ok ? "← " + (r.blocker || "").slice(0, 60) : ""}`);
  } catch (e) {
    const secs = Math.round((Date.now() - t0) / 1000);
    results.push({ stack, verdict: "ERROR", secs, note: e instanceof Error ? e.message.slice(0, 70) : String(e) });
    console.log(`  ERROR  ${stack.padEnd(12)} ${secs}s ← ${e instanceof Error ? e.message.slice(0, 60) : e}`);
  }
}

// Sequential by default — the sandbox plan caps concurrent VMs (429 otherwise).
const CONC = Number(process.env.CONC || 1);
async function main() {
  console.log(`Validating ${allStacks.length} recipes (concurrency ${CONC})…\n`);
  const queue = [...allStacks];
  const workers = Array.from({ length: CONC }, async () => {
    while (queue.length) { const s = queue.shift()!; await runOne(s); await sleep(2000); }
  });
  await Promise.all(workers);

  const by = (v: string) => results.filter((r) => r.verdict === v).map((r) => r.stack);
  console.log("\n" + "=".repeat(60));
  console.log(`BUILT (toolchain ran + valid app built): ${by("BUILT").length}\n  ${by("BUILT").join(", ")}`);
  console.log(`SKIP  (toolchain absent → fail-open):    ${by("SKIP").length}\n  ${by("SKIP").join(", ")}`);
  console.log(`BLOCK (blocked a VALID app → FIX):       ${by("BLOCK").length}\n  ${by("BLOCK").join(", ")}`);
  console.log(`ERROR (sandbox/infra):                   ${by("ERROR").length}\n  ${by("ERROR").join(", ")}`);
}
main();
