import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import { getGitSource, produceArtifactSet, readArtifactSet } from "./package-artifacts.mjs";

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), contents);
	}
}

// #10633: Covers npm 12's package-keyed `npm pack --json` output only when npm 12 is on PATH.
test("produces a verified, content-addressed artifact set", (t) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-package-artifacts-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const repoRoot = join(temporaryRoot, "repo with spaces");
	mkdirSync(repoRoot);
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	writeFileSync(join(repoRoot, ".gitignore"), ".artifacts/\n**/dist/LICENSE\n**/dist/NOTICE\n");
	writeFileSync(join(repoRoot, "LICENSE"), "fixture upstream license\n");
	writeFileSync(join(repoRoot, "NOTICE"), "fixture fork attribution\n");
	writePackage(
		join(repoRoot, "packages", "shared"),
		{ name: "@pi-package-test/shared", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const marker = "artifact";\n' },
	);
	writePackage(
		join(repoRoot, "packages", "target"),
		{ name: "@pi-package-test/target", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const target = true;\n' },
	);
	execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
	execFileSync("git", ["add", "."], { cwd: repoRoot });
	execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repoRoot });

	const artifactSet = produceArtifactSet({ build: false, outDir: join(repoRoot, ".artifacts", "package set"), repoRoot });
	assert.deepEqual(artifactSet.packages.map((pkg) => pkg.name), ["@pi-package-test/shared", "@pi-package-test/target"]);
	for (const pkg of artifactSet.packages) {
		assert.match(pkg.tarball, /-[0-9a-f]{12}\.tgz$/);
		assert.match(pkg.integrity, /^sha512-/);
		assert.equal(execFileSync("tar", ["-xOf", pkg.tarballPath, "package/dist/LICENSE"], { encoding: "utf8" }), "fixture upstream license\n");
		assert.equal(execFileSync("tar", ["-xOf", pkg.tarballPath, "package/dist/NOTICE"], { encoding: "utf8" }), "fixture fork attribution\n");
	}
	assert.equal(artifactSet.source.dirty, false);
	assert.match(artifactSet.source.tree_digest, /^sha256-[A-Za-z0-9+/]{43}=$/);
	assert.deepEqual(artifactSet.source, getGitSource(repoRoot));
	assert.equal(readArtifactSet(artifactSet.manifestPath).packages.length, 2);
	// A pre-existing output link must never redirect notice writes outside dist.
	const outside = join(temporaryRoot, "outside-license");
	writeFileSync(outside, "unrelated bytes");
	const generatedNotice = join(repoRoot, "packages/shared/dist/LICENSE");
	rmSync(generatedNotice);
	symlinkSync(outside, generatedNotice);

	writeFileSync(join(repoRoot, "packages/shared/dist/index.js"), 'export const marker = "changed";\n');
	const changedArtifactSet = produceArtifactSet({ build: false, outDir: join(repoRoot, ".artifacts", "changed package set"), repoRoot });
	assert.equal(readFileSync(outside, "utf8"), "unrelated bytes");
	assert.equal(changedArtifactSet.source.dirty, true);
	assert.notEqual(changedArtifactSet.source.tree_digest, artifactSet.source.tree_digest);
	assert.notEqual(
		changedArtifactSet.getPackage("@pi-package-test/shared").tarball,
		artifactSet.getPackage("@pi-package-test/shared").tarball,
	);

	appendFileSync(artifactSet.packages[0].tarballPath, "corrupt");
	assert.throws(() => readArtifactSet(artifactSet.manifestPath), /integrity mismatch/);
	const packageJsonPath = join(repoRoot, "packages", "shared", "package.json");
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: join(repoRoot, "packages", "shared"), repoRoot }),
		/Repository-local output directory must be inside.*\.artifacts/,
	);
	assert.equal(existsSync(packageJsonPath), true);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: repoRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: temporaryRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: parse(repoRoot).root, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	// Even an explicitly supplied source observation cannot enable a dist link.
	rmSync(join(repoRoot, "packages/shared/dist"), { recursive: true });
	symlinkSync(temporaryRoot, join(repoRoot, "packages/shared/dist"));
	assert.throws(() => produceArtifactSet({ build: false, source: null,
		outDir: join(repoRoot, ".artifacts", "linked dist"), repoRoot }), /regular directory/);
	assert.equal(existsSync(join(temporaryRoot, "LICENSE")), false);
});

