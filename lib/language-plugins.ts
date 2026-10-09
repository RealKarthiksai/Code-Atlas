/**
 * lib/language-plugins.ts
 *
 * Language plugin abstraction and registry for Codebase Atlas.
 * Provides extensible interfaces for file filtering, import extraction,
 * function definition extraction, call graph extraction, and repository language detection.
 *
 * Supported Language Plugins:
 *  - TypeScript / JavaScript (.ts, .tsx, .js, .jsx, .mjs, .cjs)
 *  - Python (.py)
 *  - Go (.go)
 *  - Rust (.rs)
 */

import ts from "typescript";
import {
  initTreeSitterParsers,
  isTreeSitterReady,
  extractPythonImportsAST,
  extractPythonFunctionsAST,
  extractPythonEntitiesAST,
  extractPythonCallsAST,
  extractGoImportsAST,
  extractGoFunctionsAST,
  extractGoEntitiesAST,
  extractGoCallsAST,
  extractRustImportsAST,
  extractRustFunctionsAST,
  extractRustEntitiesAST,
  extractRustCallsAST,
} from "./treesitter-parser";

export { initTreeSitterParsers, isTreeSitterReady };

// ---------------------------------------------------------------------------
// Plugin Abstraction Types
// ---------------------------------------------------------------------------

export type FunctionInfo = {
  name: string;
  lineStart: number;
  lineEnd?: number;
  isExport?: boolean;
};

export type CallInfo = {
  callerFunction?: string;
  calleeName: string;
  line: number;
};

export type EntityType =
  | "class"
  | "interface"
  | "function"
  | "method"
  | "variable"
  | "constant"
  | "component";

export type EntityInfo = {
  type: EntityType;
  name: string;
  lineStart: number;
  lineEnd: number;
  isExport?: boolean;
  parentEntityName?: string;
  extendsNames?: string[];
  implementsNames?: string[];
  calls?: { calleeName: string; line: number }[];
  creates?: { targetName: string; line: number }[];
  returns?: { targetName: string; line: number }[];
};

export type LanguagePlugin = {
  name: string; // e.g. "typescript", "python", "go", "rust"
  fileFilter: (path: string) => boolean;
  extractImports?: (file: { path: string; content: string }) => string[];
  extractFunctions?: (file: { path: string; content: string }) => FunctionInfo[];
  extractCalls?: (file: { path: string; content: string }) => CallInfo[];
  extractEntities?: (file: { path: string; content: string }) => EntityInfo[];
};

export type RepoLanguageHint = {
  language: string;
  confidence: "high" | "medium" | "low";
  reason: string;
};

// ---------------------------------------------------------------------------
// 1. TypeScript / JavaScript Language Plugin
// ---------------------------------------------------------------------------

function getScriptKind(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

function hasExportModifier(node: ts.Node): boolean {
  if (ts.canHaveModifiers(node)) {
    const modifiers = ts.getModifiers(node);
    if (modifiers) {
      return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    }
  }
  return false;
}

function extractCalleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    return expression.name.text;
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    if (ts.isStringLiteral(expression.argumentExpression)) {
      return expression.argumentExpression.text;
    }
  }
  return null;
}

