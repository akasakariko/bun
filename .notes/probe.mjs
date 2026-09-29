export const meta = { name: "fold-differential-probe", phases: ["probe", "collect"] };

const context = [
  "You test one change in the Bun bundler. You only run probes. Do NOT edit any file under /workspace/bun, do NOT run `bun bd`, `cargo`, or any build, and do NOT use git to change anything.",
  "",
  "THE CHANGE. With `--minify-syntax`, `bun build` replaces a call of a function that always returns `true`, `false`, `null` or `undefined` with that value ('fold'). Example: `function isDev() { return false; } if (isDev()) require('./devtools');` builds to nothing, and `./devtools` is never resolved. The function can also be an import from another file: when a condition (`if`, `?:`, the left operand of `&&`, `||`, `??`, the operand of `!`) calls an import, the worker that parses the importer first resolves the specifier and parses the imported file ('lookup'), to learn what the function returns.",
  "Source: /workspace/bun/src/js_parser/visit/const_call.rs (the fold, the rules), /workspace/bun/src/bundler/const_call_lookup.rs (the lookup), hooks in /workspace/bun/src/js_parser/visit/visit_expr.rs (`e_call`, `e_template`), /workspace/bun/src/js_parser/visit/mod.rs, /workspace/bun/src/js_parser/p.rs (`handle_identifier`, `declare_symbol`), /workspace/bun/src/bundler/ParseTask.rs. Tests: /workspace/bun/test/bundler/bundler_inline_constant_calls.test.ts. Docs: section 'Constant function calls' in /workspace/bun/docs/bundler/index.mdx. Read the parts you need.",
  "",
  "RULES THE CODE CLAIMS TO KEEP (each is a thing to attack):",
  "- A call is kept (not replaced) in the argument of `import()`, `require()`, `require.resolve()`, and inside a `?:`, `||`, `&&`, `??` or `,` expression that is the target of a call or the tag of a template. A function body inside such an expression is not part of it.",
  "- A `const` whose value came from a fold is not substituted in those same places, so `const name = isWin() ? './a' : './b'; require(name)` stays a run-time require.",
  "- A function that shares its binding with a `var`, that something assigns to, or a file with direct `eval`, is not folded.",
  "- The lookup resolves like the bundler does (same import kind, conditions, tsconfig paths), reads the file with the same reader, and parses it with the options of the real parse task.",
  "- Errors and warnings that the resolver reports while the lookup resolves still reach the build log, one time.",
  "- Each imported file is parsed for the lookup one time per build (per target and depth), also when many workers ask at the same time.",
  "",
  "HOW TO TEST. The binary is /workspace/bun/build/debug/bun-debug (a debug build of this change, slow: a build takes 1 to 5 seconds). Always set BUN_DEBUG_QUIET_LOGS=1. 'Fold on' is the plain run. 'Fold off' is the same command with BUN_FEATURE_FLAG_DISABLE_CONST_CALL_FOLDING=1 in the environment. Fold off is the reference: it has the behaviour of the main branch. `BUN_DEBUG_const_call=1` prints the lookup's log lines.",
  "For each input: build it both ways with `build <entry> --minify-syntax --target=node --outfile=...` (add your flags), then compare (1) the exit code of the build, (2) the errors and warnings of the build, (3) what the bundle prints when you run it with `node <outfile>` (node is installed) or with the binary itself. Also compare with what the unbundled source prints under node where that makes sense.",
  "A DEFECT is one of: the bundle with fold on prints something else than the bundle with fold off; the build passes one way and fails the other way, EXCEPT the one intended difference (fold on removes a dead branch, so an import in that dead branch is not resolved and a missing file there no longer fails the build); an error or warning present one way and absent the other way (except errors about code in a removed dead branch); a hang, a crash, a panic, an ASAN report; a different result between repeated runs of the same command.",
  "NOT a defect: a call that fold on keeps where it could have folded (a missed fold), unless the docs section promises that fold. Report missed folds that contradict the docs separately as `docs_mismatch`.",
  "The machine is shared and slow. Put a `timeout 120` in front of each build. Work under the directory /tmp/probe-<your theme name>/. Write small inputs. Try many variants: aim for 40 or more distinct inputs. Before you report a defect, run it again from a clean directory and reduce it to the smallest input that still shows it.",
].join("\n");

