import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = (await readFile(resolve(root, "VERSION"), "utf8")).trim();

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("VERSION must contain a valid semantic version.");
}

const packagePath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const packageLock = JSON.parse(await readFile(packageLockPath, "utf8"));

packageJson.version = version;
packageLock.version = version;
if (packageLock.packages?.[""]) packageLock.packages[""].version = version;

await Promise.all([
  writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`),
  writeFile(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`),
  writeFile(resolve(root, "public/version.txt"), `${version}\n`),
]);

console.log(`Project version synchronized: ${version}`);