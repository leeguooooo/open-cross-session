import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function prepareRelease(packageText: string, cli: string, changelog: string, latestTag: string) {
  const section = /^## Unreleased\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(changelog);
  if (!section) throw new Error("CHANGELOG.md must contain ## Unreleased");
  if (!section[1]!.trim()) return null;
  const pkg = JSON.parse(packageText);
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
  if (!version || latestTag !== `v${pkg.version}`) {
    throw new Error("package.json must match the latest stable tag before an automatic patch release");
  }
  const declaration = `export const OCS_VERSION = "${pkg.version}";`;
  if (!cli.includes(declaration)) throw new Error("OCS_VERSION must match package.json");
  const next = `${version[1]}.${version[2]}.${Number(version[3]) + 1}`;
  if (new RegExp(`^## (?:v)?${next.replaceAll('.', '\\.')}\\s*$`, 'm').test(changelog)) {
    throw new Error("Next release already exists in CHANGELOG.md");
  }
  pkg.version = next;
  return {
    tag: `v${next}`,
    packageText: JSON.stringify(pkg, null, 2) + "\n",
    cli: cli.replace(declaration, `export const OCS_VERSION = "${next}";`),
    changelog: changelog.replace(section[0], `## Unreleased\n\n## ${next}\n${section[1]}`),
  };
}

if (import.meta.main) {
  const latest = execFileSync("git", ["tag", "--list", "v*", "--sort=-version:refname"], { encoding: "utf8" })
    .split("\n").find((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  if (!latest) throw new Error("No stable release tag found");
  const result = prepareRelease(readFileSync("package.json", "utf8"), readFileSync("src/cli.ts", "utf8"),
    readFileSync("CHANGELOG.md", "utf8"), latest);
  if (result) {
    writeFileSync("package.json", result.packageText);
    writeFileSync("src/cli.ts", result.cli);
    writeFileSync("CHANGELOG.md", result.changelog);
    console.log(result.tag);
  } else console.log("No unreleased changes; skipping release");
}
