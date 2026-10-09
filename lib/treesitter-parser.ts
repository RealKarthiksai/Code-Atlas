/**
 * lib/treesitter-parser.ts
 *
 * Tree-Sitter AST parser integration for Python, Go, and Rust using web-tree-sitter (WASM).
 * Executes in Node.js server environments without requiring native C/C++ builds (node-gyp).
 * Tolerates malformed/broken syntax gracefully using Tree-Sitter error recovery nodes.
 */

import type {
  FunctionInfo,
  CallInfo,
  EntityInfo,
  EntityType,
} from "./language-plugins";

type ParserInstance = any;

let isInitialized = false;
let initPromise: Promise<boolean> | null = null;

let pythonParser: ParserInstance | null = null;
let goParser: ParserInstance | null = null;
let rustParser: ParserInstance | null = null;

/**
 * Safely access Node.js built-in modules without tripping client-side static bundler analyzers.
 */
function getNodeModule(moduleName: string): any {
  if (typeof window !== "undefined" || typeof process === "undefined") return null;
  if (typeof (process as any).getBuiltinModule === "function") {
    try {
      const mod = (process as any).getBuiltinModule(moduleName);
      if (mod) return mod;
    } catch {}
  }
  try {
    return typeof require !== "undefined" ? require(moduleName) : null;
  } catch {
    return null;
  }
}

/**
 * Resolves path to a WASM file located within node_modules.
 */
function resolveWasmPath(relPath: string): string | null {
  if (typeof process === "undefined" || !process.cwd) return null;
  const path = getNodeModule("path");
  const fs = getNodeModule("fs");
  if (!path || !fs) return null;

  const candidates = [
    path.join(process.cwd(), relPath),
    path.resolve(process.cwd(), "node_modules", relPath.replace(/^node_modules\//, "")),
  ];

  try {
    if (typeof __dirname !== "undefined") {
      candidates.push(path.resolve(__dirname, "..", relPath));
      candidates.push(path.resolve(__dirname, "../../", relPath));
    }
  } catch {}

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Initializes web-tree-sitter and loads WASM grammars for Python, Go, and Rust.
 * Thread-safe / idempotent across concurrent invocations.
 */
export async function initTreeSitterParsers(): Promise<boolean> {
  if (isInitialized) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      if (typeof window !== "undefined") {
        return false;
      }

      const fs = getNodeModule("fs");
      if (!fs) return false;

      let webTreeSitter = getNodeModule("web-tree-sitter");
      if (!webTreeSitter) {
        webTreeSitter = await import("web-tree-sitter");
      }

      let Parser = webTreeSitter as any;
      if (typeof Parser.init !== "function") {
        if (typeof Parser.default?.init === "function") {
          Parser = Parser.default;
        } else if (typeof Parser.Parser?.init === "function") {
          Parser = Parser.Parser;
        } else if (typeof Parser.default?.default?.init === "function") {
          Parser = Parser.default.default;
        }
      }

      const treeSitterWasmPath = resolveWasmPath("node_modules/web-tree-sitter/tree-sitter.wasm");
      if (!treeSitterWasmPath) return false;

      await Parser.init({
        locateFile: (scriptName: string) => {
          if (scriptName === "tree-sitter.wasm") return treeSitterWasmPath;
          return scriptName;
        },
      });

      // 1. Python grammar
      const pyWasmPath = resolveWasmPath("node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm");
      if (pyWasmPath) {
        const pyBytes = fs.readFileSync(pyWasmPath);
        const pyLang = await Parser.Language.load(pyBytes);
        pythonParser = new Parser();
        pythonParser.setLanguage(pyLang);
      }

      // 2. Go grammar
      const goWasmPath = resolveWasmPath("node_modules/tree-sitter-wasms/out/tree-sitter-go.wasm");
      if (goWasmPath) {
        const goBytes = fs.readFileSync(goWasmPath);
        const goLang = await Parser.Language.load(goBytes);
        goParser = new Parser();
        goParser.setLanguage(goLang);
      }

      // 3. Rust grammar
      const rustWasmPath = resolveWasmPath("node_modules/tree-sitter-wasms/out/tree-sitter-rust.wasm");
      if (rustWasmPath) {
        const rustBytes = fs.readFileSync(rustWasmPath);
        const rustLang = await Parser.Language.load(rustBytes);
        rustParser = new Parser();
        rustParser.setLanguage(rustLang);
      }

      isInitialized = Boolean(pythonParser && goParser && rustParser);
      return isInitialized;
    } catch (err) {
      console.error("[TreeSitter] Initialization error:", err);
      return false;
    }
  })();

  return initPromise;
}


export function isTreeSitterReady(): boolean {
  return isInitialized;
}

// ---------------------------------------------------------------------------
// Python AST Extraction
// ---------------------------------------------------------------------------

