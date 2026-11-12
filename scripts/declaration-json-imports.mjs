// Restore JSON import attributes dropped by declaration emit. Older NodeNext
// consumers require them too; keep runtime output and declaration maps intact.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, encode } from "@jridgewell/sourcemap-codec";

function declarationChanges(packageRoot) {
	const sourceDirectory = join(packageRoot, "src/providers");
	const names = readdirSync(sourceDirectory).filter((name) => name.endsWith(".models.ts")).sort();
	if (names.length === 0) throw new Error("No generated provider declarations to check");
	const changes = [];
	for (const name of names) {
		const source = readFileSync(join(sourceDirectory, name), "utf8");
		const imports = [...source.matchAll(/^import values from ("\.\/data\/[^"\r\n]+\.json") with \{ type: "json" \};\r?$/gm)];
		if (imports.length !== 1) throw new Error(`Unexpected generated JSON import in ${name}`);
		const expected = imports[0][0].replace(/\r$/, "");
		const bare = `import values from ${imports[0][1]};`;
		const path = join(packageRoot, "dist/providers", name.replace(/\.ts$/, ".d.ts"));
		const text = readFileSync(path, "utf8");
		const newline = text.includes("\r\n") ? "\r\n" : "\n";
		const lines = text.split(/\r?\n/);
		const index = lines.findIndex((line) => line === bare || line === expected);
		if (index < 0 || lines.filter((line) => /^import values\b/.test(line)).length !== 1) {
			throw new Error(`Declaration JSON import differs from source: ${basename(path)}`);
		}
		if (lines[index] === expected) continue;
		const mapPath = `${path}.map`;
		const map = JSON.parse(readFileSync(mapPath, "utf8"));
		if (map.version !== 3 || map.file !== basename(path) || typeof map.mappings !== "string") {
			throw new Error(`Invalid declaration map: ${basename(mapPath)}`);
		}
		const mappings = decode(map.mappings);
		if (!mappings[index]) throw new Error(`Missing declaration import mapping: ${basename(mapPath)}`);
		// Only the semicolon and later columns move. Source positions and every
		// other line retain their original mappings to the generated TS source.
		for (const segment of mappings[index]) {
			if (segment[0] >= bare.length - 1) segment[0] += expected.length - bare.length;
		}
		map.mappings = encode(mappings);
		lines[index] = expected;
		changes.push([path, lines.join(newline)], [mapPath, JSON.stringify(map)]);
	}
	return changes;
}

export function checkDeclarationJsonImports(packageRoot) {
	if (declarationChanges(resolve(packageRoot)).length > 0) {
		throw new Error("JSON declaration import attributes are missing; rebuild pi-ai before packing");
	}
}

export function restoreDeclarationJsonImports(packageRoot) {
	// Validate the whole generated set before changing any output file.
	const changes = declarationChanges(resolve(packageRoot));
	for (const [path, text] of changes) writeFileSync(path, text);
	return changes.length / 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 3) throw new Error("usage: declaration-json-imports.mjs PACKAGE_ROOT");
	console.log(`Restored JSON import attributes in ${restoreDeclarationJsonImports(process.argv[2])} declarations`);
}