const themes = [
  ["taint", "Values that come from a fold and then flow somewhere. Attack the rule for `const`: chained consts, template literals, string concatenation, `??`/`||` defaults, consts in nested function scopes captured by inner functions, consts at module scope after imports, TypeScript `enum` and `namespace`, `export const`, destructuring, consts used as computed keys, consts passed through `typeof`/`!`/`void`. Look for a build that passes with fold off and fails with fold on because a `require()`, `import()` or `require.resolve()` argument became a string that the bundler resolves, and for bundles whose output differs."],
  ["callee", "The `this` value of calls. Attack call targets and template tags of every shape that contain a foldable call or a const that holds a folded value: nested arrays and objects in a `?:` test, comma chains, `!`/`!!`/`void`, optional calls `?.()`, `new`, immediately invoked function expressions and arrows (folds inside their bodies must still happen and must be right), class bodies and static blocks, getters, `super` calls, `.call/.apply/.bind`, tagged templates, parenthesized member access. Each function that you call must report its `this` so that a wrong `this` shows in the output. Run in both strict (ESM `.mjs`) and sloppy (`.cjs`) files."],
  ["rebinding", "Ways to rebind or shadow a function so that the folded value is wrong. `var`/`function`/`class`/`let` with the same name in every order and count (two and three declarations), in blocks, in `switch` cases, in labeled statements, after `return`, in sloppy `.cjs` files and strict `.mjs` files, parameters and catch bindings with the same name, assignments through destructuring, `for (f of ...)`, `f++`, `[f] = [...]`, `({ f } = ...)`, assignment in a nested function that runs before the call, `--define X=f` with an assignment to `X`, `eval`, `with`, `arguments`, `globalThis.f = ...` for sloppy scripts, `export { f }` then reassignment from another module through a setter function, a function declared after its call (hoisting)."],
  ["resolver", "Resolution of the imported file by the lookup against resolution by the bundler. `exports` and `imports` maps with `import`/`require`/`node`/`browser`/`default`/custom conditions and `--conditions`, a `module.exports = require('x')` file in front of each of those (the redirect is a `require`), files with the same name and different extensions (.js .mjs .cjs .ts .mts .cts .tsx .jsx .json), directory imports with `index.*`, `main`/`module`/`browser` fields, tsconfig `paths`/`baseUrl`/`extends`, symlinked packages and symlinked files, `--external`, `--packages=external`, `--target=browser|bun|node`, packages nested in `node_modules` of a package, case differences, specifiers with query strings or `#` fragments, absolute paths, `..` paths. In each input the two candidate files must return DIFFERENT values from the same exported function name, so that a wrong choice shows in the output."],
  ["diagnostics", "Errors and warnings. Put broken or suspicious `package.json`, `tsconfig.json`, `bunfig.toml`, `.env` files in the directories that a condition-called import resolves through (truncated JSON, duplicate keys, wrong types, missing `extends` target, invalid `paths`), also several levels up and in `node_modules` packages. Use files without read permission and dangling symlinks. Use one importer and many importers (so that worker timing matters), and run each build 15 times: compare the exit code and the full set of messages (sorted) between fold on and fold off and between runs. Also try a syntax error, a duplicate declaration and a TypeScript-only error in the imported file itself, and an imported file that only a dead branch uses."],
  ["options", "Parser options of the nested parse against the real parse. For an imported function whose return value depends on an option, the folded value must equal what the bundled function returns. Use: `--define` (identifiers, member chains like `process.env.X`, `typeof` forms), `--drop=console|debugger`, `--format=esm|cjs|iife`, `--target=node|bun|browser`, `import.meta.main|url|dir|file|path|env`, `module.id|filename|path`, `require.main === module`, `__filename`/`__dirname`, `process.env.NODE_ENV` defaults, `--production`, `--minify`, `feature()` from `bun:bundle` with `--feature`, `--ignore-dce-annotations` with `/* @__PURE__ */` and `sideEffects: false`, `--jsx-*` flags and tsconfig JSX settings, decorators (`experimentalDecorators`, `emitDecoratorMetadata`) in .ts and .js files, `useDefineForClassFields`, files with a UTF-8 byte order mark, a hashbang, UTF-16 text, CRLF line ends, `--compile` with its defines (`process.platform`, `process.arch`), an imported file that is also an entry point."],
  ["concurrency", "Many workers and the per-build cache. Generate inputs with a script: 200 importers of one imported file, imported files of 1 MB, import cycles (A imports B imports A, a file that imports itself, cycles of 3 and of 10), chains of re-exports up to 12 files, a function that returns a call of an import of its own file (depth 1) combined with cycles, two entry points, `--splitting`, and the same file reached through two different specifiers. Run each build 20 times with fold on and look for a hang (use `timeout 120`, a timeout is a defect), a crash, or output that differs between runs or from fold off. With `BUN_DEBUG_const_call=1` count the log lines per imported file: more than one line per file and depth is a defect of the 'one time' rule."],
  ["api", "The JavaScript API and plugins. Write scripts that call `Bun.build()` (run them with the debug binary) with `minify: { syntax: true }`: in-memory `files` that shadow or add to files on disk, `onResolve` and `onLoad` plugins with filters that match or do not match the imported file and its specifier, plugins that return other contents than the file on disk, virtual modules and namespaces, `defer()`, two `Bun.build()` calls in one process with different `define` values (the second build must not see values of the first), `Bun.build()` calls that run at the same time, `throw: false` with `logs`, `external`, `conditions`, `naming`, `splitting`, `target`. The reference is the same script with BUN_FEATURE_FLAG_DISABLE_CONST_CALL_FOLDING=1. Compare `success`, `logs` and what each output prints when run."],
];

const schema = {
  type: "object",
  properties: {
    inputs_tried: { type: "integer" },
    defects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          kind: { type: "string", enum: ["wrong_output", "build_result_differs", "diagnostics_differ", "hang_or_crash", "not_deterministic", "docs_mismatch"] },
          directory: { type: "string" },
          files: { type: "string" },
          command: { type: "string" },
          fold_on: { type: "string" },
          fold_off: { type: "string" },
          suspected_cause: { type: "string" },
          reproduced_twice: { type: "boolean" },
        },
        required: ["title", "kind", "directory", "files", "command", "fold_on", "fold_off", "reproduced_twice"],
      },
    },
    held_up: { type: "string" },
  },
  required: ["inputs_tried", "defects", "held_up"],
};

phase("probe");
const results = await parallel(
  themes.map(([name, brief]) => () =>
    agent(
      context +
        "\n\nYOUR THEME: " + name + ". Work under /tmp/probe-" + name + "/.\n" + brief +
        "\n\nREPORT. Return the defects you reproduced two times, each with the exact files (paths and full contents, keep them small), the exact command, and the two outputs. In `held_up` list in short lines what you tried that showed no difference. Do not report guesses.",
      { label: "probe-" + name, schema },
    ),
  ),
);

phase("collect");
const out = {};
themes.forEach(([name], i) => {
  out[name] = results[i];
});
export default out;