export const typescriptPlugin: LanguagePlugin = {
  name: "typescript",
  fileFilter: (path: string) => {
    const lower = path.toLowerCase();
    return (
      (lower.endsWith(".ts") ||
        lower.endsWith(".tsx") ||
        lower.endsWith(".js") ||
        lower.endsWith(".jsx") ||
        lower.endsWith(".mjs") ||
        lower.endsWith(".cjs")) &&
      !lower.endsWith(".d.ts")
    );
  },

  extractImports: (file: { path: string; content: string }): string[] => {
    try {
      const sourceFile = ts.createSourceFile(
        file.path,
        file.content,
        ts.ScriptTarget.Latest,
        true,
        getScriptKind(file.path)
      );

      const imports: string[] = [];

      function visit(node: ts.Node) {
        if (ts.isImportDeclaration(node)) {
          if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            imports.push(node.moduleSpecifier.text);
          }
        } else if (ts.isExportDeclaration(node)) {
          if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            imports.push(node.moduleSpecifier.text);
          }
        } else if (ts.isCallExpression(node)) {
          if (
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
            node.arguments.length > 0 &&
            ts.isStringLiteral(node.arguments[0])
          ) {
            imports.push(node.arguments[0].text);
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
      return Array.from(new Set(imports));
    } catch {
      return [];
    }
  },

  extractFunctions: (file: { path: string; content: string }): FunctionInfo[] => {
    try {
      const sourceFile = ts.createSourceFile(
        file.path,
        file.content,
        ts.ScriptTarget.Latest,
        true,
        getScriptKind(file.path)
      );

      const functions: FunctionInfo[] = [];

      function visit(node: ts.Node) {
        const isExport = hasExportModifier(node);

        if (ts.isFunctionDeclaration(node) && node.name) {
          const { line: lineStart } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const { line: lineEnd } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
          functions.push({
            name: node.name.text,
            lineStart: lineStart + 1,
            lineEnd: lineEnd + 1,
            isExport,
          });
        } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
          const { line: lineStart } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const { line: lineEnd } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
          functions.push({
            name: node.name.text,
            lineStart: lineStart + 1,
            lineEnd: lineEnd + 1,
            isExport,
          });
        } else if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (
              ts.isIdentifier(decl.name) &&
              decl.initializer &&
              (ts.isArrowFunction(decl.initializer) ||
                ts.isFunctionExpression(decl.initializer))
            ) {
              const { line: lineStart } = sourceFile.getLineAndCharacterOfPosition(decl.getStart());
              const { line: lineEnd } = sourceFile.getLineAndCharacterOfPosition(decl.getEnd());
              functions.push({
                name: decl.name.text,
                lineStart: lineStart + 1,
                lineEnd: lineEnd + 1,
                isExport,
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
      return functions;
    } catch {
      return [];
    }
  },

  extractCalls: (file: { path: string; content: string }): CallInfo[] => {
    try {
      const sourceFile = ts.createSourceFile(
        file.path,
        file.content,
        ts.ScriptTarget.Latest,
        true,
        getScriptKind(file.path)
      );

      const calls: CallInfo[] = [];

      function visit(node: ts.Node, currentFunction?: string) {
        let activeFunction = currentFunction;

        if (ts.isFunctionDeclaration(node) && node.name) {
          activeFunction = node.name.text;
        } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
          activeFunction = node.name.text;
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          if (
            node.initializer &&
            (ts.isArrowFunction(node.initializer) ||
              ts.isFunctionExpression(node.initializer))
          ) {
            activeFunction = node.name.text;
          }
        }

        if (ts.isCallExpression(node)) {
          const calleeName = extractCalleeName(node.expression);
          if (calleeName) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
            calls.push({
              callerFunction: activeFunction,
              calleeName,
              line: line + 1,
            });
          }
        }

        ts.forEachChild(node, (child) => visit(child, activeFunction));
      }

      visit(sourceFile);
      return calls;
    } catch {
      return [];
    }
  },

  extractEntities: (file: { path: string; content: string }): EntityInfo[] => {
    try {
      const sourceFile = ts.createSourceFile(
        file.path,
        file.content,
        ts.ScriptTarget.Latest,
        true,
        getScriptKind(file.path)
      );

      const entities: EntityInfo[] = [];
      const isReactFile = file.path.endsWith(".tsx") || file.path.endsWith(".jsx");

      function extractHeritage(node: ts.ClassDeclaration | ts.InterfaceDeclaration) {
        const extendsNames: string[] = [];
        const implementsNames: string[] = [];
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            const isImplements = clause.token === ts.SyntaxKind.ImplementsKeyword;
            for (const typeNode of clause.types) {
              let name: string | null = null;
              if (ts.isIdentifier(typeNode.expression)) {
                name = typeNode.expression.text;
              } else if (
                ts.isPropertyAccessExpression(typeNode.expression) &&
                ts.isIdentifier(typeNode.expression.name)
              ) {
                name = typeNode.expression.name.text;
              }
              if (name) {
                if (isImplements) {
                  implementsNames.push(name);
                } else {
                  extendsNames.push(name);
                }
              }
            }
          }
        }
        return { extendsNames, implementsNames };
      }

      function inspectBody(bodyNode: ts.Node): {
        calls: { calleeName: string; line: number }[];
        creates: { targetName: string; line: number }[];
        returns: { targetName: string; line: number }[];
      } {
        const calls: { calleeName: string; line: number }[] = [];
        const creates: { targetName: string; line: number }[] = [];
        const returns: { targetName: string; line: number }[] = [];

        function walkBody(node: ts.Node) {
          if (ts.isCallExpression(node)) {
            const calleeName = extractCalleeName(node.expression);
            if (calleeName) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              calls.push({ calleeName, line: line + 1 });
            }
          } else if (ts.isNewExpression(node)) {
            let targetName: string | null = null;
            if (ts.isIdentifier(node.expression)) {
              targetName = node.expression.text;
            } else if (
              ts.isPropertyAccessExpression(node.expression) &&
              ts.isIdentifier(node.expression.name)
            ) {
              targetName = node.expression.name.text;
            }
            if (targetName) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              creates.push({ targetName, line: line + 1 });
            }
          } else if (ts.isReturnStatement(node) && node.expression) {
            let targetName: string | null = null;
            if (ts.isIdentifier(node.expression)) {
              targetName = node.expression.text;
            } else if (
              ts.isPropertyAccessExpression(node.expression) &&
              ts.isIdentifier(node.expression.name)
            ) {
              targetName = node.expression.name.text;
            }
            if (targetName) {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              returns.push({ targetName, line: line + 1 });
            }
          }
          ts.forEachChild(node, walkBody);
        }

        walkBody(bodyNode);
        return { calls, creates, returns };
      }

      function visit(node: ts.Node, parentClassName?: string) {
        const isExport = hasExportModifier(node);

        if (ts.isClassDeclaration(node) && node.name) {
          const className = node.name.text;
          const { line: lineStart } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const { line: lineEnd } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
          const { extendsNames, implementsNames } = extractHeritage(node);

          entities.push({
            type: "class",
            name: className,
            lineStart: lineStart + 1,
            lineEnd: lineEnd + 1,
            isExport,
            extendsNames,
            implementsNames,
          });

          for (const member of node.members) {
            visit(member, className);
          }
          return;
        }

        if (ts.isInterfaceDeclaration(node) && node.name) {
          const interfaceName = node.name.text;
          const { line: lineStart } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const { line: lineEnd } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
          const { extendsNames } = extractHeritage(node);

          entities.push({
            type: "interface",
            name: interfaceName,
            lineStart: lineStart + 1,
            lineEnd: lineEnd + 1,
            isExport,
            extendsNames,
          });
          return;
        }

        if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
          const methodName = node.name.text;
          const { line: lineStart } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const { line: lineEnd } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
          const { calls, creates, returns } = node.body ? inspectBody(node.body) : { calls: [], creates: [], returns: [] };

          entities.push({
            type: "method",
            name: methodName,
            lineStart: lineStart + 1,
            lineEnd: lineEnd + 1,
            isExport,
            parentEntityName: parentClassName,
            calls,
            creates,
            returns,
          });
          return;
        }

        if (ts.isFunctionDeclaration(node) && node.name) {
          const fnName = node.name.text;
          const { line: lineStart } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const { line: lineEnd } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
          const isComponent = isReactFile && /^[A-Z]/.test(fnName);
          const { calls, creates, returns } = node.body ? inspectBody(node.body) : { calls: [], creates: [], returns: [] };

          entities.push({
            type: isComponent ? "component" : "function",
            name: fnName,
            lineStart: lineStart + 1,
            lineEnd: lineEnd + 1,
            isExport,
            calls,
            creates,
            returns,
          });
          return;
        }

        if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              const varName = decl.name.text;
              const { line: lineStart } = sourceFile.getLineAndCharacterOfPosition(decl.getStart());
              const { line: lineEnd } = sourceFile.getLineAndCharacterOfPosition(decl.getEnd());

              if (
                decl.initializer &&
                (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
              ) {
                const isComponent = isReactFile && /^[A-Z]/.test(varName);
                const { calls, creates, returns } = inspectBody(decl.initializer);
                entities.push({
                  type: isComponent ? "component" : "function",
                  name: varName,
                  lineStart: lineStart + 1,
                  lineEnd: lineEnd + 1,
                  isExport,
                  calls,
                  creates,
                  returns,
                });
              } else {
                const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
                entities.push({
                  type: isConst ? "constant" : "variable",
                  name: varName,
                  lineStart: lineStart + 1,
                  lineEnd: lineEnd + 1,
                  isExport,
                });
              }
            }
          }
          return;
        }

        ts.forEachChild(node, (child) => visit(child, parentClassName));
      }

      visit(sourceFile);
      return entities;
    } catch {
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// 2. Python Language Plugin (Tree-Sitter AST)
// ---------------------------------------------------------------------------

export const pythonPlugin: LanguagePlugin = {
  name: "python",
  fileFilter: (path: string) => {
    const lower = path.toLowerCase();
    return (
      lower.endsWith(".py") &&
      !lower.includes("__pycache__") &&
      !lower.includes(".venv") &&
      !lower.includes("/venv/") &&
      !lower.includes("/vendor/")
    );
  },

  extractImports: (file: { path: string; content: string }): string[] => {
    const astResult = extractPythonImportsAST(file.content);
    if (astResult !== null) return astResult;
    return extractPythonImportsRegex(file.content);
  },

  extractFunctions: (file: { path: string; content: string }): FunctionInfo[] => {
    const astResult = extractPythonFunctionsAST(file.content);
    if (astResult !== null) return astResult;
    return extractPythonFunctionsRegex(file.content);
  },

  extractEntities: (file: { path: string; content: string }): EntityInfo[] => {
    const astResult = extractPythonEntitiesAST(file.content);
    return astResult || [];
  },

  extractCalls: (file: { path: string; content: string }): CallInfo[] => {
    const astResult = extractPythonCallsAST(file.content);
    return astResult || [];
  },
};

/** Legacy regex extractor kept for testing & fallback */
export function extractPythonImportsRegex(content: string): string[] {
  const imports: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;

    // from foo.bar import baz
    const fromMatch = trimmed.match(/^from\s+([.\w]+)\s+import/);
    if (fromMatch) {
      imports.push(fromMatch[1]);
      continue;
    }

    // import foo, bar.baz
    const importMatch = trimmed.match(/^import\s+([\w.,\s]+)/);
    if (importMatch) {
      const pkgs = importMatch[1].split(",").map((p) => p.trim().split(" ")[0]);
      for (const pkg of pkgs) {
        if (pkg) imports.push(pkg);
      }
    }
  }

  return Array.from(new Set(imports));
}

