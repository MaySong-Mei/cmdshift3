import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rename, access } from 'node:fs/promises';
import { join } from 'node:path';

const execute = promisify(execFile);
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function git(path, args, env = {}) {
  const { stdout } = await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: path, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}
async function optionalGit(path, args) { try { return await git(path, args); } catch { return null; } }
async function atomic(path, bytes) { const temp = `${path}.tmp`; await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, path); }

export async function openProjectGit(dataDir, projectId, configuredRemote) {
  const root = join(dataDir, 'projects', projectId);
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  await mkdir(repo, { recursive: true });
  if (!await exists(join(repo, '.git'))) {
    await git(repo, ['init', '--initial-branch=main']);
    await git(repo, ['config', 'user.name', 'CmdShift3']);
    await git(repo, ['config', 'user.email', 'commits@cmdshift3.local']);
  }
  if (!configuredRemote && !await exists(origin)) await git(root, ['init', '--bare', '--initial-branch=main', origin]);
  const remote = configuredRemote || origin;
  if (!await optionalGit(repo, ['remote', 'get-url', 'origin'])) await git(repo, ['remote', 'add', 'origin', remote]);
  else if (configuredRemote) await git(repo, ['remote', 'set-url', 'origin', configuredRemote]);

  async function synced(sha) {
    const remoteHead = await optionalGit(repo, ['ls-remote', 'origin', 'refs/heads/main']);
    const head = remoteHead?.split(/\s+/)[0];
    if (!head) return false;
    if (head === sha) return true;
    try { await git(repo, ['merge-base', '--is-ancestor', sha, head]); return true; } catch { return false; }
  }
  async function push() { try { await git(repo, ['push', 'origin', 'main']); return true; } catch { return false; } }
  return {
    repo, origin,
    push,
    async writeCommit(manifest, image) {
      const parent = await optionalGit(repo, ['rev-parse', '--verify', 'HEAD']);
      const relative = `deliverables/${manifest.id}`;
      const directory = join(repo, relative);
      await mkdir(directory, { recursive: true });
      await atomic(join(directory, 'capture.png'), image);
      await atomic(join(directory, 'annotations.json'), `${JSON.stringify(manifest.evidence.annotations, null, 2)}\n`);
      await atomic(join(directory, 'deliverable.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      await git(repo, ['add', '--', `${relative}/capture.png`, `${relative}/annotations.json`, `${relative}/deliverable.json`]);
      await git(repo, ['commit', '--only', '-m', `${manifest.author.name}: ${manifest.summary.slice(0, 120) || 'Work deliverable'}`, '--', `${relative}/capture.png`, `${relative}/annotations.json`, `${relative}/deliverable.json`], {
        GIT_AUTHOR_NAME: manifest.author.name,
        GIT_AUTHOR_EMAIL: `${manifest.author.id}@cmdshift3.local`,
        GIT_AUTHOR_DATE: manifest.created_at,
        GIT_COMMITTER_DATE: manifest.created_at,
      });
      const sha = await git(repo, ['rev-parse', 'HEAD']);
      const remote_synced = await push();
      return { sha, parent_sha: parent, branch: 'main', remote_synced };
    },
    async manifests() {
      const history = await optionalGit(repo, ['log', '--reverse', '--format=%H', 'main']);
      if (!history) return [];
      const records = [];
      const head = (await optionalGit(repo, ['ls-remote', 'origin', 'refs/heads/main']))?.split(/\s+/)[0];
      for (const sha of history.split('\n')) {
        const files = await git(repo, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', sha, '--', 'deliverables']);
        for (const file of files.split('\n').filter(file => /^deliverables\/wc_[0-9a-fA-F-]+\/deliverable\.json$/.test(file))) {
          const manifest = JSON.parse(await git(repo, ['show', `${sha}:${file}`]));
          const parents = (await git(repo, ['rev-list', '--parents', '-n', '1', sha])).split(' ');
          let remote_synced = false;
          if (head) { try { await git(repo, ['merge-base', '--is-ancestor', sha, head]); remote_synced = true; } catch { /* A failed push remains visible and can be retried. */ } }
          const { _request_hash, ...record } = manifest;
          records.push({ commit: { ...record, git: { sha, parent_sha: parents[1] ?? null, branch: 'main', remote_synced } }, hash: _request_hash });
        }
      }
      return records;
    },
    async readCapture(commit) { return Buffer.from((await execute('git', ['show', `${commit.git.sha}:deliverables/${commit.id}/capture.png`], { cwd: repo, encoding: 'buffer', maxBuffer: 9 * 1024 * 1024 })).stdout); },
    async isSynced(sha) { return synced(sha); },
  };
}
