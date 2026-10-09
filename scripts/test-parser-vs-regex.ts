/**
 * scripts/test-parser-vs-regex.ts
 *
 * Automated regression & comparison suite comparing legacy regex extractors
 * against genuine Tree-Sitter AST parsers for Python, Go, and Rust.
 *
 * Verifies:
 * 1. False positive elimination (strings containing "def ", "func ", "fn ")
 * 2. Multi-line signature support
 * 3. Nested function & receiver method extraction
 * 4. Grouped, relative, and aliased imports
 * 5. Full entity hierarchy (classes, structs, traits, impls, interfaces)
 * 6. Call graph extraction
 * 7. Fault-tolerance on malformed/broken syntax
 */

import fs from "fs";
import path from "path";
import {
  initTreeSitterParsers,
  pythonPlugin,
  goPlugin,
  rustPlugin,
  extractPythonImportsRegex,
  extractPythonFunctionsRegex,
  extractGoImportsRegex,
  extractGoFunctionsRegex,
  extractRustImportsRegex,
  extractRustFunctionsRegex,
} from "../lib/language-plugins";

async function main() {
  console.log("================================================================================");
  console.log("   POLYGLOT AST PARSER VS REGEX COMPARISON TEST SUITE");
  console.log("================================================================================\n");

  const initialized = await initTreeSitterParsers();
  if (!initialized) {
    console.error("FATAL: Failed to initialize Tree-Sitter parsers via WASM.");
    process.exit(1);
  }
  console.log("✓ Tree-Sitter WASM parsers successfully initialized (Python, Go, Rust)\n");

  const fixturesDir = path.resolve(process.cwd(), "test-fixtures");

  let totalTestsPassed = 0;
  let totalTestsFailed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`);
      totalTestsPassed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      totalTestsFailed++;
    }
  }

  // ===========================================================================
  // 1. PYTHON COMPARISON
  // ===========================================================================
  console.log("--------------------------------------------------------------------------------");
  console.log(" 1. PYTHON (test-fixtures/python-sample.py)");
  console.log("--------------------------------------------------------------------------------");
  const pyContent = fs.readFileSync(path.join(fixturesDir, "python-sample.py"), "utf8");
  const pyFile = { path: "python-sample.py", content: pyContent };

  const pyRegexFuncs = extractPythonFunctionsRegex(pyContent);
  const pyAstFuncs = pythonPlugin.extractFunctions!(pyFile);
  const pyRegexImports = extractPythonImportsRegex(pyContent);
  const pyAstImports = pythonPlugin.extractImports!(pyFile);
  const pyAstEntities = pythonPlugin.extractEntities!(pyFile);
  const pyAstCalls = pythonPlugin.extractCalls!(pyFile);

  console.log("\n[Functions]");
  console.log(`  Regex extracted (${pyRegexFuncs.length}):`, pyRegexFuncs.map((f) => f.name));
  console.log(`  AST extracted   (${pyAstFuncs.length}):`, pyAstFuncs.map((f) => f.name));

  // Regex falsely matched functions inside string literals
  const pyFalsePositives = pyRegexFuncs.filter(
    (rf) => rf.name === "fake_func_in_string" || rf.name === "not_a_real_function" || rf.name === "ignored"
  );
  console.log(`  Regex FALSE POSITIVES in string literals:`, pyFalsePositives.map((f) => f.name));
  assert(
    pyFalsePositives.length > 0 && !pyAstFuncs.some((f) => f.name === "fake_func_in_string" || f.name === "not_a_real_function"),
    "Tree-Sitter AST rejects string literals that tricked regex ('fake_func_in_string', 'not_a_real_function')"
  );

  // AST extracts nested function
  assert(
    pyAstFuncs.some((f) => f.name === "inner_calculator"),
    "Tree-Sitter AST captures nested inner function 'inner_calculator'"
  );

  // AST extracts multi-line decorated function
  assert(
    pyAstFuncs.some((f) => f.name === "calculate_metrics" && (f.lineEnd ?? 0) > f.lineStart),
    "Tree-Sitter AST captures decorated multi-line signature 'calculate_metrics' with full line ranges"
  );

  console.log("\n[Imports]");
  console.log(`  Regex imports (${pyRegexImports.length}):`, pyRegexImports);
  console.log(`  AST imports   (${pyAstImports.length}):`, pyAstImports);
  assert(
    pyAstImports.includes(".utils") && pyAstImports.includes("..core.base") && pyAstImports.includes("numpy"),
    "Tree-Sitter AST captures relative and dotted imports (.utils, ..core.base, numpy)"
  );

  console.log("\n[Entities & Hierarchy]");
  console.log(`  AST entities (${pyAstEntities.length}):`, pyAstEntities.map((e) => `${e.type}:${e.parentEntityName ? e.parentEntityName + "." : ""}${e.name}`));
  const dataPipelineClass = pyAstEntities.find((e) => e.name === "DataPipeline" && e.type === "class");
  assert(
    Boolean(dataPipelineClass && dataPipelineClass.extendsNames?.includes("BaseService")),
    "Tree-Sitter AST extracts class 'DataPipeline' with extends 'BaseService'"
  );
  const classMethods = pyAstEntities.filter((e) => e.parentEntityName === "DataPipeline");
  assert(
    classMethods.length >= 3 && classMethods.some((m) => m.name === "__init__") && classMethods.some((m) => m.name === "execute_task"),
    "Tree-Sitter AST links class methods to parentEntityName 'DataPipeline'"
  );

  console.log("\n[Call Expressions]");
  console.log(`  AST calls (${pyAstCalls.length}):`, pyAstCalls.map((c) => `${c.callerFunction || "top"} -> ${c.calleeName}() @ L${c.line}`));
  assert(
    pyAstCalls.some((c) => c.callerFunction === "execute_task" && c.calleeName === "calculate_metrics"),
    "Tree-Sitter AST captures call site: execute_task -> calculate_metrics()"
  );

  // ===========================================================================
  // 2. GO COMPARISON
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log(" 2. GO (test-fixtures/go-sample.go)");
  console.log("--------------------------------------------------------------------------------");
  const goContent = fs.readFileSync(path.join(fixturesDir, "go-sample.go"), "utf8");
  const goFile = { path: "go-sample.go", content: goContent };

  const goRegexFuncs = extractGoFunctionsRegex(goContent);
  const goAstFuncs = goPlugin.extractFunctions!(goFile);
  const goRegexImports = extractGoImportsRegex(goContent);
  const goAstImports = goPlugin.extractImports!(goFile);
  const goAstEntities = goPlugin.extractEntities!(goFile);
  const goAstCalls = goPlugin.extractCalls!(goFile);

  console.log("\n[Functions]");
  console.log(`  Regex extracted (${goRegexFuncs.length}):`, goRegexFuncs.map((f) => f.name));
  console.log(`  AST extracted   (${goAstFuncs.length}):`, goAstFuncs.map((f) => f.name));

  // Regex falsely matched "func FakeFunctionInString() string {"
  const goFalsePositives = goRegexFuncs.filter((rf) => rf.name === "FakeFunctionInString");
  console.log(`  Regex FALSE POSITIVES in string literals:`, goFalsePositives.map((f) => f.name));
  assert(
    goFalsePositives.length > 0 && !goAstFuncs.some((f) => f.name === "FakeFunctionInString"),
    "Tree-Sitter AST rejects string literals that tricked regex ('FakeFunctionInString')"
  );

  // Multi-line receiver method
  assert(
    goAstFuncs.some((f) => f.name === "Start" && f.isExport),
    "Tree-Sitter AST extracts multi-line receiver method 'Start' with isExport: true"
  );

  console.log("\n[Imports]");
  console.log(`  Regex imports (${goRegexImports.length}):`, goRegexImports);
  console.log(`  AST imports   (${goAstImports.length}):`, goAstImports);
  assert(
    goAstImports.includes("context") && goAstImports.includes("strings") && goAstImports.includes("time"),
    "Tree-Sitter AST extracts all Go single and grouped imports (context, strings, time)"
  );

  console.log("\n[Entities & Hierarchy]");
  console.log(`  AST entities (${goAstEntities.length}):`, goAstEntities.map((e) => `${e.type}:${e.parentEntityName ? e.parentEntityName + "." : ""}${e.name}`));
  const workerPoolInterface = goAstEntities.find((e) => e.name === "WorkerPool" && e.type === "interface");
  const pipelineStruct = goAstEntities.find((e) => e.name === "PipelineService" && e.type === "class");
  assert(
    Boolean(workerPoolInterface && pipelineStruct),
    "Tree-Sitter AST extracts Go interface 'WorkerPool' and struct 'PipelineService'"
  );
  const goMethods = goAstEntities.filter((e) => e.parentEntityName === "PipelineService");
  assert(
    goMethods.some((m) => m.name === "Start") && goMethods.some((m) => m.name === "helperMethod"),
    "Tree-Sitter AST resolves receiver type and links methods to parent 'PipelineService'"
  );

  console.log("\n[Call Expressions]");
  console.log(`  AST calls (${goAstCalls.length}):`, goAstCalls.map((c) => `${c.callerFunction || "top"} -> ${c.calleeName}() @ L${c.line}`));
  assert(
    goAstCalls.some((c) => c.callerFunction === "Start" && c.calleeName === "helperMethod"),
    "Tree-Sitter AST captures call site: Start -> helperMethod()"
  );

  // ===========================================================================
  // 3. RUST COMPARISON
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log(" 3. RUST (test-fixtures/rust-sample.rs)");
  console.log("--------------------------------------------------------------------------------");
  const rustContent = fs.readFileSync(path.join(fixturesDir, "rust-sample.rs"), "utf8");
  const rustFile = { path: "rust-sample.rs", content: rustContent };

  const rustRegexFuncs = extractRustFunctionsRegex(rustContent);
  const rustAstFuncs = rustPlugin.extractFunctions!(rustFile);
  const rustRegexImports = extractRustImportsRegex(rustContent);
  const rustAstImports = rustPlugin.extractImports!(rustFile);
  const rustAstEntities = rustPlugin.extractEntities!(rustFile);
  const rustAstCalls = rustPlugin.extractCalls!(rustFile);

  console.log("\n[Functions]");
  console.log(`  Regex extracted (${rustRegexFuncs.length}):`, rustRegexFuncs.map((f) => f.name));
  console.log(`  AST extracted   (${rustAstFuncs.length}):`, rustAstFuncs.map((f) => f.name));

  // Regex falsely matched "fn fake_rust_function()"
  const rustFalsePositives = rustRegexFuncs.filter((rf) => rf.name === "fake_rust_function");
  console.log(`  Regex FALSE POSITIVES in string literals:`, rustFalsePositives.map((f) => f.name));
  assert(
    rustFalsePositives.length > 0 && !rustAstFuncs.some((f) => f.name === "fake_rust_function"),
    "Tree-Sitter AST rejects string literals that tricked regex ('fake_rust_function')"
  );

  assert(
    rustAstFuncs.some((f) => f.name === "new" && f.isExport) && rustAstFuncs.some((f) => f.name === "spawn_worker"),
    "Tree-Sitter AST extracts methods inside impl blocks ('new') and standalone functions ('spawn_worker')"
  );

  console.log("\n[Imports]");
  console.log(`  Regex raw strings (${rustRegexImports.length}):`, rustRegexImports);
  console.log(`  AST resolved      (${rustAstImports.length}):`, rustAstImports);
  assert(
    rustAstImports.includes("std::sync::Arc") &&
      rustAstImports.includes("std::sync::Mutex") &&
      rustAstImports.includes("crate::engine::core::Runner") &&
      rustAstImports.includes("crate::engine::metrics"),
    "Tree-Sitter AST expands grouped/nested use trees (std::sync::{Arc, Mutex}, crate::engine::{core::{Runner, State}, metrics})"
  );

  console.log("\n[Entities & Hierarchy]");
  console.log(`  AST entities (${rustAstEntities.length}):`, rustAstEntities.map((e) => `${e.type}:${e.parentEntityName ? e.parentEntityName + "." : ""}${e.name}`));
  const dataWorkerStruct = rustAstEntities.find((e) => e.name === "DataWorker" && e.type === "class");
  const workerTrait = rustAstEntities.find((e) => e.name === "Worker" && e.type === "interface");
  assert(
    Boolean(dataWorkerStruct && workerTrait),
    "Tree-Sitter AST extracts struct 'DataWorker' and trait 'Worker'"
  );
  const traitMethod = rustAstEntities.find((e) => e.name === "execute" && e.implementsNames?.includes("Worker"));
  assert(
    Boolean(traitMethod && traitMethod.parentEntityName === "DataWorker"),
    "Tree-Sitter AST links 'impl Worker for DataWorker' method 'execute' with implementsNames: ['Worker']"
  );

  console.log("\n[Call Expressions]");
  console.log(`  AST calls (${rustAstCalls.length}):`, rustAstCalls.map((c) => `${c.callerFunction || "top"} -> ${c.calleeName}() @ L${c.line}`));
  assert(
    rustAstCalls.some((c) => c.callerFunction === "execute" && c.calleeName === "internal_step"),
    "Tree-Sitter AST captures call site: execute -> internal_step()"
  );

  // ===========================================================================
  // 4. FAULT TOLERANCE ON BROKEN SYNTAX
  // ===========================================================================
  console.log("\n--------------------------------------------------------------------------------");
  console.log(" 4. FAULT TOLERANCE ON BROKEN SYNTAX (must not crash)");
  console.log("--------------------------------------------------------------------------------");

  // Broken Python
  try {
    const pyBroken = fs.readFileSync(path.join(fixturesDir, "python-broken.py"), "utf8");
    const pyBrokenFile = { path: "python-broken.py", content: pyBroken };
    const funcs = pythonPlugin.extractFunctions!(pyBrokenFile);
    const entities = pythonPlugin.extractEntities!(pyBrokenFile);
    const imports = pythonPlugin.extractImports!(pyBrokenFile);
    const calls = pythonPlugin.extractCalls!(pyBrokenFile);
    assert(Array.isArray(funcs) && Array.isArray(entities) && Array.isArray(imports) && Array.isArray(calls), "Malformed Python parsed gracefully with 0 crashes");
  } catch (err) {
    assert(false, `Malformed Python threw an exception: ${err}`);
  }

  // Broken Go
  try {
    const goBroken = fs.readFileSync(path.join(fixturesDir, "go-broken.go"), "utf8");
    const goBrokenFile = { path: "go-broken.go", content: goBroken };
    const funcs = goPlugin.extractFunctions!(goBrokenFile);
    const entities = goPlugin.extractEntities!(goBrokenFile);
    const imports = goPlugin.extractImports!(goBrokenFile);
    const calls = goPlugin.extractCalls!(goBrokenFile);
    assert(Array.isArray(funcs) && Array.isArray(entities) && Array.isArray(imports) && Array.isArray(calls), "Malformed Go parsed gracefully with 0 crashes");
  } catch (err) {
    assert(false, `Malformed Go threw an exception: ${err}`);
  }

  // Broken Rust
  try {
    const rustBroken = fs.readFileSync(path.join(fixturesDir, "rust-broken.rs"), "utf8");
    const rustBrokenFile = { path: "rust-broken.rs", content: rustBroken };
    const funcs = rustPlugin.extractFunctions!(rustBrokenFile);
    const entities = rustPlugin.extractEntities!(rustBrokenFile);
    const imports = rustPlugin.extractImports!(rustBrokenFile);
    const calls = rustPlugin.extractCalls!(rustBrokenFile);
    assert(Array.isArray(funcs) && Array.isArray(entities) && Array.isArray(imports) && Array.isArray(calls), "Malformed Rust parsed gracefully with 0 crashes");
  } catch (err) {
    assert(false, `Malformed Rust threw an exception: ${err}`);
  }

  // ===========================================================================
  // SUMMARY
  // ===========================================================================
  console.log("\n================================================================================");
  console.log(`   TEST SUMMARY: ${totalTestsPassed} PASSED, ${totalTestsFailed} FAILED`);
  console.log("================================================================================\n");

  if (totalTestsFailed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error in test suite:", err);
  process.exit(1);
});
