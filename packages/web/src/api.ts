export interface TreeNode {
  name: string;
  path: string;
  kind: "directory" | "concept" | "reserved";
  type?: string;
  title?: string;
  description?: string;
  children?: TreeNode[];
}

export interface Concept {
  path: string;
  frontmatter: Record<string, unknown> & { type: string };
  body: string;
}

export interface SearchHit {
  path: string;
  type: string;
  title?: string;
  description?: string;
  snippet?: string;
}

export interface LogEntry {
  date: string;
  action: "Creation" | "Update" | "Deletion";
  summary: string;
}

export interface ConformanceReport {
  conformant: boolean;
  conceptCount: number;
  directoryCount: number;
  issues: { path: string; severity: "error" | "warning"; message: string }[];
}

export interface GraphNode {
  path: string;
  title?: string;
  type?: string;
  description?: string;
  links: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: { source: string; target: string }[];
}

export interface TraceStep {
  seq: number;
  tool: string;
  summary: string;
  paths: string[];
  write?: boolean;
}

export interface TraceSummary {
  id: string;
  kind: "query" | "mutation" | "chat";
  input: string;
  startedAt: string;
  durationMs: number;
  notation: string;
  stepCount: number;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface QueryTrace extends TraceSummary {
  steps: TraceStep[];
  answer: string;
}

/** Which memory this session is talking to. `profile` is null when the server hosts a single memory. */
export interface ProfileInfo {
  mode: "single" | "profiles";
  profile: string | null;
}

export interface AppConfig {
  model: string;
  format: "openai" | "anthropic" | string;
  fallbackConfigured: boolean;
}

/** A dream waiting on a dream/* branch for accept or reject (DREAM_MODE=review). */
export interface DreamReview {
  id: string;
  branch: string;
  createdAt: string;
  title: string;
  summary: string;
  filesChanged: string[];
  base: string;
  liveCommitsSince: number;
}

/** The parts of /api/dream/status the UI uses. */
export interface DreamStatus {
  enabled: boolean;
  interval: string | null;
  mode: string;
  running: boolean;
  nextRunAt: string | null;
  reviews: DreamReview[];
}

export type AcceptResult =
  | { ok: true; commit: string; filesChanged: string[]; revertCommand: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; conflicts: string[] }
  | { ok: false; reason: "forgotten"; files: string[]; message: string }
  | { ok: false; reason: "error"; message: string };

const TOKEN_KEY = "understory-token";

export function getAuthToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setAuthToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Headers for API calls — includes the bearer token when one is stored. */
export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** On a 401: whether the server wants a profile key or its single AUTH_TOKEN. */
    public readonly authMode?: ProfileInfo["mode"]
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Resolve an API path against the page URL so calls work when the UI is served
 * behind a path-prefixing reverse proxy (e.g. https://host/understory/), where
 * a root-absolute "/api/..." would escape the prefix. Matches how the page's
 * relative asset URLs resolve.
 */
export function apiUrl(path: string): string {
  return new URL(path.replace(/^\//, ""), document.baseURI).toString();
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(apiUrl(url), { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    let authMode: ProfileInfo["mode"] | undefined;
    try {
      const mode = (JSON.parse(body) as { mode?: unknown }).mode;
      if (mode === "single" || mode === "profiles") authMode = mode;
    } catch {
      // Not JSON: no mode to report.
    }
    throw new ApiError(res.status, `${res.status} ${body}`, authMode);
  }
  return res.json();
}

async function getText(url: string): Promise<string> {
  const res = await fetch(apiUrl(url), { headers: authHeaders() });
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${await res.text()}`);
  return res.text();
}

/** POST returning the JSON body for any status: callers branch on its own fields. */
async function post<T>(url: string): Promise<T> {
  const res = await fetch(apiUrl(url), { method: "POST", headers: authHeaders() });
  const body = await res.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new ApiError(res.status, `${res.status} ${body}`);
  }
}

export const api = {
  tree: () => get<TreeNode>("/api/tree"),
  concept: (path: string) => get<Concept>(`/api/concept?path=${encodeURIComponent(path)}`),
  search: (q: string) => get<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
  log: () => get<LogEntry[]>("/api/log"),
  validate: () => get<ConformanceReport>("/api/validate"),
  graph: () => get<GraphData>("/api/graph"),
  traces: () => get<TraceSummary[]>("/api/traces"),
  trace: (id: string) => get<QueryTrace>(`/api/trace?id=${encodeURIComponent(id)}`),
  config: () => get<AppConfig>("/api/config"),
  profile: () => get<ProfileInfo>("/api/profile"),
  dreamStatus: () => get<DreamStatus>("/api/dream/status"),
  reviewDiff: (id: string) => getText(`/api/dream/reviews/${encodeURIComponent(id)}/diff`),
  acceptReview: (id: string) => post<AcceptResult>(`/api/dream/reviews/${encodeURIComponent(id)}/accept`),
  rejectReview: (id: string) =>
    post<{ ok: true; rejected: string } | { error: string }>(`/api/dream/reviews/${encodeURIComponent(id)}/reject`),
};