export function extractPythonImportsAST(content: string): string[] | null {
  if (!pythonParser) return null;
  try {
    const tree = pythonParser.parse(content);
    const imports = new Set<string>();

    function visit(node: any) {
      if (node.type === "import_statement") {
        for (const child of node.namedChildren) {
          if (child.type === "dotted_name") {
            imports.add(child.text);
          } else if (child.type === "aliased_import") {
            const orig = child.childForFieldName("name") || child.namedChild(0);
            if (orig) imports.add(orig.text);
          }
        }
      } else if (node.type === "import_from_statement") {
        const mod = node.childForFieldName("module_name");
        if (mod) {
          imports.add(mod.text);
        } else {
          const first = node.namedChild(0);
          if (first && (first.type === "relative_import" || first.type === "dotted_name")) {
            imports.add(first.text);
          }
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i));
      }
    }

    visit(tree.rootNode);
    return Array.from(imports);
  } catch (err) {
    console.error("[TreeSitter] Python import extraction failed:", err);
    return null;
  }
}

export function extractPythonFunctionsAST(content: string): FunctionInfo[] | null {
  if (!pythonParser) return null;
  try {
    const tree = pythonParser.parse(content);
    const functions: FunctionInfo[] = [];

    function visit(node: any) {
      if (node.type === "function_definition") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          functions.push({
            name,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            isExport: !name.startsWith("_"),
          });
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i));
      }
    }

    visit(tree.rootNode);
    return functions;
  } catch (err) {
    console.error("[TreeSitter] Python function extraction failed:", err);
    return null;
  }
}

export function extractPythonEntitiesAST(content: string): EntityInfo[] | null {
  if (!pythonParser) return null;
  try {
    const tree = pythonParser.parse(content);
    const entities: EntityInfo[] = [];

    function visit(node: any, parentEntityName?: string) {
      if (node.type === "class_definition") {
        const nameNode = node.childForFieldName("name");
        const className = nameNode?.text;
        if (className) {
          const extendsNames: string[] = [];
          const args = node.childForFieldName("superclasses");
          if (args) {
            for (let i = 0; i < args.namedChildCount; i++) {
              extendsNames.push(args.namedChild(i).text);
            }
          }

          entities.push({
            name: className,
            type: "class",
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            isExport: !className.startsWith("_"),
            extendsNames: extendsNames.length > 0 ? extendsNames : undefined,
          });

          // Process class body methods
          const body = node.childForFieldName("body");
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              visit(body.child(i), className);
            }
          }
          return;
        }
      } else if (node.type === "function_definition") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const fnName = nameNode.text;
          const isMethod = Boolean(parentEntityName);
          entities.push({
            name: fnName,
            type: isMethod ? "method" : "function",
            parentEntityName,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            isExport: !fnName.startsWith("_") || fnName === "__init__",
          });

          const body = node.childForFieldName("body");
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              visit(body.child(i), fnName);
            }
          }
          return;
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i), parentEntityName);
      }
    }

    visit(tree.rootNode);
    return entities;
  } catch (err) {
    console.error("[TreeSitter] Python entity extraction failed:", err);
    return null;
  }
}

export function extractPythonCallsAST(content: string): CallInfo[] | null {
  if (!pythonParser) return null;
  try {
    const tree = pythonParser.parse(content);
    const calls: CallInfo[] = [];

    function visit(node: any, currentFunction?: string) {
      let activeFunc = currentFunction;
      if (node.type === "function_definition") {
        activeFunc = node.childForFieldName("name")?.text || currentFunction;
      }

      if (node.type === "call") {
        const funcNode = node.childForFieldName("function");
        let calleeName = "";
        if (funcNode?.type === "identifier") {
          calleeName = funcNode.text;
        } else if (funcNode?.type === "attribute") {
          calleeName = funcNode.childForFieldName("attribute")?.text || funcNode.text;
        }

        if (calleeName) {
          calls.push({
            callerFunction: activeFunc,
            calleeName,
            line: node.startPosition.row + 1,
          });
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i), activeFunc);
      }
    }

    visit(tree.rootNode);
    return calls;
  } catch (err) {
    console.error("[TreeSitter] Python call extraction failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Go AST Extraction
// ---------------------------------------------------------------------------

export function extractGoImportsAST(content: string): string[] | null {
  if (!goParser) return null;
  try {
    const tree = goParser.parse(content);
    const imports = new Set<string>();

    function visit(node: any) {
      if (node.type === "import_spec") {
        const pathNode = node.childForFieldName("path");
        if (pathNode) {
          imports.add(pathNode.text.replace(/^"|"$/g, ""));
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i));
      }
    }

    visit(tree.rootNode);
    return Array.from(imports);
  } catch (err) {
    console.error("[TreeSitter] Go import extraction failed:", err);
    return null;
  }
}

export function extractGoFunctionsAST(content: string): FunctionInfo[] | null {
  if (!goParser) return null;
  try {
    const tree = goParser.parse(content);
    const functions: FunctionInfo[] = [];

    function visit(node: any) {
      if (node.type === "function_declaration" || node.type === "method_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          functions.push({
            name,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            isExport: /^[A-Z]/.test(name),
          });
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i));
      }
    }

    visit(tree.rootNode);
    return functions;
  } catch (err) {
    console.error("[TreeSitter] Go function extraction failed:", err);
    return null;
  }
}

