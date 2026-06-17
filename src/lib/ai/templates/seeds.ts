/**
 * SEED templates — minimal but RUNNABLE starting points for every deploy-engine
 * stack that has no ubiquitous official scaffolder (the matrix "seed" tier). Each
 * is a complete, stack-detectable starter the agentic edit loop builds on, and is
 * certified by the local sandbox build/boot certifier before it ships.
 *
 * File sets are derived from the deploy engine's own known-good per-stack fixtures
 * (scripts/test-stacks.mts), so detectStackPlan recognises every one. Servered
 * stacks (fastapi/flask/go/deno) boot a real "hello" endpoint; compiled/exotic
 * stacks ship the minimal buildable project for their toolchain.
 */
import type { Template } from "./registry";

type Files = Record<string, string>;

interface SeedDef {
  label: string;
  stack: string;
  framework: string;
  port: number;
  /** Build command, or null for interpreted/no-build. */
  build: string | null;
  dev: string;
  install: string;
  files: Files;
}

// Keyed by framework slug when a stack has variants (fastapi/flask/sinatra), else
// by the stack name. The agentic loop turns these into the requested app.
const SEEDS: Record<string, SeedDef> = {
  fastapi: {
    label: "FastAPI", stack: "python", framework: "fastapi", port: 8000,
    build: null, dev: "uvicorn main:app --host 0.0.0.0 --port 8000", install: "pip install -r requirements.txt",
    files: {
      "requirements.txt": "fastapi\nuvicorn[standard]\n",
      "main.py": 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/")\ndef root():\n    return {"ok": True}\n\n\n@app.get("/api/health")\ndef health():\n    return {"status": "healthy"}\n',
    },
  },
  flask: {
    label: "Flask", stack: "python", framework: "flask", port: 8000,
    build: null, dev: "python app.py", install: "pip install -r requirements.txt",
    files: {
      "requirements.txt": "flask\ngunicorn\n",
      "app.py": 'import os\nfrom flask import Flask, jsonify\n\napp = Flask(__name__)\n\n\n@app.get("/")\ndef root():\n    return jsonify(ok=True)\n\n\n@app.get("/api/health")\ndef health():\n    return jsonify(status="healthy")\n\n\nif __name__ == "__main__":\n    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))\n',
    },
  },
  python: {
    label: "Python", stack: "python", framework: "python", port: 8000,
    build: null, dev: "python main.py", install: "pip install -r requirements.txt",
    files: { "requirements.txt": "requests\n", "main.py": 'print("ok")\n' },
  },
  go: {
    label: "Go (net/http)", stack: "go", framework: "go", port: 8080,
    build: "go build ./...", dev: "go run .", install: "go mod download",
    files: {
      "go.mod": "module app\n\ngo 1.22\n",
      "main.go": 'package main\n\nimport (\n\t"encoding/json"\n\t"net/http"\n\t"os"\n)\n\nfunc main() {\n\thttp.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {\n\t\tjson.NewEncoder(w).Encode(map[string]bool{"ok": true})\n\t})\n\tport := os.Getenv("PORT")\n\tif port == "" {\n\t\tport = "8080"\n\t}\n\thttp.ListenAndServe(":"+port, nil)\n}\n',
    },
  },
  deno: {
    label: "Deno", stack: "deno", framework: "deno", port: 8000,
    build: null, dev: "deno run --allow-net --allow-env main.ts", install: "",
    files: {
      "deno.json": '{\n  "tasks": { "dev": "deno run --allow-net --allow-env main.ts" }\n}\n',
      "main.ts": 'const port = Number(Deno.env.get("PORT") ?? 8000);\nDeno.serve({ port }, () => Response.json({ ok: true }));\n',
    },
  },
  rust: {
    label: "Rust (cargo)", stack: "rust", framework: "rust", port: 8080,
    build: "cargo build --release", dev: "cargo run", install: "cargo fetch",
    files: {
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      "src/main.rs": 'fn main() {\n    println!("ok");\n}\n',
    },
  },
  sinatra: {
    label: "Sinatra", stack: "ruby", framework: "sinatra", port: 4567,
    build: null, dev: "ruby app.rb", install: "bundle install",
    files: {
      "Gemfile": 'source "https://rubygems.org"\ngem "sinatra"\ngem "rackup"\ngem "puma"\n',
      "config.ru": 'require "./app"\nrun Sinatra::Application\n',
      "app.rb": 'require "sinatra"\nset :bind, "0.0.0.0"\n\nget "/" do\n  content_type :json\n  \'{"ok":true}\'\nend\n',
    },
  },
  ruby: {
    label: "Ruby", stack: "ruby", framework: "ruby", port: 0,
    build: null, dev: "ruby app.rb", install: "bundle install",
    files: { "Gemfile": 'source "https://rubygems.org"\n', "app.rb": 'puts "ok"\n' },
  },
  php: {
    label: "PHP", stack: "php", framework: "php", port: 8000,
    build: null, dev: "php -S 0.0.0.0:8000", install: "composer install",
    files: { "composer.json": '{ "require": {} }\n', "index.php": '<?php\nheader("Content-Type: application/json");\necho json_encode(["ok" => true]);\n' },
  },
  scala: {
    label: "Scala (sbt)", stack: "java", framework: "scala", port: 8080,
    build: "sbt compile", dev: "sbt run", install: "sbt update",
    files: {
      "build.sbt": 'name := "app"\nscalaVersion := "3.5.0"\n',
      "src/main/scala/Main.scala": '@main def run(): Unit = println("ok")\n',
    },
  },
  java: {
    label: "Java (Maven)", stack: "java", framework: "java", port: 8080,
    build: "mvn -q package -DskipTests", dev: "mvn exec:java", install: "mvn -q dependency:resolve",
    files: {
      "pom.xml": '<project>\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.app</groupId>\n  <artifactId>app</artifactId>\n  <version>0.1.0</version>\n  <properties><maven.compiler.release>17</maven.compiler.release></properties>\n</project>\n',
      "src/main/java/com/app/Main.java": 'package com.app;\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("ok");\n    }\n}\n',
    },
  },
  cpp: {
    label: "C++ (CMake)", stack: "cpp", framework: "cpp", port: 0,
    build: "cmake -B build && cmake --build build", dev: "./build/app", install: "",
    files: {
      "CMakeLists.txt": "cmake_minimum_required(VERSION 3.10)\nproject(app)\nset(CMAKE_CXX_STANDARD 17)\nadd_executable(app main.cpp)\n",
      "main.cpp": '#include <iostream>\n\nint main() {\n    std::cout << "ok" << std::endl;\n    return 0;\n}\n',
    },
  },
};