/** Legacy regex extractor kept for testing & fallback */
export function extractPythonFunctionsRegex(content: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\s*(?:async\s+)?def\s+([a-zA-Z_]\w*)\s*\(/);
    if (match) {
      functions.push({
        name: match[1],
        lineStart: i + 1,
        isExport: true,
      });
    }
  }

  return functions;
}

// ---------------------------------------------------------------------------
// 3. Go Language Plugin (Tree-Sitter AST)
// ---------------------------------------------------------------------------

export const goPlugin: LanguagePlugin = {
  name: "go",
  fileFilter: (path: string) => {
    const lower = path.toLowerCase();
    return lower.endsWith(".go") && !lower.includes("/vendor/");
  },

  extractImports: (file: { path: string; content: string }): string[] => {
    const astResult = extractGoImportsAST(file.content);
    if (astResult !== null) return astResult;
    return extractGoImportsRegex(file.content);
  },

  extractFunctions: (file: { path: string; content: string }): FunctionInfo[] => {
    const astResult = extractGoFunctionsAST(file.content);
    if (astResult !== null) return astResult;
    return extractGoFunctionsRegex(file.content);
  },

  extractEntities: (file: { path: string; content: string }): EntityInfo[] => {
    const astResult = extractGoEntitiesAST(file.content);
    return astResult || [];
  },

  extractCalls: (file: { path: string; content: string }): CallInfo[] => {
    const astResult = extractGoCallsAST(file.content);
    return astResult || [];
  },
};

