import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostPackageName = "@earendil-works/pi-coding-agent";
const hostPackageTarget = join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const command = process.argv[2];
const commandArgs = process.argv.slice(3);

if (!command) {
  console.error("Usage: node scripts/with-pi-host.mjs <command> [args...]");
  process.exit(2);
}

function readPackage(path) {
  try {
    const value = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function findPackageRoot(startPath) {
  let current = resolve(startPath);
  if (!existsSync(current)) return undefined;
  if (!lstatSync(current).isDirectory()) current = dirname(current);
  for (let depth = 0; depth < 12; depth += 1) {
    const manifest = readPackage(current);
    if (manifest?.name === hostPackageName && typeof manifest.version === "string") return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function commandOutput(name, args) {
  try {
    return execFileSync(name, args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function findCommandOnPath(name) {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function findHostPackage() {
  const candidates = [];
  if (process.env.PI_HOST_PACKAGE) candidates.push({ value: process.env.PI_HOST_PACKAGE, allowProjectLocal: true });

  const voltaPi = commandOutput("volta", ["which", "pi"]);
  if (voltaPi) candidates.push({ value: voltaPi, allowProjectLocal: false });

  const pathPi = findCommandOnPath("pi");
  if (pathPi) candidates.push({ value: pathPi, allowProjectLocal: false });

  const npmRoot = commandOutput("npm", ["root", "-g"]);
  if (npmRoot) candidates.push({ value: join(npmRoot, "@earendil-works", "pi-coding-agent"), allowProjectLocal: false });

  for (const candidate of candidates) {
    let packageRoot;
    try {
      packageRoot = findPackageRoot(realpathSync(candidate.value));
    } catch {
      packageRoot = findPackageRoot(candidate.value);
    }
    if (!packageRoot) continue;
    const projectRelative = relative(projectRoot, packageRoot);
    const isProjectLocal = projectRelative === "node_modules" || projectRelative.startsWith(`node_modules${sep}`);
    if (!candidate.allowProjectLocal && isProjectLocal) continue;
    return packageRoot;
  }
  return undefined;
}

const hostPackageRoot = findHostPackage();
if (!hostPackageRoot) {
  console.error(`Unable to find the installed Pi host package (${hostPackageName}).`);
  console.error("Install Pi first, or set PI_HOST_PACKAGE to the Pi package directory.");
  process.exit(1);
}

mkdirSync(dirname(hostPackageTarget), { recursive: true });
let targetIsCorrect = false;
try {
  targetIsCorrect = realpathSync(hostPackageTarget) === realpathSync(hostPackageRoot);
} catch {
  targetIsCorrect = false;
}
if (!targetIsCorrect) {
  rmSync(hostPackageTarget, { recursive: true, force: true });
  symlinkSync(hostPackageRoot, hostPackageTarget, "dir");
}

execFileSync(command, commandArgs, {
  cwd: projectRoot,
  stdio: "inherit",
  env: process.env,
});