// Exotic-tail stacks: the minimal buildable project for each toolchain (derived
// from the deploy engine's fixtures). The local certifier validates them.
const EXOTIC: Record<string, { label: string; files: Files }> = {
  elixir: { label: "Elixir (Mix)", files: { "mix.exs": "defmodule App.MixProject do\n  use Mix.Project\n  def project, do: [app: :app, version: \"0.1.0\"]\nend\n", "lib/app.ex": 'defmodule App do\n  def hello, do: :ok\nend\n' } },
  erlang: { label: "Erlang (rebar3)", files: { "rebar.config": "{erl_opts, []}.\n{deps, []}.\n", "src/app.erl": '-module(app).\n-export([main/0]).\nmain() -> ok.\n' } },
  gleam: { label: "Gleam", files: { "gleam.toml": 'name = "app"\nversion = "1.0.0"\n', "src/app.gleam": 'import gleam/io\n\npub fn main() {\n  io.println("ok")\n}\n' } },
  zig: { label: "Zig", files: { "build.zig": "const std = @import(\"std\");\npub fn build(b: *std.Build) void { _ = b; }\n", "src/main.zig": 'const std = @import("std");\npub fn main() void {\n    std.debug.print("ok\\n", .{});\n}\n' } },
  nim: { label: "Nim", files: { "app.nimble": 'version = "0.1.0"\nbin = @["app"]\n', "src/app.nim": 'echo "ok"\n' } },
  crystal: { label: "Crystal", files: { "shard.yml": "name: app\nversion: 0.1.0\n", "src/app.cr": 'puts "ok"\n' } },
  d: { label: "D (dub)", files: { "dub.json": '{ "name": "app" }\n', "source/app.d": 'import std.stdio;\nvoid main() { writeln("ok"); }\n' } },
  vlang: { label: "V", files: { "v.mod": "Module { name: 'app' }\n", "main.v": 'fn main() {\n\tprintln("ok")\n}\n' } },
  ada: { label: "Ada (Alire)", files: { "alire.toml": 'name = "app"\nversion = "0.1.0"\n', "src/app.adb": 'with Ada.Text_IO;\nprocedure App is\nbegin\n   Ada.Text_IO.Put_Line ("ok");\nend App;\n' } },
  pascal: { label: "Pascal", files: { "main.pas": "program App;\nbegin\n  writeln('ok');\nend.\n" } },
  haskell: { label: "Haskell (Stack)", files: { "package.yaml": "name: app\nversion: 0.1.0\nexecutables:\n  app:\n    main: Main.hs\n    source-dirs: src\n", "src/Main.hs": 'main :: IO ()\nmain = putStrLn "ok"\n' } },
  ocaml: { label: "OCaml (Dune)", files: { "dune-project": "(lang dune 3.0)\n", "bin/dune": "(executable (name main))\n", "bin/main.ml": 'let () = print_endline "ok"\n' } },
  clojure: { label: "Clojure (deps)", files: { "deps.edn": "{:deps {}}\n", "src/app.clj": '(ns app)\n(defn -main [] (println "ok"))\n' } },
  racket: { label: "Racket", files: { "info.rkt": '#lang info\n(define collection "app")\n', "main.rkt": '#lang racket\n(displayln "ok")\n' } },
  lisp: { label: "Common Lisp", files: { "app.asd": '(defsystem "app" :components ((:file "main")))\n', "main.lisp": '(format t "ok~%")\n' } },
  lua: { label: "Lua", files: { "app.lua": 'print("ok")\n' } },
  perl: { label: "Perl", files: { "cpanfile": "requires 'Mojolicious';\n", "app.pl": 'print "ok\\n";\n' } },
  raku: { label: "Raku", files: { "META6.json": '{ "name": "App", "version": "0.1.0" }\n', "app.raku": 'say "ok";\n' } },
  tcl: { label: "Tcl", files: { "app.tcl": 'puts "ok"\n' } },
  powershell: { label: "PowerShell", files: { "app.ps1": 'Write-Output "ok"\n' } },
  r: { label: "R (Plumber)", files: { "plumber.R": '#* @get /\nfunction() {\n  list(ok = TRUE)\n}\n', "main.R": 'library(plumber)\npr("plumber.R") %>% pr_run(host = "0.0.0.0", port = as.integer(Sys.getenv("PORT", 8000)))\n' } },
  ballerina: { label: "Ballerina", files: { "Ballerina.toml": '[package]\norg = "app"\nname = "app"\nversion = "0.1.0"\n', "main.bal": 'import ballerina/io;\n\npublic function main() {\n    io:println("ok");\n}\n' } },
  prolog: { label: "Prolog", files: { "main.pl": ':- initialization(main).\nmain :- write(ok), nl.\n' } },
  hack: { label: "Hack (HHVM)", files: { ".hhconfig": "\n", "main.hack": '<<__EntryPoint>>\nfunction main(): void {\n  echo "ok\\n";\n}\n' } },
  haxe: { label: "Haxe", files: { "build.hxml": "-main Main\n--interp\n", "Main.hx": 'class Main {\n  static function main() {\n    trace("ok");\n  }\n}\n' } },
};