/** Legacy regex extractor kept for testing & fallback */
export function extractGoImportsRegex(content: string): string[] {
  const imports: string[] = [];

  // Single-line import "pkg"
  const singleMatches = content.matchAll(/import\s+"([^"]+)"/g);
  for (const m of singleMatches) {
    imports.push(m[1]);
  }

  // Multi-line import ( ... )
  const blockMatch = content.match(/import\s*\(([\s\S]*?)\)/);
  if (blockMatch) {
    const blockContent = blockMatch[1];
    const quotedMatches = blockContent.matchAll(/"([^"]+)"/g);
    for (const m of quotedMatches) {
      imports.push(m[1]);
    }
  }

  return Array.from(new Set(imports));
}

/** Legacy regex extractor kept for testing & fallback */
export function extractGoFunctionsRegex(content: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // func (r *Receiver) Foo(...) or func Foo(...)
    const match = line.match(/^func\s+(?:\([^)]+\)\s+)?([a-zA-Z_]\w*)\s*\(/);
    if (match) {
      const name = match[1];
      const isExport = /^[A-Z]/.test(name);
      functions.push({
        name,
        lineStart: i + 1,
        isExport,
      });
    }
  }

  return functions;
}

// ---------------------------------------------------------------------------
// 4. Rust Language Plugin (Tree-Sitter AST)
// ---------------------------------------------------------------------------

