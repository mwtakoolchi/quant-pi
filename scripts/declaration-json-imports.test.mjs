import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decode, encode } from "@jridgewell/sourcemap-codec";
import { checkDeclarationJsonImports, restoreDeclarationJsonImports } from "./declaration-json-imports.mjs";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-declaration-json-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "src/providers"), { recursive: true });
	mkdirSync(join(root, "dist/providers"), { recursive: true });
	const bare = 'import values from "./data/example.json";';
	const expected = 'import values from "./data/example.json" with { type: "json" };';
	writeFileSync(join(root, "src/providers/example.models.ts"), `${expected}\nexport const models = values;\n`);
	const path = join(root, "dist/providers/example.models.d.ts");
	const contents = `// emitted declaration\n${bare}\nexport declare const models: typeof values;\n//# sourceMappingURL=example.models.d.ts.map\n`;
	writeFileSync(path, contents);
	const mappings = [[], [[0, 0, 0, 0], [7, 0, 0, 7], [bare.length - 1, 0, 0, expected.length - 1]], [[0, 0, 1, 0]]];
	writeFileSync(`${path}.map`, JSON.stringify({ version: 3, file: "example.models.d.ts", sources: ["../../src/providers/example.models.ts"], names: [], mappings: encode(mappings) }));
	writeFileSync(join(root, "dist/providers/example.models.js"), `${expected}\nexport const models = values;\n`);
	return { root, path, bare, expected, mappings, contents };
}

test("restores attributes, adjusts only shifted map columns, and leaves runtime output unchanged", (t) => {
	const { root, path, bare, expected, mappings, contents } = fixture(t);
	const jsPath = join(root, "dist/providers/example.models.js");
	const js = readFileSync(jsPath);
	assert.throws(() => checkDeclarationJsonImports(root), /rebuild pi-ai/);
	assert.equal(readFileSync(path, "utf8"), contents);
	assert.equal(restoreDeclarationJsonImports(root), 1);
	assert.equal(readFileSync(path, "utf8"), contents.replace(bare, expected));
	assert.deepEqual(readFileSync(jsPath), js);
	const map = JSON.parse(readFileSync(`${path}.map`, "utf8"));
	const shifted = structuredClone(mappings);
	shifted[1][2][0] += expected.length - bare.length;
	assert.deepEqual(decode(map.mappings), shifted);
	const fixedMap = readFileSync(`${path}.map`);
	checkDeclarationJsonImports(root);
	assert.equal(restoreDeclarationJsonImports(root), 0);
	assert.deepEqual(readFileSync(`${path}.map`), fixedMap);
});

test("rejects a declaration from a different catalog or an unexpected import shape", (t) => {
	const { root, path, contents } = fixture(t);
	writeFileSync(path, contents.replace("example.json", "different.json"));
	assert.throws(() => restoreDeclarationJsonImports(root), /differs from source/);
	writeFileSync(path, contents.replace("import values", "import renamed"));
	assert.throws(() => restoreDeclarationJsonImports(root), /differs from source/);
});

test("does not patch declarations when a required map is invalid", (t) => {
	const { root, path, contents } = fixture(t);
	writeFileSync(`${path}.map`, JSON.stringify({ version: 3, file: "wrong.d.ts", mappings: "AAAA" }));
	assert.throws(() => restoreDeclarationJsonImports(root), /Invalid declaration map/);
	assert.equal(readFileSync(path, "utf8"), contents);
});

test("preserves CRLF declarations and accepts CRLF source checkouts", (t) => {
	const { root, path, bare, expected, contents } = fixture(t);
	const source = join(root, "src/providers/example.models.ts");
	writeFileSync(source, readFileSync(source, "utf8").replaceAll("\n", "\r\n"));
	writeFileSync(path, contents.replaceAll("\n", "\r\n"));
	assert.equal(restoreDeclarationJsonImports(root), 1);
	assert.equal(readFileSync(path, "utf8"), contents.replace(bare, expected).replaceAll("\n", "\r\n"));
	checkDeclarationJsonImports(root);
});
