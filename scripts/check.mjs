import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));

function modules(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return modules(path);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [path] : [];
  });
}

const files = [
  join(root, "index.mjs"),
  ...["src", "tests", "scripts"].flatMap((directory) => modules(join(root, directory))),
].toSorted();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checked ${files.length} modules: index.mjs, src/, tests/ and scripts/.`);