function toTemplate(key: string, def: SeedDef): Template {
  return {
    key: key as Template["key"],
    label: def.label,
    stack: def.stack,
    framework: def.framework,
    description: `${def.label} starter (seed) — minimal runnable ${def.framework} project. Build the requested app on top.`,
    runtime: { install: def.install, build: def.build, dev: def.dev, port: def.port },
    files: def.files,
  };
}

/** All seed keys with authored content (the rest fall back to a generic seed). */
export function hasSeed(key: string): boolean {
  return key in SEEDS || key in EXOTIC;
}

/**
 * Return a runnable seed Template for a stack/framework. Prefers a framework-
 * specific seed (fastapi/flask/sinatra), then the stack, then the exotic tail,
 * then a generic single-file fallback so EVERY stack resolves to something.
 */
export function getSeed(stack: string, framework?: string): Template {
  const key = framework && (framework in SEEDS || framework in EXOTIC) ? framework : stack;
  if (key in SEEDS) return toTemplate(key, SEEDS[key]);
  if (key in EXOTIC) {
    const e = EXOTIC[key];
    return {
      key: key as Template["key"], label: e.label, stack, framework: framework || stack,
      description: `${e.label} starter (seed). Build the requested app on top.`,
      runtime: { install: "", build: null, dev: "", port: 0 },
      files: e.files,
    };
  }
  // Generic fallback — a README so the tree is never empty; the loop adds the rest.
  return {
    key: "static" as Template["key"], label: `${stack} starter`, stack, framework: framework || stack,
    description: `Minimal ${stack} starter. Build the requested app.`,
    runtime: { install: "", build: null, dev: "", port: 0 },
    files: { "README.md": `# ${stack} app\n\nStarter project. Build the requested app here.\n` },
  };
}

export const SEED_KEYS = [...Object.keys(SEEDS), ...Object.keys(EXOTIC)];