export const rustPlugin: LanguagePlugin = {
  name: "rust",
  fileFilter: (path: string) => {
    const lower = path.toLowerCase();
    return lower.endsWith(".rs") && !lower.includes("/target/");
  },

  extractImports: (file: { path: string; content: string }): string[] => {
    const astResult = extractRustImportsAST(file.content);
    if (astResult !== null) return astResult;
    return extractRustImportsRegex(file.content);
  },

  extractFunctions: (file: { path: string; content: string }): FunctionInfo[] => {
    const astResult = extractRustFunctionsAST(file.content);
    if (astResult !== null) return astResult;
    return extractRustFunctionsRegex(file.content);
  },

  extractEntities: (file: { path: string; content: string }): EntityInfo[] => {
    const astResult = extractRustEntitiesAST(file.content);
    return astResult || [];
  },

  extractCalls: (file: { path: string; content: string }): CallInfo[] => {
    const astResult = extractRustCallsAST(file.content);
    return astResult || [];
  },
};

/** Legacy regex extractor kept for testing & fallback */
export function extractRustImportsRegex(content: string): string[] {
  const imports: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^pub\s+use\s+([^;]+);|^use\s+([^;]+);/);
    if (match) {
      const rawPath = (match[1] || match[2]).trim();
      imports.push(rawPath);
    }
  }

  return Array.from(new Set(imports));
}

/** Legacy regex extractor kept for testing & fallback */
export function extractRustFunctionsRegex(content: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // pub fn foo(...) or pub(crate) async fn foo(...) or fn foo(...)
    const match = line.match(/^\s*(pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z_]\w*)/);
    if (match) {
      const isExport = Boolean(match[1]);
      const name = match[2];
      functions.push({
        name,
        lineStart: i + 1,
        isExport,
      });
    }
  }

  return functions;
}

// ---------------------------------------------------------------------------
// Language Plugin Registry
// ---------------------------------------------------------------------------

export const languagePlugins: LanguagePlugin[] = [
  typescriptPlugin,
  pythonPlugin,
  goPlugin,
  rustPlugin,
];