export function extractGoEntitiesAST(content: string): EntityInfo[] | null {
  if (!goParser) return null;
  try {
    const tree = goParser.parse(content);
    const entities: EntityInfo[] = [];

    function findReceiverTypeName(recvNode: any): string | undefined {
      if (!recvNode) return undefined;
      function scan(n: any): string | null {
        if (n.type === "type_identifier") return n.text;
        for (let i = 0; i < n.childCount; i++) {
          const found = scan(n.child(i));
          if (found) return found;
        }
        return null;
      }
      return scan(recvNode) || undefined;
    }

    function visit(node: any) {
      if (node.type === "type_spec") {
        const nameNode = node.childForFieldName("name");
        const typeNode = node.childForFieldName("type");
        if (nameNode && typeNode) {
          const typeName = nameNode.text;
          const entityType: EntityType =
            typeNode.type === "interface_type" ? "interface" : "class";
          entities.push({
            name: typeName,
            type: entityType,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            isExport: /^[A-Z]/.test(typeName),
          });
        }
      } else if (node.type === "function_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const fnName = nameNode.text;
          entities.push({
            name: fnName,
            type: "function",
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            isExport: /^[A-Z]/.test(fnName),
          });
        }
      } else if (node.type === "method_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const methodName = nameNode.text;
          const recv = node.childForFieldName("receiver");
          const parentEntityName = findReceiverTypeName(recv);
          entities.push({
            name: methodName,
            type: "method",
            parentEntityName,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            isExport: /^[A-Z]/.test(methodName),
          });
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i));
      }
    }

    visit(tree.rootNode);
    return entities;
  } catch (err) {
    console.error("[TreeSitter] Go entity extraction failed:", err);
    return null;
  }
}

export function extractGoCallsAST(content: string): CallInfo[] | null {
  if (!goParser) return null;
  try {
    const tree = goParser.parse(content);
    const calls: CallInfo[] = [];

    function visit(node: any, currentFunction?: string) {
      let activeFunc = currentFunction;
      if (node.type === "function_declaration" || node.type === "method_declaration") {
        activeFunc = node.childForFieldName("name")?.text || currentFunction;
      }

      if (node.type === "call_expression") {
        const funcNode = node.childForFieldName("function");
        let calleeName = "";
        if (funcNode?.type === "identifier") {
          calleeName = funcNode.text;
        } else if (funcNode?.type === "selector_expression") {
          calleeName = funcNode.childForFieldName("field")?.text || funcNode.text;
        }

        if (calleeName) {
          calls.push({
            callerFunction: activeFunc,
            calleeName,
            line: node.startPosition.row + 1,
          });
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i), activeFunc);
      }
    }

    visit(tree.rootNode);
    return calls;
  } catch (err) {
    console.error("[TreeSitter] Go call extraction failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rust AST Extraction
// ---------------------------------------------------------------------------

export function extractRustImportsAST(content: string): string[] | null {
  if (!rustParser) return null;
  try {
    const tree = rustParser.parse(content);
    const imports = new Set<string>();

    function resolveUseTree(node: any, prefix = "") {
      if (node.type === "scoped_identifier" || node.type === "identifier" || node.type === "use_wildcard") {
        const full = prefix ? `${prefix}::${node.text}` : node.text;
        imports.add(full);
      } else if (node.type === "use_as_clause") {
        const pathNode = node.namedChild(0);
        if (pathNode) resolveUseTree(pathNode, prefix);
      } else if (node.type === "scoped_use_list") {
        const pathNode = node.childForFieldName("path");
        const listNode = node.childForFieldName("list");
        const nextPrefix = prefix ? `${prefix}::${pathNode?.text || ""}` : (pathNode?.text || "");
        if (listNode) {
          for (const item of listNode.namedChildren) {
            resolveUseTree(item, nextPrefix);
          }
        }
      } else if (node.type === "use_declaration") {
        const arg = node.childForFieldName("argument");
        if (arg) resolveUseTree(arg, "");
      }
    }

    for (let i = 0; i < tree.rootNode.childCount; i++) {
      const child = tree.rootNode.child(i);
      if (child.type === "use_declaration") {
        resolveUseTree(child);
      }
    }

    return Array.from(imports);
  } catch (err) {
    console.error("[TreeSitter] Rust import extraction failed:", err);
    return null;
  }
}

export function extractRustFunctionsAST(content: string): FunctionInfo[] | null {
  if (!rustParser) return null;
  try {
    const tree = rustParser.parse(content);
    const functions: FunctionInfo[] = [];

    function visit(node: any) {
      if (node.type === "function_item") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          const isExport = node.children.some((c: any) => c.type === "visibility_modifier");
          functions.push({
            name,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            isExport,
          });
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i));
      }
    }

    visit(tree.rootNode);
    return functions;
  } catch (err) {
    console.error("[TreeSitter] Rust function extraction failed:", err);
    return null;
  }
}

