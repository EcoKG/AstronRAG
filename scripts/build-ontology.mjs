import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOntology } from "../dist/ontology.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function stable(value) {
	if (Array.isArray(value)) {
		const items = value.map(stable);
		return items.every((item) => item && typeof item === "object" && typeof item["@id"] === "string")
			? items.sort((a, b) => a["@id"].localeCompare(b["@id"]))
			: items.every((item) => typeof item === "string") ? items.sort() : items;
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
	}
	return value;
}

export function buildOntologyCache({ source = path.join(root, "ontology", "ontology.yaml"), target = path.join(root, "ontology", "ontology.json") } = {}) {
	const ontology = stable(parseOntology(fs.readFileSync(source, "utf8")));
	const temporary = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(ontology, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		fs.renameSync(temporary, target);
	} finally {
		if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildOntologyCache();
