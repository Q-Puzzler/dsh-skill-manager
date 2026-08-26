/**
 * Registry — the plugin's record of Managed Skills (ADR-0002, CONTEXT.md).
 * One JSON file per Managed Skill in a dedicated directory inside the Skills
 * Directory (`<skillsDir>/.skill-manager/<skillId>.json`), verified invisible
 * to dsh discovery and its watcher. The Registry is the sole authority for
 * "managed by this plugin": Unmanaged directories never get a record.
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Registry directory name inside the Skills Directory (no SKILL.md → skipped by dsh). */
export const REGISTRY_DIR = '.skill-manager'

/** One Managed Skill's metadata record. */
export interface RegistryRecord {
  /** Source the Skill was installed from (`owner/repo`). */
  source: string
  skillId: string
  /** Repo-relative Skill path found at install time (`skills/<id>`, `<id>`, or '' for repo root). */
  skillPath: string
  /** ISO 8601 install time. */
  installedAt: string
  /** Last Source commit touching skillPath at install time (update detection). */
  commitSha: string
  /** sha256 over sorted relative paths + file contents (local-modification detection). */
  contentHash: string
}

export function registryDir(skillsDir: string): string {
  return join(skillsDir, REGISTRY_DIR)
}

export function recordPath(skillsDir: string, skillId: string): string {
  return join(registryDir(skillsDir), `${skillId}.json`)
}

/**
 * Read one record; missing files, parse failures, and malformed shapes all
 * collapse to undefined (the caller treats them as "not managed").
 */
export async function readRecord(skillsDir: string, skillId: string): Promise<RegistryRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(recordPath(skillsDir, skillId), 'utf8')
  } catch {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(raw)
    return isRegistryRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** All records, sorted by Skill ID; unreadable or malformed files are skipped. */
export async function listRecords(skillsDir: string): Promise<RegistryRecord[]> {
  let names: string[]
  try {
    names = await readdir(registryDir(skillsDir))
  } catch {
    return []
  }
  const records: RegistryRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const record = await readRecord(skillsDir, name.slice(0, -'.json'.length))
    if (record !== undefined) records.push(record)
  }
  records.sort((a, b) => a.skillId.localeCompare(b.skillId))
  return records
}

/** Write a record atomically (temp file + rename inside the registry dir). */
export async function writeRecord(skillsDir: string, record: RegistryRecord): Promise<void> {
  const dir = registryDir(skillsDir)
  await mkdir(dir, { recursive: true })
  const target = recordPath(skillsDir, record.skillId)
  const temp = join(dir, `.${record.skillId}.json.tmp-${process.pid}`)
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  await rename(temp, target)
}

function isRegistryRecord(value: unknown): value is RegistryRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.source === 'string' &&
    typeof record.skillId === 'string' &&
    typeof record.skillPath === 'string' &&
    typeof record.installedAt === 'string' &&
    typeof record.commitSha === 'string' &&
    typeof record.contentHash === 'string'
  )
}
