import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
// The TypeScript compiler the harness already installs for its own type check.
import ts from "./dependencies/node_modules/typescript/lib/typescript.js";

// Problems the harness finds in a file without running it: syntax errors, unbalanced structure and
// names that are used but never declared. Each is "line N: message", or a message for the whole file.
export function checkFile(file: string, text: string, root: string): string[] {
  const extension = extname(file).toLowerCase();
  if ([".js", ".mjs", ".cjs", ".jsx"].includes(extension)) return checkScripts([{ name: file, code: text }], true);
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) return checkTypeScript(file, text, root);
  if (extension === ".html" || extension === ".htm") return checkHtml(file, text);
  if (extension === ".css") return checkBraces(text);
  if (extension === ".py") return checkPython(file, text);
  if (extension === ".json") {
    try { JSON.parse(text); return []; } catch (error) { return [(error as Error).message]; }
  }
  return [];
}

// The problems in `after` that `before` did not have, so an edit is told only what it introduced.
// Line numbers are ignored when matching, since an edit shifts them.
export function newProblems(before: string[], after: string[]): string[] {
  const left = before.map((problem) => problem.replace(/^line \d+: /, ""));
  return after.filter((problem) => {
    const index = left.indexOf(problem.replace(/^line \d+: /, ""));
    if (index < 0) return true;
    left.splice(index, 1);
    return false;
  });
}

// Syntax errors, plus names used but not declared and names declared twice. Other type errors are
// left out: plain JavaScript produces too many that do not matter.
const NAME_CODES = new Set([2304, 2552, 2451, 2300]);
const libraries = new Map<string, ts.SourceFile | undefined>();

function program(files: { name: string; code: string }[], options: ts.CompilerOptions): ts.Program {
  const host = ts.createCompilerHost(options);
  const own = new Map(files.map((file) => [resolve(file.name), file.code]));
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, language, ...rest) => {
    const code = own.get(resolve(name));
    if (code !== undefined) return ts.createSourceFile(name, code, language, true);
    // Library files are parsed once per harness process.
    if (!libraries.has(name)) libraries.set(name, getSourceFile(name, language, ...rest));
    return libraries.get(name);
  };
  const fileExists = host.fileExists;
  host.fileExists = (name) => own.has(resolve(name)) || fileExists(name);
  const readFile = host.readFile;
  host.readFile = (name) => own.get(resolve(name)) ?? readFile(name);
  return ts.createProgram(files.map((file) => file.name), options, host);
}

function describe(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (!diagnostic.file || diagnostic.start === undefined) return message;
  return "line " + (diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1) + ": " + message;
}

// Scripts that share one global scope, such as the inline scripts of one page.
function checkScripts(files: { name: string; code: string }[], names: boolean): string[] {
  const built = program(files, { allowJs: true, checkJs: true, noEmit: true, jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [] });
  return files.flatMap((file) => {
    const source = built.getSourceFile(file.name)!;
    const syntax = built.getSyntacticDiagnostics(source);
    // Name errors after a syntax error are mostly noise from the broken parse.
    const semantic = names && !syntax.length ? built.getSemanticDiagnostics(source).filter((item) => NAME_CODES.has(item.code)) : [];
    return [...syntax, ...semantic].map(describe);
  });
}

// With a tsconfig.json at the workspace root, a full type check of the file in its project;
// otherwise the same checks as JavaScript.
function checkTypeScript(file: string, text: string, root: string): string[] {
  const config = join(root, "tsconfig.json");
  if (!existsSync(config)) {
    const built = program([{ name: file, code: text }], { noEmit: true, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.Preserve, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [] });
    const source = built.getSourceFile(file)!;
    const syntax = built.getSyntacticDiagnostics(source);
    return [...syntax, ...(syntax.length ? [] : built.getSemanticDiagnostics(source).filter((item) => NAME_CODES.has(item.code)))].map(describe);
  }
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) return [];
  const names = parsed.fileNames.some((name) => resolve(name) === resolve(file)) ? parsed.fileNames : [...parsed.fileNames, file];
  const built = program(names.map((name) => ({ name, code: resolve(name) === resolve(file) ? text : ts.sys.readFile(name) ?? "" })),
    { ...parsed.options, noEmit: true });
  const source = built.getSourceFile(file)!;
  return [...built.getSyntacticDiagnostics(source), ...built.getSemanticDiagnostics(source)].map(describe);
}

