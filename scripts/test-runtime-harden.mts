/**
 * Tests for the cross-stack runtime-readiness reconciler (runtime-harden.ts).
 *
 * Safety-critical: a wrong addition (a stdlib module, a local module, a path
 * alias) would break the build it's meant to protect. Each case asserts both
 * what MUST be added and what must NEVER be added.
 *
 *   npx tsx scripts/test-runtime-harden.mts
 */
import { hardenRuntime } from "../src/lib/deploy/runtime-harden";
import type { StackPlan } from "../src/lib/deploy/dockerfile";

type F = { path: string; content: string };
const plan = (stack: string): StackPlan => ({ stack, framework: stack } as StackPlan);
let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : "  <- " + detail}`);
  if (!cond) fails++;
}
const manifest = (files: F[], path: string) => files.find((f) => f.path === path)?.content ?? "";

// --- Python: add third-party imports, never stdlib/local/declared ---
{
  const files: F[] = [
    { path: "requirements.txt", content: "flask\n" },
    { path: "app.py", content: "import os\nimport json\nfrom flask import Flask\nimport jwt\nimport requests\nfrom .helpers import x\nimport models\n" },
    { path: "models.py", content: "# local module\n" },
  ];
  const r = hardenRuntime(plan("python"), files, "");
  const req = manifest(r.files, "requirements.txt");
  console.log("Python:");
  check("adds PyJWT (jwt->PyJWT mapping)", /^PyJWT$/m.test(req), req);
  check("adds requests", /^requests$/m.test(req), req);
  check("keeps flask", /^flask$/m.test(req), req);
  check("does NOT add stdlib os/json", !/\bos\b/m.test(req) && !/^json$/m.test(req), req);
  check("does NOT add local 'models'", !/^models$/m.test(req), req);
  check("does NOT add relative .helpers", !/helpers/.test(req), req);
}

// --- Node: add bare imports, never builtins/alias/relative/declared ---
{
  const files: F[] = [
    { path: "package.json", content: JSON.stringify({ dependencies: { express: "^4" } }) },
    { path: "index.js", content: `import express from 'express';\nimport cors from 'cors';\nimport fs from 'fs';\nimport path from 'node:path';\nimport { db } from './db.js';\nimport thing from '@/lib/thing';\nconst x = require('helmet');\nimport _ from 'lodash/merge';\nimport { Client } from '@scope/sdk';\n` },
  ];
  const r = hardenRuntime(plan("node"), files, "");
  const pkg = JSON.parse(manifest(r.files, "package.json"));
  const deps = pkg.dependencies as Record<string, string>;
  console.log("Node:");
  check("adds cors", "cors" in deps, JSON.stringify(deps));
  check("adds helmet (require)", "helmet" in deps, JSON.stringify(deps));
  check("adds lodash (strips subpath)", "lodash" in deps, JSON.stringify(deps));
  check("adds scoped @scope/sdk", "@scope/sdk" in deps, JSON.stringify(deps));
  check("keeps express", "express" in deps, JSON.stringify(deps));
  check("does NOT add builtin fs / node:path", !("fs" in deps) && !("path" in deps) && !("node:path" in deps), JSON.stringify(deps));
  check("does NOT add relative ./db.js", !("./db.js" in deps), JSON.stringify(deps));
  check("does NOT add path alias @/lib/thing", !Object.keys(deps).some((d) => d.startsWith("@/")), JSON.stringify(deps));
}

// --- Ruby: add gems, never stdlib ---
{
  const files: F[] = [
    { path: "Gemfile", content: 'source "https://rubygems.org"\n' },
    { path: "app.rb", content: 'require "sinatra"\nrequire "json"\nrequire "jwt"\n' },
  ];
  const r = hardenRuntime(plan("ruby"), files, "");
  const gem = manifest(r.files, "Gemfile");
  console.log("Ruby:");
  check("adds sinatra", /gem "sinatra"/.test(gem), gem);
  check("adds jwt", /gem "jwt"/.test(gem), gem);
  check("does NOT add stdlib json", !/gem "json"/.test(gem), gem);
}

// --- Go: inject go mod tidy ---
{
  const df = "FROM golang:1.22-alpine AS build\nWORKDIR /src\nCOPY go.* ./\nRUN go mod download 2>/dev/null || true\nCOPY . .\nRUN go build -o /app/server .\n";
  const r = hardenRuntime(plan("go"), [], df);
  console.log("Go:");
  check("injects go mod tidy before build", /go mod tidy/.test(r.dockerfile), r.dockerfile);
}

// --- DB-less / unsupported stack: clean no-op ---
{
  const files: F[] = [{ path: "index.html", content: "<h1>ok</h1>" }];
  const r = hardenRuntime(plan("static"), files, "FROM nginx");
  console.log("Static:");
  check("no-op (no files changed, no notes)", r.files === files && r.notes.length === 0);
}

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL RUNTIME-HARDEN TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
