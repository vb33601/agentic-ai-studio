/**
 * Stack generation + deployment harness.
 *
 * Exercises the SAME engine the studio runs at generate/deploy time
 * (`detectStackPlan` in src/lib/deploy/dockerfile.ts) across a representative
 * fixture for every supported stack and framework variant — 45+ app types.
 *
 * Two tiers:
 *   • Structural (default, no Docker): for each fixture assert the right stack
 *     and framework are detected and the generated Dockerfile satisfies its
 *     build-correctness invariants (shared with the runtime gate via
 *     stack-invariants.ts). Fast, deterministic, CI-safe.
 *   • Docker (--docker): additionally `docker build` the fixtures flagged
 *     buildable, pruning the image after each so the disk can't fill. Proves the
 *     generated Dockerfile actually builds. `--docker=all` attempts every fixture
 *     (most exotic langs need richer fixtures and are expected to fail the build).
 *
 * Usage:
 *   npx tsx scripts/test-stacks.mts                 # structural, all stacks
 *   npx tsx scripts/test-stacks.mts --docker        # + build the buildable subset
 *   npx tsx scripts/test-stacks.mts --docker=all    # + attempt to build everything
 *   npx tsx scripts/test-stacks.mts --filter=dotnet # only matching fixtures
 */
import { detectStackPlan } from "../src/lib/deploy/dockerfile";
import { checkDockerfileInvariants } from "../src/lib/deploy/stack-invariants";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

type File = { path: string; content: string };
interface Case {
  name: string;
  files: File[];
  stack: string;
  framework?: string;
  /** Build this fixture under --docker (without --docker=all). */
  docker?: boolean;
}

const r = (content: string): string => content; // readability helper