test("source inventory binds untracked bytes, executable bits and deletions; ignored output is separate", (t) => {
	const repo = mkdtempSync(join(tmpdir(), "pi-source-inventory-"));
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	writeFileSync(join(repo, ".gitignore"), "ignored/\n", { mode: 0o644 });
	writeFileSync(join(repo, "source.ts"), "original\n", { mode: 0o644 });
	execFileSync("git", ["init", "--quiet"], { cwd: repo });
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture"], { cwd: repo });
	const digest = (bytes) => `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
	const clean = getGitSource(repo);
	assert.equal(clean.dirty, false);
	assert.equal(clean.tree_digest, digest(`${JSON.stringify([
		{ path: ".gitignore", digest: digest("ignored/\n"), executable: false },
		{ path: "source.ts", digest: digest("original\n"), executable: false },
	], null, 2)}\n`));
	mkdirSync(join(repo, "ignored"));
	writeFileSync(join(repo, "ignored", "output"), "packed separately");
	assert.deepEqual(getGitSource(repo), clean);
	writeFileSync(join(repo, "untracked.ts"), "new source\n");
	const added = getGitSource(repo);
	assert.equal(added.dirty, true);
	assert.notEqual(added.tree_digest, clean.tree_digest);
	execFileSync("git", ["add", "untracked.ts"], { cwd: repo });
	assert.deepEqual(getGitSource(repo), added);
	appendFileSync(join(repo, "untracked.ts"), "modified\n");
	const modified = getGitSource(repo);
	assert.notEqual(modified.tree_digest, added.tree_digest);
	chmodSync(join(repo, "source.ts"), 0o755);
	const executable = getGitSource(repo);
	assert.notEqual(executable.tree_digest, modified.tree_digest);
	rmSync(join(repo, "source.ts"));
	const deleted = getGitSource(repo);
	assert.notEqual(deleted.tree_digest, executable.tree_digest);
	assert.equal(deleted.tree_digest, digest(`${JSON.stringify([
		{ path: ".gitignore", digest: digest("ignored/\n"), executable: false },
		{ path: "source.ts", deleted: true },
		{ path: "untracked.ts", digest: digest("new source\nmodified\n"), executable: false },
	], null, 2)}\n`));
	// A dangling link is an invalid source file, never a tracked deletion.
	symlinkSync(join(repo, "absent"), join(repo, "source.ts"));
	assert.throws(() => getGitSource(repo), /regular files/);
	rmSync(join(repo, "source.ts"));
	mkdirSync(join(repo, "parent"));
	writeFileSync(join(repo, "parent", "nested.ts"), "tracked");
	execFileSync("git", ["add", "parent"], { cwd: repo });
	rmSync(join(repo, "parent"), { recursive: true });
	symlinkSync(join(repo, "ignored"), join(repo, "parent"));
	assert.throws(() => getGitSource(repo), /regular (files|directories)/);
});

test("two clean commits cannot bind stale dist to the second source", (t) => {
	const temporary = mkdtempSync(join(tmpdir(), "pi-build-binding-"));
	t.after(() => rmSync(temporary, { recursive: true, force: true }));
	const repoRoot = join(temporary, "repo");
	mkdirSync(repoRoot);
	writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: {
		clean: "node clean.cjs", build: "node build.cjs", "build:offline": "node build.cjs",
	} }));
	writeFileSync(join(repoRoot, ".gitignore"), "**/dist/\n");
	writeFileSync(join(repoRoot, "clean.cjs"), "require('node:fs').rmSync('packages/target/dist',{recursive:true,force:true});");
	writeFileSync(join(repoRoot, "build.cjs"), "const fs=require('node:fs');fs.mkdirSync('packages/target/dist');fs.copyFileSync('packages/target/source.js','packages/target/dist/index.js');");
	writePackage(join(repoRoot, "packages/target"), { name: "@pi-package-test/target", version: "1.0.0", files: ["dist"] },
		{ "source.js": "export const version = 'A';\n", "dist/index.js": "export const version = 'stale';\n" });
	const git = (...args) => execFileSync("git", args, { cwd: repoRoot });
	git("init", "--quiet"); git("add", ".");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "A");
	const first = produceArtifactSet({ repoRoot, outDir: join(temporary, "first"), offlineModelData: true });
	assert.equal(first.build.mode, "clean-source-snapshot");
	assert.equal(first.build.source_tree_digest, first.source.tree_digest);
	writeFileSync(join(repoRoot, "packages/target/source.js"), "export const version = 'B';\n");
	git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "B");
	const skipped = produceArtifactSet({ repoRoot, build: false, outDir: join(temporary, "skipped") });
	assert.equal(skipped.build.mode, "source-unbound");
	assert.equal(skipped.build.source_tree_digest, null);
	const second = produceArtifactSet({ repoRoot, outDir: join(temporary, "second"), offlineModelData: true });
	assert.notEqual(second.packages[0].integrity, first.packages[0].integrity);
	assert.match(execFileSync("tar", ["-xOf", second.packages[0].tarballPath, "package/dist/index.js"], { encoding: "utf8" }), /'B'/);
	// The maintainer's previous output is preserved; only our frozen build was cleaned.
	assert.match(readFileSync(join(repoRoot, "packages/target/dist/index.js"), "utf8"), /'stale'/);
	assert.match(readFileSync(new URL("./publish.mjs", import.meta.url), "utf8"), /produceArtifactSet\(\{ build: true, repoRoot \}\)/);
});