// The page's own tags must balance: one <html>, <head> and <body> each, and every <script> and
// <style> closed. Inline scripts are checked as JavaScript and inline styles for braces, with line
// numbers in the page's terms.
function checkHtml(file: string, text: string): string[] {
  const problems: string[] = [];
  const page = text.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
  const line = (index: number) => page.slice(0, index).split("\n").length;
  const opened = new Map<string, number[]>();
  const scripts: { name: string; code: string }[] = [];
  let external = false;
  const tag = /<(\/?)(html|head|body|script|style)\b([^>]*)>/gi;
  for (let match = tag.exec(page); match; match = tag.exec(page)) {
    const [whole, closing, rawName, attributes] = match;
    const name = rawName!.toLowerCase();
    if (closing) {
      if (!opened.get(name)?.length) problems.push("line " + line(match.index) + ": </" + name + "> without an opening <" + name + ">");
      else opened.get(name)!.pop();
      continue;
    }
    if (["html", "head", "body"].includes(name) && opened.has(name)) {
      problems.push("line " + line(match.index) + ": a second <" + name + ">");
    }
    opened.set(name, [...(opened.get(name) ?? []), match.index]);
    if (name !== "script" && name !== "style") continue;
    // Script and style content is raw text: skip to its closing tag.
    const start = match.index + whole.length;
    const end = page.toLowerCase().indexOf("</" + name, start);
    const content = page.slice(start, end < 0 ? undefined : end);
    // Blank out everything before the content so its line numbers match the page.
    const padded = page.slice(0, start).replace(/[^\n]/g, " ") + content;
    if (name === "style") {
      problems.push(...checkBraces(padded));
      // CSS has no tags, so a tag here is markup written into the stylesheet.
      const markup = /<\/?[A-Za-z][\w-]*[\s>/]/.exec(content);
      if (markup) problems.push("line " + line(start + markup.index) + ": HTML tag inside <style>");
    } else if (/\bsrc\s*=/i.test(attributes!)) external = true;
    else if (!/\btype\s*=\s*["']?(?!(?:text|application)\/(?:javascript|ecmascript)|module)/i.test(attributes!)) {
      scripts.push({ name: file + "." + scripts.length + ".js", code: padded });
    }
    if (end < 0) break;
    tag.lastIndex = end;
  }
  for (const [name, starts] of opened) {
    for (const start of starts) problems.push("line " + line(start) + ": <" + name + "> is never closed");
  }
  // Names a <script src> defines cannot be seen, so with one present only syntax is checked.
  return [...problems, ...(scripts.length ? checkScripts(scripts, !external) : [])];
}

// Braces outside comments and strings, for CSS.
function checkBraces(text: string): string[] {
  const problems: string[] = [];
  const open: number[] = [];
  let line = 1;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === "\n") line++;
    else if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const skipped = text.slice(index, end < 0 ? undefined : end + 2);
      line += skipped.split("\n").length - 1;
      index += skipped.length - 1;
    } else if (character === "\"" || character === "'") {
      const end = text.indexOf(character, index + 1);
      if (end < 0) break;
      line += text.slice(index, end).split("\n").length - 1;
      index = end;
    } else if (character === "{") open.push(line);
    else if (character === "}" && !open.pop()) problems.push("line " + line + ": } without a matching {");
  }
  return [...problems, ...open.map((start) => "line " + start + ": { is never closed")];
}

// Python's own parser, without writing bytecode into the workspace. No Python, no check.
function checkPython(file: string, text: string): string[] {
  try {
    execFileSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read(), sys.argv[1])", file],
      { input: text, timeout: 10_000, stdio: ["pipe", "ignore", "pipe"] });
    return [];
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? "");
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || !stderr) return [];
    const lines = stderr.trim().split("\n");
    const at = stderr.match(/line (\d+)/g)?.at(-1);
    return [(at ? at + ": " : "") + lines.at(-1)];
  }
}