const CASES: Case[] = [
  // ---- Node / JS / edge runtimes ----
  { name: "node", stack: "node", framework: "node", docker: true, files: [
    { path: "package.json", content: r(`{"name":"hello","version":"1.0.0"}`) },
    { path: "index.js", content: r(`require("http").createServer((_,res)=>res.end("ok")).listen(process.env.PORT||3000);`) },
  ] },
  { name: "deno", stack: "deno", files: [
    { path: "deno.json", content: r(`{"tasks":{}}`) },
    { path: "main.ts", content: r(`Deno.serve((_req) => new Response("ok"));`) },
  ] },
  { name: "bun", stack: "bun", files: [
    { path: "bunfig.toml", content: r(`[install]\n`) },
    { path: "index.ts", content: r(`Bun.serve({ fetch: () => new Response("ok") });`) },
  ] },

  // ---- Python (4 framework variants) ----
  { name: "python-django", stack: "python", framework: "django", files: [
    { path: "requirements.txt", content: r(`Django>=4.2\n`) },
    { path: "manage.py", content: r(`# django entrypoint\n`) },
    { path: "config/settings.py", content: r(`# settings\n`) },
    { path: "config/wsgi.py", content: r(`# wsgi\n`) },
  ] },
  { name: "python-fastapi", stack: "python", framework: "fastapi", docker: true, files: [
    { path: "requirements.txt", content: r(`fastapi\n`) },
    { path: "main.py", content: r(`from fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/")\ndef home():\n    return {"ok": True}\n`) },
  ] },
  { name: "python-flask", stack: "python", framework: "flask", docker: true, files: [
    { path: "requirements.txt", content: r(`flask\n`) },
    { path: "app.py", content: r(`from flask import Flask\napp = Flask(__name__)\n\n@app.get("/")\ndef home():\n    return "ok"\n`) },
  ] },
  { name: "python-generic", stack: "python", framework: "python", files: [
    { path: "requirements.txt", content: r(`requests\n`) },
    { path: "main.py", content: r(`print("ok")\n`) },
  ] },

  // ---- Ruby (3 variants) ----
  { name: "ruby-rails", stack: "ruby", framework: "rails", files: [
    { path: "Gemfile", content: r(`source "https://rubygems.org"\ngem "rails"\n`) },
    { path: "config/application.rb", content: r(`# rails app\n`) },
  ] },
  { name: "ruby-sinatra", stack: "ruby", framework: "sinatra", files: [
    { path: "Gemfile", content: r(`source "https://rubygems.org"\ngem "sinatra"\n`) },
    { path: "config.ru", content: r(`require "sinatra"\nrun Sinatra::Application\n`) },
  ] },
  { name: "ruby-generic", stack: "ruby", framework: "ruby", files: [
    { path: "Gemfile", content: r(`source "https://rubygems.org"\n`) },
    { path: "app.rb", content: r(`puts "ok"\n`) },
  ] },

  // ---- PHP (3 variants) ----
  { name: "php-laravel", stack: "php", framework: "laravel", files: [
    { path: "composer.json", content: r(`{"require":{"laravel/framework":"^11.0"}}`) },
    { path: "artisan", content: r(`#!/usr/bin/env php\n`) },
  ] },
  { name: "php-symfony", stack: "php", framework: "symfony", files: [
    { path: "composer.json", content: r(`{"require":{"symfony/framework-bundle":"^7.0"}}`) },
    { path: "bin/console", content: r(`#!/usr/bin/env php\n`) },
  ] },
  { name: "php-plain", stack: "php", framework: "php", files: [
    { path: "composer.json", content: r(`{"require":{}}`) },
    { path: "index.php", content: r(`<?php echo "ok";`) },
  ] },

  // ---- JVM (Spring / Java / Scala) ----
  { name: "java-spring", stack: "java", framework: "spring", files: [
    { path: "pom.xml", content: r(`<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>`) },
  ] },
  { name: "java-plain", stack: "java", framework: "java", files: [
    { path: "pom.xml", content: r(`<project><modelVersion>4.0.0</modelVersion></project>`) },
  ] },
  { name: "scala-sbt", stack: "java", framework: "scala", files: [
    { path: "build.sbt", content: r(`name := "app"\nscalaVersion := "3.5.0"\n`) },
  ] },

  // ---- Go / Rust / .NET ----
  { name: "go", stack: "go", framework: "go", docker: true, files: [
    { path: "go.mod", content: r(`module hello\n\ngo 1.22\n`) },
    { path: "main.go", content: r(`package main\n\nimport (\n\t"net/http"\n\t"os"\n)\n\nfunc main() {\n\thttp.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })\n\tp := os.Getenv("PORT")\n\tif p == "" {\n\t\tp = "8080"\n\t}\n\thttp.ListenAndServe(":"+p, nil)\n}\n`) },
  ] },
  { name: "rust", stack: "rust", framework: "rust", files: [
    { path: "Cargo.toml", content: r(`[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n`) },
    { path: "src/main.rs", content: r(`fn main() { println!("ok"); }\n`) },
  ] },
  // .NET fixture carries a real NU1605 downgrade (direct EFCore 8 vs transitive 9):
  // proves the generated Dockerfile's NoWarn flags keep restore alive.
  { name: "dotnet", stack: "dotnet", framework: "aspnet", docker: true, files: [
    { path: "App.csproj", content: r(`<Project Sdk="Microsoft.NET.Sdk.Web">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <ImplicitUsings>enable</ImplicitUsings>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />\n    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="9.0.0" />\n  </ItemGroup>\n</Project>\n`) },
    { path: "Program.cs", content: r(`var builder = WebApplication.CreateBuilder(args);\nvar app = builder.Build();\napp.MapGet("/", () => "ok");\napp.Run();\n`) },
  ] },

  // ---- Static ----
  { name: "static", stack: "static", framework: "static", docker: true, files: [
    { path: "index.html", content: r(`<!doctype html><html><body><h1>ok</h1></body></html>\n`) },
  ] },

  // ---- BEAM ----
  { name: "elixir", stack: "elixir", files: [
    { path: "mix.exs", content: r(`defmodule App.MixProject do\n  use Mix.Project\n  def project, do: [app: :app, version: "0.1.0"]\nend\n`) },
  ] },
  { name: "erlang", stack: "erlang", files: [
    { path: "rebar.config", content: r(`{erl_opts, []}.\n{deps, []}.\n`) },
  ] },
  { name: "gleam", stack: "gleam", files: [
    { path: "gleam.toml", content: r(`name = "app"\nversion = "1.0.0"\n`) },
  ] },

  // ---- Systems / compiled ----
  { name: "cpp", stack: "cpp", files: [
    { path: "CMakeLists.txt", content: r(`cmake_minimum_required(VERSION 3.10)\nproject(app)\nadd_executable(app main.cpp)\n`) },
    { path: "main.cpp", content: r(`int main() { return 0; }\n`) },
  ] },
  { name: "zig", stack: "zig", files: [
    { path: "build.zig", content: r(`const std = @import("std");\npub fn build(b: *std.Build) void { _ = b; }\n`) },
  ] },
  { name: "nim", stack: "nim", files: [
    { path: "app.nimble", content: r(`version = "0.1.0"\nbin = @["app"]\n`) },
  ] },
  { name: "crystal", stack: "crystal", files: [
    { path: "shard.yml", content: r(`name: app\nversion: 0.1.0\n`) },
  ] },
  { name: "d", stack: "d", files: [
    { path: "dub.json", content: r(`{"name":"app"}`) },
  ] },
  { name: "vlang", stack: "vlang", files: [
    { path: "v.mod", content: r(`Module { name: 'app' }\n`) },
  ] },
  { name: "ada", stack: "ada", files: [
    { path: "alire.toml", content: r(`name = "app"\nversion = "0.1.0"\n`) },
  ] },
  { name: "pascal", stack: "pascal", files: [
    { path: "main.pas", content: r(`program App; begin end.\n`) },
  ] },
  { name: "haskell", stack: "haskell", files: [
    { path: "package.yaml", content: r(`name: app\nversion: 0.1.0\n`) },
  ] },
  { name: "ocaml", stack: "ocaml", files: [
    { path: "dune-project", content: r(`(lang dune 3.0)\n`) },
  ] },

  // ---- Functional / Lisp family ----
  { name: "clojure", stack: "clojure", files: [
    { path: "deps.edn", content: r(`{:deps {}}\n`) },
  ] },
  { name: "racket", stack: "racket", files: [
    { path: "info.rkt", content: r(`#lang info\n(define collection "app")\n`) },
  ] },
  { name: "lisp", stack: "lisp", files: [
    { path: "app.asd", content: r(`(defsystem "app" :components ())\n`) },
  ] },

  // ---- Scripting ----
  { name: "lua", stack: "lua", files: [
    { path: "app.lua", content: r(`print("ok")\n`) },
  ] },
  { name: "perl", stack: "perl", files: [
    { path: "cpanfile", content: r(`requires 'Mojolicious';\n`) },
  ] },
  { name: "raku", stack: "raku", files: [
    { path: "META6.json", content: r(`{"name":"App","version":"0.1.0"}`) },
  ] },
  { name: "tcl", stack: "tcl", files: [
    { path: "app.tcl", content: r(`puts "ok"\n`) },
  ] },
  { name: "powershell", stack: "powershell", files: [
    { path: "app.ps1", content: r(`Write-Output "ok"\n`) },
  ] },
  { name: "r-plumber", stack: "r", framework: "plumber", files: [
    { path: "plumber.R", content: r(`#* @get /\nfunction() { "ok" }\n`) },
  ] },
  { name: "julia", stack: "julia", files: [
    { path: "Project.toml", content: r(`name = "App"\nuuid = "00000000-0000-0000-0000-000000000000"\n`) },
  ] },

  // ---- Mobile / misc ----
  { name: "swift", stack: "swift", files: [
    { path: "Package.swift", content: r(`// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "app")\n`) },
  ] },
  { name: "dart", stack: "dart", files: [
    { path: "pubspec.yaml", content: r(`name: app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n`) },
    { path: "bin/main.dart", content: r(`void main() { print("ok"); }\n`) },
  ] },
  { name: "haxe", stack: "haxe", files: [
    { path: "Main.hx", content: r(`class Main { static function main() {} }\n`) },
  ] },
  { name: "hack", stack: "hack", files: [
    { path: ".hhconfig", content: r(`\n`) },
    { path: "main.hack", content: r(`<<__EntryPoint>>\nfunction main(): void {}\n`) },
  ] },
  { name: "ballerina", stack: "ballerina", files: [
    { path: "Ballerina.toml", content: r(`[package]\nname = "app"\n`) },
  ] },
  { name: "prolog", stack: "prolog", files: [
    { path: "app.pro", content: r(`:- initialization(main).\nmain :- write(ok), nl.\n`) },
  ] },
];

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const filter = args.find((a) => a.startsWith("--filter="))?.split("=")[1];
const dockerArg = args.find((a) => a === "--docker" || a.startsWith("--docker="));
const dockerMode = dockerArg ? (dockerArg.includes("=all") ? "all" : "subset") : "off";

