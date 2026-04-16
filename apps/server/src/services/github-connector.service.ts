import { DataSource } from 'typeorm';
import { decrypt } from './encryption.service';

const GITHUB_API = 'https://api.github.com';

let _dataSource: DataSource | null = null;

export function setGitHubDataSource(ds: DataSource) {
  _dataSource = ds;
}

async function getGitHubToken(): Promise<string> {
  if (_dataSource?.isInitialized) {
    try {
      const repo = _dataSource.getRepository('SystemSetting');
      const row = await repo.findOne({ where: { key: 'github.token' } });
      const raw = (row as any)?.value || '';
      if (raw) return decrypt(raw);
    } catch {}
  }
  return process.env.GITHUB_TOKEN || '';
}

export async function isGitHubEnabled(): Promise<boolean> {
  const token = await getGitHubToken();
  return !!token;
}

async function githubFetch(path: string): Promise<any> {
  const token = await getGitHubToken();
  if (!token) throw new Error('GitHub token not configured');

  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'AWB-GitHub-Connector',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

export interface RepoInfo {
  full_name: string;
  description: string;
  html_url: string;
  default_branch: string;
  language: string;
  topics: string[];
  stargazers_count: number;
  updated_at: string;
  readme_content: string;
  file_tree: string[];
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/\s#?]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

export async function fetchRepoInfo(owner: string, repo: string): Promise<RepoInfo> {
  const repoData = await githubFetch(`/repos/${owner}/${repo}`);

  let readmeContent = '';
  try {
    const readmeRes = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/readme`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3.raw',
          'Authorization': `Bearer ${await getGitHubToken()}`,
          'User-Agent': 'AWB-GitHub-Connector',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (readmeRes.ok) {
      readmeContent = await readmeRes.text();
      if (readmeContent.length > 10000) {
        readmeContent = readmeContent.slice(0, 10000) + '\n\n[truncated]';
      }
    }
  } catch {}

  let fileTree: string[] = [];
  try {
    const treeData = await githubFetch(
      `/repos/${owner}/${repo}/git/trees/${repoData.default_branch}?recursive=1`,
    );
    if (treeData.tree) {
      fileTree = treeData.tree
        .filter((item: any) => item.type === 'blob')
        .map((item: any) => item.path)
        .slice(0, 500);
    }
  } catch {}

  let topics: string[] = [];
  try {
    const topicsData = await githubFetch(`/repos/${owner}/${repo}/topics`);
    topics = topicsData.names || [];
  } catch {}

  return {
    full_name: repoData.full_name,
    description: repoData.description || '',
    html_url: repoData.html_url,
    default_branch: repoData.default_branch,
    language: repoData.language || '',
    topics,
    stargazers_count: repoData.stargazers_count || 0,
    updated_at: repoData.updated_at,
    readme_content: readmeContent,
    file_tree: fileTree,
  };
}

export interface GitHubSearchResult {
  total_count: number;
  items: any[];
}

export async function searchGitHubRepos(query: string, opts?: { per_page?: number; sort?: string }): Promise<GitHubSearchResult> {
  const perPage = opts?.per_page ?? 10;
  const sort = opts?.sort ?? 'best-match';
  const qs = new URLSearchParams({ q: query, per_page: String(perPage), sort });
  const data = await githubFetch(`/search/repositories?${qs.toString()}`);
  return {
    total_count: data.total_count,
    items: (data.items || []).map((r: any) => ({
      full_name: r.full_name,
      description: r.description || '',
      html_url: r.html_url,
      language: r.language || '',
      stargazers_count: r.stargazers_count,
      topics: r.topics || [],
      updated_at: r.updated_at,
    })),
  };
}

export async function searchGitHubCode(query: string, opts?: { per_page?: number }): Promise<GitHubSearchResult> {
  const perPage = opts?.per_page ?? 10;
  const qs = new URLSearchParams({ q: query, per_page: String(perPage) });
  const data = await githubFetch(`/search/code?${qs.toString()}`);
  return {
    total_count: data.total_count,
    items: (data.items || []).map((r: any) => ({
      name: r.name,
      path: r.path,
      html_url: r.html_url,
      repository: r.repository?.full_name || '',
      score: r.score,
    })),
  };
}

export async function searchGitHubIssues(query: string, opts?: { per_page?: number; sort?: string }): Promise<GitHubSearchResult> {
  const perPage = opts?.per_page ?? 10;
  const sort = opts?.sort ?? 'best-match';
  const qs = new URLSearchParams({ q: query, per_page: String(perPage), sort });
  const data = await githubFetch(`/search/issues?${qs.toString()}`);
  return {
    total_count: data.total_count,
    items: (data.items || []).map((r: any) => ({
      title: r.title,
      html_url: r.html_url,
      state: r.state,
      labels: (r.labels || []).map((l: any) => l.name),
      user: r.user?.login || '',
      created_at: r.created_at,
      updated_at: r.updated_at,
      body: r.body ? r.body.slice(0, 500) : '',
    })),
  };
}

export function buildSyncContent(info: RepoInfo): string {
  const parts: string[] = [];
  parts.push(`# ${info.full_name}`);
  if (info.description) parts.push(`\n${info.description}`);
  parts.push(`\nURL: ${info.html_url}`);
  parts.push(`Branch: ${info.default_branch}`);
  if (info.language) parts.push(`Language: ${info.language}`);
  if (info.topics.length > 0) parts.push(`Topics: ${info.topics.join(', ')}`);
  parts.push(`Stars: ${info.stargazers_count}`);
  parts.push(`Updated: ${info.updated_at}`);

  if (info.readme_content) {
    parts.push(`\n---\n## README\n\n${info.readme_content}`);
  }

  if (info.file_tree.length > 0) {
    parts.push(`\n---\n## File Tree (${info.file_tree.length} files)\n`);
    parts.push(info.file_tree.join('\n'));
  }

  return parts.join('\n');
}