export function extractRustEntitiesAST(content: string): EntityInfo[] | null {
  if (!rustParser) return null;
  try {
    const tree = rustParser.parse(content);
    const entities: EntityInfo[] = [];

    for (let i = 0; i < tree.rootNode.childCount; i++) {
      const child = tree.rootNode.child(i);

      if (child.type === "struct_item") {
        const name = child.childForFieldName("name")?.text;
        if (name) {
          const isExport = child.children.some((c: any) => c.type === "visibility_modifier");
          entities.push({
            name,
            type: "class",
            lineStart: child.startPosition.row + 1,
            lineEnd: child.endPosition.row + 1,
            isExport,
          });
        }
      } else if (child.type === "enum_item") {
        const name = child.childForFieldName("name")?.text;
        if (name) {
          const isExport = child.children.some((c: any) => c.type === "visibility_modifier");
          entities.push({
            name,
            type: "class",
            lineStart: child.startPosition.row + 1,
            lineEnd: child.endPosition.row + 1,
            isExport,
          });
        }
      } else if (child.type === "trait_item") {
        const name = child.childForFieldName("name")?.text;
        if (name) {
          const isExport = child.children.some((c: any) => c.type === "visibility_modifier");
          entities.push({
            name,
            type: "interface",
            lineStart: child.startPosition.row + 1,
            lineEnd: child.endPosition.row + 1,
            isExport,
          });
        }
      } else if (child.type === "function_item") {
        const name = child.childForFieldName("name")?.text;
        if (name) {
          const isExport = child.children.some((c: any) => c.type === "visibility_modifier");
          entities.push({
            name,
            type: "function",
            lineStart: child.startPosition.row + 1,
            lineEnd: child.endPosition.row + 1,
            isExport,
          });
        }
      } else if (child.type === "impl_item") {
        const targetType = child.childForFieldName("type")?.text;
        const traitName = child.childForFieldName("trait")?.text;
        const declList = child.childForFieldName("body");
        if (declList) {
          for (let j = 0; j < declList.childCount; j++) {
            const item = declList.child(j);
            if (item.type === "function_item") {
              const name = item.childForFieldName("name")?.text;
              if (name) {
                const isExport = item.children.some((c: any) => c.type === "visibility_modifier");
                entities.push({
                  name,
                  type: "method",
                  parentEntityName: targetType,
                  implementsNames: traitName ? [traitName] : undefined,
                  lineStart: item.startPosition.row + 1,
                  lineEnd: item.endPosition.row + 1,
                  isExport,
                });
              }
            }
          }
        }
      }
    }

    return entities;
  } catch (err) {
    console.error("[TreeSitter] Rust entity extraction failed:", err);
    return null;
  }
}

export function extractRustCallsAST(content: string): CallInfo[] | null {
  if (!rustParser) return null;
  try {
    const tree = rustParser.parse(content);
    const calls: CallInfo[] = [];

    function visit(node: any, currentFunction?: string) {
      let activeFunc = currentFunction;
      if (node.type === "function_item") {
        activeFunc = node.childForFieldName("name")?.text || currentFunction;
      }

      if (node.type === "call_expression") {
        const funcNode = node.childForFieldName("function");
        let calleeName = "";
        if (funcNode?.type === "identifier") {
          calleeName = funcNode.text;
        } else if (funcNode?.type === "scoped_identifier") {
          calleeName = funcNode.childForFieldName("name")?.text || funcNode.text;
        } else if (funcNode?.type === "field_expression") {
          calleeName = funcNode.childForFieldName("field")?.text || funcNode.text;
        }

        if (calleeName) {
          calls.push({
            callerFunction: activeFunc,
            calleeName,
            line: node.startPosition.row + 1,
          });
        }
      } else if (node.type === "macro_invocation") {
        const macroNode = node.childForFieldName("macro");
        if (macroNode) {
          calls.push({
            callerFunction: activeFunc,
            calleeName: macroNode.text,
            line: node.startPosition.row + 1,
          });
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        visit(node.child(i), activeFunc);
      }
    }

    visit(tree.rootNode);
    return calls;
  } catch (err) {
    console.error("[TreeSitter] Rust call extraction failed:", err);
    return null;
  }
}
