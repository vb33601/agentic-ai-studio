/**
 * Minimal GitHub client to create a repo and push a set of files in a single
 * commit (Git Data API). Used by the "Deploy backend → Render" flow, because
 * Render builds from a Git repo, not inline files.
 *
 * Server-only: requires GITHUB_TOKEN (repo scope).
 */

const API = "https://api.github.com";

export interface RepoFile {
  path: string;
  content: string;
}

interface PushResult {
  owner: string;
  repo: string;
  htmlUrl: string;
  cloneUrl: string;
  branch: string;
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

export async function gh<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...authHeaders(token), ...(init?.headers || {}) } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = data.errors ? ` (${data.errors.map((e: { message?: string; code?: string }) => e.message || e.code).join("; ")})` : "";
    throw new Error(`GitHub ${path} → ${res.status}: ${data.message || text}${detail}`.slice(0, 400));
  }
  return data as T;
}

/** Create a repo (or reuse if it exists) and push all files as one commit on `main`. */
export async function createRepoAndPush(
  token: string,
  name: string,
  files: RepoFile[],
  opts: { private?: boolean; description?: string } = {},
): Promise<PushResult> {
  const me = await gh<{ login: string }>(token, "/user");
  const owner = me.login;

  // Create the repo (auto_init so a base branch/commit exists). Reuse on 422.
  let repo = name;
  try {
    const created = await gh<{ name: string }>(token, "/user/repos", {
      method: "POST",
      body: JSON.stringify({
        name,
        private: opts.private ?? true,
        auto_init: true,
        description: opts.description || "Deployed from agentic-ai-studio",
      }),
    });
    repo = created.name;
  } catch (e) {
    if (!/already exists/i.test(String(e))) throw e;
  }

  // Default branch + its head commit (auto_init created one).
  const repoInfo = await gh<{ default_branch: string }>(token, `/repos/${owner}/${repo}`);
  const branch = repoInfo.default_branch || "main";
  const ref = await gh<{ object: { sha: string } }>(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  const baseSha = ref.object.sha;
  const baseCommit = await gh<{ tree: { sha: string } }>(token, `/repos/${owner}/${repo}/git/commits/${baseSha}`);

  // One tree with every file inlined, a commit, then move the branch ref.
  const tree = await gh<{ sha: string }>(token, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
      tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
    }),
  });
  const commit = await gh<{ sha: string }>(token, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: "Deploy from agentic-ai-studio", tree: tree.sha, parents: [baseSha] }),
  });
  await gh(token, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });

  return {
    owner,
    repo,
    branch,
    htmlUrl: `https://github.com/${owner}/${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

/**
 * Add (or overwrite) a set of files in an existing repo as one additional commit
 * on `branch`. Used by the Fly provider to drop a `fly.toml` + deploy workflow
 * into a repo that was already pushed by {@link createRepoAndPush}, without
 * re-pushing the whole project.
 */
export async function commitFilesToRepo(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  files: RepoFile[],
  message = "Add Fly.io deploy config",
): Promise<{ commitSha: string }> {
  const ref = await gh<{ object: { sha: string } }>(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  const baseSha = ref.object.sha;
  const baseCommit = await gh<{ tree: { sha: string } }>(token, `/repos/${owner}/${repo}/git/commits/${baseSha}`);

  const tree = await gh<{ sha: string }>(token, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
      tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
    }),
  });
  const commit = await gh<{ sha: string }>(token, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [baseSha] }),
  });
  await gh(token, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return { commitSha: commit.sha };
}
