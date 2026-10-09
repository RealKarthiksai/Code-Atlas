/**
 * lib/ast-counts.ts
 *
 * AST pass to count function call frequencies and React hook usages across
 * a TypeScript/JavaScript codebase.
 */

import ts from "typescript";

export * from "./ast-intel";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FunctionCallCount = {
  name: string;
  count: number;
  files: string[]; // unique files where this function is called
};

export type HookCallCount = FunctionCallCount; // same shape, filtered to hooks

export type FunctionCountResult = {
  allFunctions: FunctionCallCount[];
  hooks: HookCallCount[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getScriptKind(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".ts")) return ts.ScriptKind.TS;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/**
 * Returns true if a function name follows the React hook naming convention (useXxx).
 */
export function isHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name);
}

/**
 * Extracts function callee name from a CallExpression node, supporting both
 * direct identifiers (e.g. `parseArgs()`) and property access calls (e.g. `console.log()`).
 */
function extractCalleeName(node: ts.CallExpression): string | null {
  const expr = node.expression;

  if (ts.isIdentifier(expr)) {
    return expr.text;
  }

  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return expr.name.text;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main Analysis Pass
// ---------------------------------------------------------------------------

/**
 * Analyzes an array of source files to count call occurrences per function name.
 * Returns sorted call counts for all functions and specifically for React hooks.
 */
export function countFunctionCalls(files: { path: string; content: string }[]): {
  allFunctions: FunctionCallCount[];
  hooks: HookCallCount[];
} {
  const countsMap = new Map<string, { count: number; filesSet: Set<string> }>();

  for (const file of files) {
    if (!file.content || !file.path) continue;

    try {
      const sourceFile = ts.createSourceFile(
        file.path,
        file.content,
        ts.ScriptTarget.Latest,
        true,
        getScriptKind(file.path)
      );

      function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
          const calleeName = extractCalleeName(node);
          if (calleeName) {
            let entry = countsMap.get(calleeName);
            if (!entry) {
              entry = { count: 0, filesSet: new Set<string>() };
              countsMap.set(calleeName, entry);
            }
            entry.count += 1;
            entry.filesSet.add(file.path);
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    } catch {
      // Skips unparseable files cleanly
    }
  }

  const allFunctions: FunctionCallCount[] = [];
  const hooks: HookCallCount[] = [];

  for (const [name, data] of countsMap.entries()) {
    const item: FunctionCallCount = {
      name,
      count: data.count,
      files: Array.from(data.filesSet).sort(),
    };

    allFunctions.push(item);
    if (isHookName(name)) {
      hooks.push(item);
    }
  }

  // Sort descending by count, then alphabetically by name for ties
  const sortFn = (a: FunctionCallCount, b: FunctionCallCount) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return a.name.localeCompare(b.name);
  };

  allFunctions.sort(sortFn);
  hooks.sort(sortFn);

  return {
    allFunctions,
    hooks,
  };
}
