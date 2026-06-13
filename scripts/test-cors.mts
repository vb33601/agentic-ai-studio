/**
 * Tests for cross-stack CORS hardening (cors-harden.ts). Asserts each framework
 * gets its idiomatic CORS injected, that the dependency is added where needed,
 * and that apps which already configure CORS are left untouched.
 *
 *   npx tsx scripts/test-cors.mts
 */
import { hardenCors } from "../src/lib/deploy/cors-harden";
import type { StackPlan } from "../src/lib/deploy/dockerfile";

type F = { path: string; content: string };
const plan = (stack: string, framework: string): StackPlan => ({ stack, framework } as StackPlan);
let fails = 0;
const check = (n: string, c: boolean, d = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${c ? "" : "  <- " + d}`); if (!c) fails++; };
const file = (files: F[], re: RegExp) => files.find((f) => re.test(f.path))?.content ?? "";

// FastAPI
{
  const r = hardenCors(plan("python", "fastapi"), [{ path: "main.py", content: "from fastapi import FastAPI\napp = FastAPI()\n\n@app.get('/')\ndef h(): return {}\n" }]);
  const p = file(r.files, /main\.py/);
  console.log("fastapi:");
  check("imports CORSMiddleware", /from fastapi\.middleware\.cors import CORSMiddleware/.test(p), p);
  check("adds middleware reflect-origin + credentials", /add_middleware\(CORSMiddleware,.*allow_origin_regex=".\*".*allow_credentials=True/.test(p), p);
  check("idempotent (skips when already present)", hardenCors(plan("python", "fastapi"), r.files).notes.length === 0);
}

// Flask
{
  const r = hardenCors(plan("python", "flask"), [
    { path: "app.py", content: "from flask import Flask\napp = Flask(__name__)\n" },
    { path: "requirements.txt", content: "flask\n" },
  ]);
  console.log("flask:");
  check("adds CORS(app, supports_credentials=True)", /CORS\(app, supports_credentials=True\)/.test(file(r.files, /app\.py/)), file(r.files, /app\.py/));
  check("adds flask-cors to requirements", /flask-cors/.test(file(r.files, /requirements/)), file(r.files, /requirements/));
}

// Django
{
  const settings = "INSTALLED_APPS = [\n    'django.contrib.admin',\n]\nMIDDLEWARE = [\n    'django.middleware.security.SecurityMiddleware',\n]\n";
  const r = hardenCors(plan("python", "django"), [
    { path: "config/settings.py", content: settings },
    { path: "requirements.txt", content: "Django\n" },
  ]);
  const s = file(r.files, /settings\.py/);
  console.log("django:");
  check("adds corsheaders app", /"corsheaders"/.test(s), s);
  check("adds CorsMiddleware near top", s.indexOf("corsheaders.middleware.CorsMiddleware") < s.indexOf("SecurityMiddleware"), s);
  check("sets CORS_ALLOW_ALL_ORIGINS", /CORS_ALLOW_ALL_ORIGINS = True/.test(s), s);
  check("adds django-cors-headers dep", /django-cors-headers/.test(file(r.files, /requirements/)));
}

// Express
{
  const r = hardenCors(plan("node", "express"), [
    { path: "index.js", content: "const express = require('express');\nconst app = express();\napp.listen(3000);\n" },
    { path: "package.json", content: JSON.stringify({ dependencies: { express: "^4" } }) },
  ]);
  const idx = file(r.files, /index\.js/);
  console.log("express:");
  check("requires cors", /const cors = require\('cors'\)/.test(idx), idx);
  check("uses cors middleware", /app\.use\(cors\(\{ origin: true, credentials: true \}\)\)/.test(idx), idx);
  check("adds cors dependency", "cors" in JSON.parse(file(r.files, /package\.json/)).dependencies);
}

// Non-web / already-handled: no-op
{
  console.log("no-op:");
  check("go (no framework match) untouched", hardenCors(plan("go", "go"), [{ path: "main.go", content: "package main" }]).notes.length === 0);
}

console.log("-".repeat(60));
console.log(fails === 0 ? "ALL CORS TESTS PASSED" : `${fails} TEST(S) FAILED`);
process.exit(fails ? 1 : 0);
