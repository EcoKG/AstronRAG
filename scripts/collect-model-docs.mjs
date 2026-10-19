import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { collectOfficialModels, diffOfficialModels } from "../dist/model-docs.js";
import { parseOntology } from "../dist/ontology.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function workspacePath(value, label) {
	const resolved = path.resolve(value);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} must be inside workspace`);
	return resolved;
}

function option(name, fallback) {
	const index = process.argv.indexOf(name);
	return index < 0 ? fallback : process.argv[index + 1];
}

const docsDir = option("--docs-dir", path.join(root, "test", "fixtures", "official-docs"));
const ontologyFile = workspacePath(option("--ontology", path.join(root, "ontology", "ontology.yaml")), "ontology path");
const checkedAt = option("--checked-at", undefined);
const write = process.argv.includes("--write");
const check = process.argv.includes("--check");

try {
	if (write === check) throw new Error("choose exactly one of --check or --write");
	const collected = collectOfficialModels(docsDir, root);
	if (checkedAt && collected.some((model) => model.sources.some((source) => source.checkedAt !== checkedAt))) throw new Error("fixture Checked-At does not match --checked-at");
	const source = fs.readFileSync(ontologyFile, "utf8");
	const current = parseOntology(source);
	const diffs = diffOfficialModels(current.models, collected);
	process.stdout.write(`${JSON.stringify(diffs, null, 2)}\n`);
	if (write && diffs.length > 0) {
		const dumpedModels = yaml.dump({ models: collected }, { noRefs: true, sortKeys: true, lineWidth: 120 });
		const modelStart = source.indexOf("models:\n");
		const modelEnd = source.indexOf("efforts:\n", modelStart);
		if (modelStart < 0 || modelEnd < 0) throw new Error("ontology model section is missing");
		const updated = `${source.slice(0, modelStart)}${dumpedModels}${source.slice(modelEnd)}`;
		const temporary = `${ontologyFile}.tmp-${process.pid}`;
		try {
			fs.writeFileSync(temporary, updated, { encoding: "utf8", flag: "wx" });
			parseOntology(fs.readFileSync(temporary, "utf8"));
			fs.renameSync(temporary, ontologyFile);
		} finally {
			if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
		}
	}
	if (check && diffs.length > 0) process.exitCode = 1;
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