const selected = filter ? CASES.filter((c) => c.name.includes(filter)) : CASES;

interface Result { name: string; gen: "pass" | "fail"; genMsg?: string; build?: "pass" | "fail" | "skip"; buildMsg?: string }
const results: Result[] = [];

// ---- Tier 1: structural (generation) ----
for (const c of selected) {
  const errs: string[] = [];
  try {
    const plan = detectStackPlan(c.files);
    if (plan.stack !== c.stack) errs.push(`stack: expected "${c.stack}", got "${plan.stack}"`);
    if (c.framework && plan.framework !== c.framework) errs.push(`framework: expected "${c.framework}", got "${plan.framework}"`);
    if (typeof plan.port !== "number") errs.push(`port not a number (${plan.port})`);
    if (!plan.dockerignore) errs.push(`missing dockerignore`);
    errs.push(...checkDockerfileInvariants(plan));
  } catch (e) {
    errs.push(`threw: ${(e as Error).message}`);
  }
  results.push({ name: c.name, gen: errs.length ? "fail" : "pass", genMsg: errs.join("; ") });
}

// ---- Tier 2: docker build (optional) ----

/**
 * The docker tier pulls public base images anonymously. On macOS the default
 * `~/.docker/config.json` sets `credsStore: osxkeychain`, so Docker invokes the
 * keychain credential helper even for anonymous pulls — which fails in any
 * non-interactive session (CI, this harness) with "keychain cannot be accessed".
 * Point DOCKER_CONFIG at a credsStore-free config so public pulls go anonymous.
 * Respects an explicitly-set DOCKER_CONFIG (e.g. for private registries).
 */
