import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { execNpmSync } from "./npm-command.mjs";
import { checkDeclarationJsonImports } from "./declaration-json-imports.mjs";

const manifestSchemaVersion = 2;

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function sourceSnapshot(repoRoot) {
	repoRoot = resolve(repoRoot);
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
	const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
	const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
	}).split("\0").filter(Boolean);
	const rows = [...new Set(files)].sort().map((name) => {
		const path = join(repoRoot, name);
		// Check ancestors too: a replaced tracked directory must not redirect a
		// source receipt to files outside the checkout.
		for (let parent = dirname(path); parent !== repoRoot; parent = dirname(parent)) {
			const info = lstatSync(parent, { throwIfNoEntry: false });
			if (info && !info.isDirectory()) throw new Error("Source inventory requires regular directories");
		}
		const info = lstatSync(path, { throwIfNoEntry: false });
		if (!info) return { path: name, deleted: true };
		if (!info.isFile()) throw new Error("Source inventory requires regular files");
		return { path: name, digest: `sha256-${createHash("sha256").update(readFileSync(path)).digest("base64")}`,
			executable: !!(info.mode & 0o111) };
	});
	// Quant's consumer independently recomputes this canonical source inventory.
	// Ignored build/model data is covered by the tarball hashes, not this digest.
	const tree_digest = `sha256-${createHash("sha256").update(`${JSON.stringify(rows, null, 2)}\n`).digest("base64")}`;
	return { source: { commit, dirty: status.length > 0, tree_digest }, rows };
}

export function getGitSource(repoRoot) {
	return sourceSnapshot(repoRoot).source;
}

// Compile a byte-verified frozen source copy. Workspace dependency symlinks are
// copied verbatim and resolve into the copy's packages, never old host dist.
function frozenBuild(root, snapshot, offlineModelData) {
	const stage = mkdtempSync(join(tmpdir(), "pi-frozen-build-"));
	try {
		for (const row of snapshot.rows) {
			if (row.deleted) continue;
			const target = join(stage, row.path);
			mkdirSync(dirname(target), { recursive: true });
			cpSync(join(root, row.path), target);
			const digest = `sha256-${createHash("sha256").update(readFileSync(target)).digest("base64")}`;
			if (!lstatSync(target).isFile() || digest !== row.digest || !!(lstatSync(target).mode & 0o111) !== row.executable) {
				throw new Error("Source changed while freezing build inputs");
			}
		}
		if (existsSync(join(root, "node_modules"))) {
			cpSync(join(root, "node_modules"), join(stage, "node_modules"), { recursive: true, verbatimSymlinks: true });
		}
		for (const row of snapshot.rows) {
			if (!row.path.endsWith("/package.json")) continue;
			const modules = join(dirname(row.path), "node_modules");
			if (existsSync(join(root, modules))) cpSync(join(root, modules), join(stage, modules), { recursive: true, verbatimSymlinks: true });
		}
		// Offline builds require the reviewed, already hydrated catalog. It is
		// an explicit extra build input, not part of the Git tree digest.
		const hydrated = "packages/ai/src/providers/data";
		if (offlineModelData && existsSync(join(root, hydrated))) {
			cpSync(join(root, hydrated), join(stage, hydrated), { recursive: true, verbatimSymlinks: true });
		}
		execNpmSync(["run", "clean"], { cwd: stage, stdio: "inherit" });
		execNpmSync(["run", offlineModelData ? "build:offline" : "build"], { cwd: stage, stdio: "inherit" });
		for (const row of snapshot.rows) {
			if (row.deleted) continue;
			const file = join(stage, row.path);
			const digest = `sha256-${createHash("sha256").update(readFileSync(file)).digest("base64")}`;
			if (digest !== row.digest) throw new Error("Build changed frozen source; review generated source and rebuild");
		}
		return stage;
	} catch (error) {
		rmSync(stage, { recursive: true, force: true });
		throw error;
	}
}

function packPackages(packages, tarballDirectory, repoRoot) {
	mkdirSync(tarballDirectory, { recursive: true });
	const notices = ["LICENSE", "NOTICE"].filter((name) => existsSync(join(repoRoot, name)))
		.map((name) => [name, readFileSync(join(repoRoot, name))]);
	const packedPackages = [];
	for (const pkg of packages) {
		const packageJson = JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"));
		if (packageJson.name !== pkg.name) throw new Error(`Unexpected package name in ${pkg.directory}`);
		if (pkg.name === "@earendil-works/pi-ai") checkDeclarationJsonImports(pkg.directory);
		// npm pack does not inherit the workspace root license. dist is shipped
		// by every public package; each standalone artifact keeps its notices.
		const dist = join(pkg.directory, "dist");
		if (notices.length && !lstatSync(dist).isDirectory()) throw new Error("Package dist must be a regular directory");
		for (const [name, bytes] of notices) {
			const temporary = join(dist, `.pi-notice-${randomUUID()}`);
			try {
				writeFileSync(temporary, bytes, { flag: "wx" });
				renameSync(temporary, join(dist, name));
			} finally {
				rmSync(temporary, { force: true });
			}
		}
		const output = execNpmSync(["pack", "--ignore-scripts", "--json", "--pack-destination", tarballDirectory], {
			cwd: pkg.directory,
			encoding: "utf8",
			stdio: ["inherit", "pipe", "inherit"],
		});
		const parsed = JSON.parse(output);
		const packed = Array.isArray(parsed) ? (parsed.length === 1 ? parsed[0] : undefined) : parsed?.[pkg.name];
		if (packed?.name !== pkg.name || typeof packed.filename !== "string") {
			throw new Error(`npm pack returned an unexpected result for ${pkg.name}`);
		}
		for (const [name] of notices) {
			if (!packed.files.some((file) => file.path === `dist/${name}`)) {
				throw new Error(`Package omitted ${name}: ${pkg.name}`);
			}
		}

		const originalPath = join(tarballDirectory, packed.filename);
		const contents = readFileSync(originalPath);
		const digest = createHash("sha512").update(contents).digest();
		const hash = digest.toString("hex").slice(0, 12);
		const tarballPath = originalPath.replace(/\.tgz$/, `-${hash}.tgz`);
		renameSync(originalPath, tarballPath);
		console.log(
			`  ${pkg.name}@${pkg.version}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`,
		);
		packedPackages.push({
			name: pkg.name,
			version: pkg.version,
			tarballPath,
			integrity: `sha512-${digest.toString("base64")}`,
		});
	}
	return packedPackages;
}

