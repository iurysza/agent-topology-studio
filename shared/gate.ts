/**
 * Safe gate interpolation (ADR-0001). A gate template is trusted shell code. Every placeholder value is untrusted data.
 *
 * shellWord single-quotes a value as one POSIX shell word, so sh never expands, splits or runs any part of it.
 * Adjacent text joins it into one word: `{{inputs.dir}}/plan.md` becomes `'/some dir'/plan.md`.
 *
 * Single quotes keep a value inert only where the gate is plain shell words and the command treats the word as data.
 * So a gate that has any placeholder may not contain `'`, `"`, a backtick, `\`, `$`, `#`, `<<`, `[`, `]`, `(` or `)`.
 * Brackets and parentheses go because bash evaluates array subscripts (`a[...]=1`, `a=([...]=1)`), `[[` and `((`
 * as arithmetic, which runs `$(...)` inside a single-quoted word. Use `test` instead of `[ ]`. gateProblem names the first one.
 * This is a whole-template rule, not a shell parser. A gate with no placeholder may use any shell syntax.
 * Residual: a command that itself treats an argument as code or arithmetic, such as `eval`, `sh -c`, `let`,
 * `declare -i` or `xargs`, still runs the value. Placeholders are data to the shell parser, not to every command.
 *
 * gateSource is plain JavaScript, so the compiled runner embeds the same code that validateMachine runs.
 */
export const gateSource = String.raw`const shellWord = (v) => "'" + v.replaceAll("'", "'\\''") + "'", gateProblem = (tpl) => { const p = tpl.match(/\{\{\s*([\w.]+)\s*\}\}/), c = p && tpl.replace(/\{\{\s*[\w.]+\s*\}\}/g, ' ').match(/['"\x60\\$#[\]()]|<</); return c ? 'uses {{' + p[1] + '}} with ' + c[0] + '. A gate with a placeholder cannot contain quotes, a backtick, \\, $, #, <<, [, ], ( or ), because the runner single-quotes each value and bash still evaluates subscripts and arithmetic. Use test instead of [ ], or put that shell code in a script and pass the placeholder as a bare argument.' : null }`;

type GateTools = { shellWord: (value: string) => string; gateProblem: (template: string) => string | null };

// SAFETY: gateSource is the constant above, not input, and defines exactly the two functions GateTools names.
const tools = new Function(`${gateSource}\nreturn { shellWord, gateProblem }`)() as GateTools;

export const { shellWord, gateProblem } = tools;
