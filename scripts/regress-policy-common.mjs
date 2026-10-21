import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export { assert, fs, os, path };
export const root = path.resolve(import.meta.dirname, "..");
export const ontology = () => JSON.parse(fs.readFileSync(path.join(root, "ontology/ontology.json"), "utf8"));
export const payload = (result) => {
	assert.notEqual(result.isError, true, result.content?.[0]?.text);
	return JSON.parse(result.content[0].text);
};
export async function server(action, overrides = {}, blockNetwork = false) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "astron-policy-"));
	const ontologyPath = path.join(directory, "ontology.json");
	fs.writeFileSync(ontologyPath, JSON.stringify(ontology()));
	const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(ASTRONRAG_|BBM_|BIGBRAIN_)/.test(key)));
	Object.assign(env, { ASTRONRAG_VAULT: path.join(directory, "vault"), ASTRONRAG_SQLITE_PATH: path.join(directory, "store.sqlite"), ASTRONRAG_STORE: "sqlite", ASTRONRAG_ONTOLOGY_PATH: ontologyPath, ...overrides });
	const client = new Client({ name: "policy-regression", version: "1" });
	const args = [path.join(root, "dist/index.js")];
	if (blockNetwork) {
		const preload = path.join(directory, "block-network.mjs");
		fs.writeFileSync(preload, "import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; const blocked = () => { throw new Error('network forbidden in policy test'); }; globalThis.fetch = blocked; http.get = http.request = https.get = https.request = net.connect = net.createConnection = blocked;\n");
		args.unshift("--import", pathToFileURL(preload).href);
	}
	try {
		await client.connect(new StdioClientTransport({ command: process.execPath, args, cwd: root, env, stderr: "pipe" }));
		await action({ client, directory, ontologyPath, env, call: (name, args = {}) => client.callTool({ name, arguments: args }) });
	} finally {
		try { await client.close(); }
		finally { fs.rmSync(directory, { recursive: true, force: true }); }
	}
	assert.equal(fs.existsSync(directory), false);
}
export async function test(name, run) {
	try { await run(); console.log(`PASS ${name}`); }
	catch (error) { console.error(`FAIL ${name}: ${error.stack ?? error}`); process.exitCode = 1; }
}