function ensureAnonymousDockerConfig(): void {
  if (process.env.DOCKER_CONFIG) return;
  const dir = mkdtempSync(join(tmpdir(), "stacktest-dockercfg-"));
  writeFileSync(join(dir, "config.json"), "{}");
  process.env.DOCKER_CONFIG = dir;
}

function dockerBuild(c: Case): { ok: boolean; msg: string } {
  const dir = mkdtempSync(join(tmpdir(), `stacktest-${c.name}-`));
  try {
    const plan = detectStackPlan(c.files);
    for (const f of c.files) {
      const p = join(dir, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.content);
    }
    writeFileSync(join(dir, "Dockerfile"), plan.dockerfile);
    try {
      execFileSync("docker", ["build", "-q", "-t", `stacktest-${c.name}`, dir], { stdio: "pipe" });
      return { ok: true, msg: "" };
    } catch (e) {
      const out = ((e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message).trim();
      return { ok: false, msg: out.split("\n").slice(-3).join(" | ").slice(0, 240) };
    }
  } finally {
    try { execFileSync("docker", ["rmi", "-f", `stacktest-${c.name}`], { stdio: "ignore" }); } catch {}
    try { execFileSync("docker", ["image", "prune", "-f"], { stdio: "ignore" }); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

if (dockerMode !== "off") {
  ensureAnonymousDockerConfig();
  for (const c of selected) {
    const res = results.find((x) => x.name === c.name)!;
    if (dockerMode === "subset" && !c.docker) { res.build = "skip"; continue; }
    if (res.gen === "fail") { res.build = "skip"; continue; } // don't build a mis-generated app
    process.stdout.write(`  building ${c.name} ... `);
    const { ok, msg } = dockerBuild(c);
    res.build = ok ? "pass" : "fail";
    res.buildMsg = msg;
    console.log(ok ? "ok" : "FAILED");
  }
}

// ---- Report ----
console.log("\n" + "=".repeat(72));
console.log(`Stack harness — ${selected.length} fixtures` + (dockerMode !== "off" ? `  (docker: ${dockerMode})` : "  (structural only)"));
console.log("=".repeat(72));
let genFail = 0, buildFail = 0;
for (const res of results) {
  const g = res.gen === "pass" ? "✓" : "✗";
  let line = `  ${g} ${res.name.padEnd(18)} gen`;
  if (res.build) line += `  build:${res.build === "pass" ? "✓" : res.build === "skip" ? "–" : "✗"}`;
  console.log(line);
  if (res.gen === "fail") { genFail++; console.log(`      gen: ${res.genMsg}`); }
  if (res.build === "fail") { buildFail++; console.log(`      build: ${res.buildMsg}`); }
}
console.log("-".repeat(72));
const builtCount = results.filter((x) => x.build === "pass" || x.build === "fail").length;
console.log(`generation: ${results.length - genFail}/${results.length} passed` +
  (dockerMode !== "off" ? `   |   docker build: ${builtCount - buildFail}/${builtCount} passed` : ""));

process.exit(genFail + buildFail > 0 ? 1 : 0);
