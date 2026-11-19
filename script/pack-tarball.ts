import { $ } from "bun"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")

// Tarballs land outside dist, which the build wipes and the package publishes.
export const npmDir = path.join(root, ".pack")

/** Builds the package and packs it into .pack as `<name>-<version>.tgz`. */
export async function pack() {
  // SAFETY: the manifest declares a name and a version.
  const pkg = (await Bun.file(path.join(root, "package.json")).json()) as { name: string; version: string }
  const tarball = path.join(npmDir, `${pkg.name}-${pkg.version}.tgz`)

  await $`bun run build`.cwd(root)
  await rm(npmDir, { recursive: true, force: true })
  await mkdir(npmDir, { recursive: true })
  await $`bun pm pack --destination ${npmDir}`.cwd(root)

  if (!(await Bun.file(tarball).exists())) throw new Error(`Expected ${tarball}`)
  return tarball
}