function prepareOutputDirectory(outDir, options) {
	const repoRoot = resolve(options.repoRoot);
	if (!outDir) return mkdtempSync(join(tmpdir(), "pi-package-artifacts-"));
	const outputDirectory = resolve(outDir);
	if (dirname(outputDirectory) === outputDirectory || isInsidePath(repoRoot, outputDirectory)) {
		throw new Error(`Output directory must not be the repository, its ancestor, or a filesystem root: ${outputDirectory}`);
	}
	if (isInsidePath(outputDirectory, repoRoot) && !isInsidePath(outputDirectory, join(repoRoot, ".artifacts"))) {
		throw new Error(`Repository-local output directory must be inside ${join(repoRoot, ".artifacts")}: ${outputDirectory}`);
	}
	if (existsSync(outputDirectory)) {
		if (!options.force) throw new Error(`Output directory already exists. Use --force to replace it: ${outputDirectory}`);
		rmSync(outputDirectory, { force: true, recursive: true });
	}
	mkdirSync(outputDirectory, { recursive: true });
	return outputDirectory;
}

export function produceArtifactSet({ repoRoot, outDir, build = true, offlineModelData = false, force = false, source }) {
	const root = resolve(repoRoot);
	if (build && source !== undefined) throw new Error("Bound builds cannot override their source identity");
	const snapshot = source === undefined ? sourceSnapshot(root) : { source };
	const artifactDirectory = prepareOutputDirectory(outDir, { force, repoRoot: root });
	let buildRoot = root;
	try {
		if (build) buildRoot = frozenBuild(root, snapshot, offlineModelData);
		const packages = getPublicWorkspacePackages(join(buildRoot, "packages"));
		const packedPackages = packPackages(packages, join(artifactDirectory, "tarballs"), buildRoot);
		const manifest = {
			schemaVersion: manifestSchemaVersion,
			source: snapshot.source,
			build: { mode: build ? "clean-source-snapshot" : "source-unbound",
				source_tree_digest: build ? snapshot.source.tree_digest : null,
				offline_model_data: offlineModelData, node_version: process.version },
			packages: packedPackages
				.map(({ name, version, tarballPath, integrity }) => ({ name, version,
					tarball: relative(artifactDirectory, tarballPath).replaceAll("\\", "/"), integrity }))
				.sort((left, right) => left.name.localeCompare(right.name)),
		};
		const manifestPath = join(artifactDirectory, "manifest.json");
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		return readArtifactSet(manifestPath);
	} finally {
		if (buildRoot !== root) rmSync(buildRoot, { recursive: true, force: true });
	}
}

export function readArtifactSet(manifestPath) {
	const absoluteManifestPath = resolve(manifestPath);
	const artifactDirectory = dirname(absoluteManifestPath);
	const manifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));
	if (manifest.schemaVersion !== manifestSchemaVersion || !Array.isArray(manifest.packages)) {
		throw new Error(`Unsupported package artifact manifest: ${absoluteManifestPath}`);
	}
	const names = new Set();
	const packages = manifest.packages.map((pkg) => {
		if (
			typeof pkg?.name !== "string" ||
			typeof pkg.version !== "string" ||
			typeof pkg.tarball !== "string" ||
			typeof pkg.integrity !== "string"
		) {
			throw new Error(`Invalid package entry in artifact manifest: ${absoluteManifestPath}`);
		}
		if (names.has(pkg.name)) throw new Error(`Duplicate package in artifact manifest: ${pkg.name}`);
		names.add(pkg.name);
		const tarballPath = resolve(artifactDirectory, pkg.tarball);
		if (!isInsidePath(tarballPath, artifactDirectory) || !existsSync(tarballPath)) {
			throw new Error(`Missing package tarball for ${pkg.name}: ${tarballPath}`);
		}
		const integrity = `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`;
		if (integrity !== pkg.integrity) throw new Error(`Package tarball integrity mismatch for ${pkg.name}: ${tarballPath}`);
		return { ...pkg, tarballPath };
	});
	return {
		artifactDirectory,
		manifestPath: absoluteManifestPath,
		packages,
		source: manifest.source,
		build: manifest.build,
		getPackage(name) {
			const pkg = packages.find((candidate) => candidate.name === name);
			if (!pkg) throw new Error(`Package is not present in the artifact set: ${name}`);
			return pkg;
		},
	};
}
