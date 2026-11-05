import { defineConfig } from "oxlint";

const sharedImportMessage = "shared/ is the functional core: no Node built-ins, no Effect. Do IO at an edge: server/, bin/, pi/, scripts/ or web/src/api.ts.";

export default defineConfig({
	ignorePatterns: [
		".agent/**",
		".agents/**",
		".claude/**",
		".codex/**",
		".continue/**",
		".cursor/**",
		".gemini/**",
		".opencode/**",
		".pi/**",
		".roo/**",
		".windsurf/**",
		"tools/oxlint/anti-slop/**",
		"node_modules/**",
		"web/dist/**",
		"dist/**",
	],
	jsPlugins: [
		{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
		{
			name: "anti-slop-effect",
			specifier: "./tools/oxlint/anti-slop/effect/index.ts",
		},
	],
	rules: {
		"oxc/no-accumulating-spread": "error",
		// ratchet: back to "error" when its fix batch lands
		"anti-slop/no-array-filter-map": "warn",
		"anti-slop/no-reduce-accumulator-copy": "error",
		// ratchet: back to "error" when its fix batch lands
		"anti-slop/no-chained-type-assertions": "warn",
		// ratchet: back to "error" when its fix batch lands
		"anti-slop/no-conditional-empty-object-spread": "warn",
		// ratchet: back to "error" when its fix batch lands
		"anti-slop/no-known-value-widening": "warn",
		"anti-slop/no-module-mocking": "error",
		"anti-slop/no-object-parameters": "error",
		"anti-slop/no-reflect-apply": "error",
		"anti-slop/no-reflect-get": "error",
		// ratchet: back to "error" when its fix batch lands
		"anti-slop/no-runtime-typeof": [
			"warn",
			{ allowInTypeGuards: true },
		],
		"anti-slop/no-shape-in-symbol-names": "error",
		"anti-slop/no-unknown-parameters": "warn",
		// ratchet: back to "error" when its fix batch lands
		"anti-slop/no-unknown-returns": "warn",
		"anti-slop/no-unknown-type-aliases": "error",
		// ratchet: back to "error" when its fix batch lands
		"anti-slop/no-unsafe-dictionary-type": "warn",
		"anti-slop/no-widen-then-assert": "error",
		// ratchet: back to "error" when its fix batch lands
		"anti-slop/require-readable-spacing": "warn",
		// ratchet: back to "error" when its fix batch lands
		"anti-slop/require-safety-comment-for-type-assertion": "warn",
		"anti-slop-effect/no-manual-effect-error-tag": "error",
		"anti-slop-effect/no-manual-tag-comparison": "error",
		"anti-slop-effect/no-manual-tagged-construction": "error",
		"anti-slop-effect/no-service-constructor-imports": "error",
		// off: every finding is in shared/web/test, which stay Effect-free; see ADR-0005 in ai-artifacts/docs/adr
		"anti-slop-effect/prefer-effect-match": "off",
		"eslint/no-unused-vars": "error",
		"unicorn/no-useless-fallback-in-spread": "error",
		"eslint/no-control-regex": "error",
	},
	overrides: [
		{
			files: ["web/**"],
			rules: {
				"eslint/no-restricted-imports": ["error", {
					paths: [{ name: "effect", message: "shared/ and web/ stay Effect-free" }],
					patterns: [{ group: ["effect/*", "@effect/*", "**/server/**"], message: "shared/ and web/ stay Effect-free" }],
				}],
			},
		},
		{
			files: ["shared/**"],
			rules: {
				"eslint/no-restricted-imports": ["error", {
					paths: [
						"effect", "fs", "fs/promises", "child_process", "http", "https",
						"http2", "net", "tls", "dgram", "dns", "os", "path", "url",
						"crypto", "vm", "worker_threads", "process",
					].map(name => ({ name, message: sharedImportMessage })),
					patterns: [{ group: ["effect/*", "@effect/*", "**/server/**", "node:*"], message: sharedImportMessage }],
				}],
			},
		},
	],
});