export function findLanguagePlugin(path: string): LanguagePlugin | null {
  for (const plugin of languagePlugins) {
    if (plugin.fileFilter(path)) {
      return plugin;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Language Detection Heuristics
// ---------------------------------------------------------------------------

export function detectRepoLanguages(files: string[]): RepoLanguageHint[] {
  const hints: RepoLanguageHint[] = [];

  const lowerFiles = files.map((f) => f.toLowerCase());
  const basenames = lowerFiles.map((f) => f.split("/").pop() || "");

  // TypeScript / JavaScript
  const hasTsConfig = basenames.includes("tsconfig.json");
  const hasPackageJson = basenames.includes("package.json");
  const tsJsFileCount = lowerFiles.filter((f) =>
    /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)
  ).length;

  if (hasTsConfig || hasPackageJson || tsJsFileCount > 0) {
    let confidence: "high" | "medium" | "low" = "low";
    let reason = `Found ${tsJsFileCount} TS/JS files.`;

    if (hasPackageJson && tsJsFileCount > 0) {
      confidence = "high";
      reason = `Found package.json and ${tsJsFileCount} TypeScript/JavaScript files.`;
    } else if (hasTsConfig || tsJsFileCount > 3) {
      confidence = "high";
      reason = `Found tsconfig.json and ${tsJsFileCount} TypeScript files.`;
    } else if (tsJsFileCount > 0) {
      confidence = "medium";
    }

    hints.push({
      language: "TypeScript/JavaScript",
      confidence,
      reason,
    });
  }

  // Python
  const hasPyProject = basenames.includes("pyproject.toml") || basenames.includes("requirements.txt") || basenames.includes("setup.py");
  const pyFileCount = lowerFiles.filter((f) => f.endsWith(".py")).length;

  if (hasPyProject || pyFileCount > 0) {
    let confidence: "high" | "medium" | "low" = "low";
    let reason = `Found ${pyFileCount} Python files.`;

    if (hasPyProject && pyFileCount > 0) {
      confidence = "high";
      reason = `Found Python configuration and ${pyFileCount} .py files.`;
    } else if (pyFileCount > 3) {
      confidence = "high";
      reason = `Found ${pyFileCount} Python files.`;
    } else if (pyFileCount > 0) {
      confidence = "medium";
    }

    hints.push({
      language: "Python",
      confidence,
      reason,
    });
  }

  // Go
  const hasGoMod = basenames.includes("go.mod") || basenames.includes("go.sum");
  const goFileCount = lowerFiles.filter((f) => f.endsWith(".go")).length;

  if (hasGoMod || goFileCount > 0) {
    let confidence: "high" | "medium" | "low" = "low";
    let reason = `Found ${goFileCount} Go files.`;

    if (hasGoMod && goFileCount > 0) {
      confidence = "high";
      reason = `Found go.mod and ${goFileCount} Go files.`;
    } else if (goFileCount > 3) {
      confidence = "high";
      reason = `Found ${goFileCount} Go files.`;
    } else if (goFileCount > 0) {
      confidence = "medium";
    }

    hints.push({
      language: "Go",
      confidence,
      reason,
    });
  }

  // Rust
  const hasCargo = basenames.includes("cargo.toml");
  const rustFileCount = lowerFiles.filter((f) => f.endsWith(".rs")).length;

  if (hasCargo || rustFileCount > 0) {
    let confidence: "high" | "medium" | "low" = "low";
    let reason = `Found ${rustFileCount} Rust files.`;

    if (hasCargo && rustFileCount > 0) {
      confidence = "high";
      reason = `Found Cargo.toml and ${rustFileCount} Rust files.`;
    } else if (rustFileCount > 3) {
      confidence = "high";
      reason = `Found ${rustFileCount} Rust files.`;
    } else if (rustFileCount > 0) {
      confidence = "medium";
    }

    hints.push({
      language: "Rust",
      confidence,
      reason,
    });
  }

  if (hints.length === 0) {
    hints.push({
      language: "Unknown",
      confidence: "low",
      reason: "No recognized language configuration or source files found.",
    });
  }

  return hints;
}
