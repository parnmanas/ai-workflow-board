import { guardedFetch } from '../../common/ssrf-guard';

export interface MigrationSourceTableMeta {
  entity: string;
  table: string;
  row_count: number;
}

export interface MigrationSourceMeta {
  app_version: string;
  commit_sha: string;
  schema_fingerprint: string;
  tables: MigrationSourceTableMeta[];
}

export interface MigrationTablePage {
  rows: Record<string, any>[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * 소스 서버의 migration export 엔드포인트를 부르는 얇은 HTTP 클라이언트
 * (ticket 0f638509). `source_url`은 admin이 자유롭게 입력하는 값이라
 * workflow-functions.service.ts의 http executor와 같은 SSRF 노출 표면이다 —
 * 그래서 일반 fetch가 아니라 common/ssrf-guard.ts의 guardedFetch(스킴
 * allowlist + loopback/링크로컬/RFC1918/CGNAT 차단 + 리다이렉트 매 홉
 * 재검증)를 그대로 재사용한다. 이 가드는 루프백을 예외 없이 차단하므로
 * (ssrf-guard.test.mjs 참고 — 테스트용 우회 없음), 이 클라이언트를 쓰는
 * 테스트는 실제 로컬 서버 2개를 띄워 통신시키는 대신 이 클래스 자체를
 * stub/mock으로 대체해 MigrationRunService의 pull-loop 로직만 검증한다.
 */
export class MigrationSourceClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async getMeta(): Promise<MigrationSourceMeta> {
    return this._get<MigrationSourceMeta>('/api/migration/export/meta');
  }

  async getTablePage(entity: string, after: string | null, limit = 500): Promise<MigrationTablePage> {
    const query: Record<string, string> = { limit: String(limit) };
    if (after) query.after = after;
    return this._get<MigrationTablePage>(`/api/migration/export/table/${encodeURIComponent(entity)}`, query);
  }

  private async _get<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }
    let res: Response;
    try {
      res = await guardedFetch(url.toString(), { method: 'GET', headers: { 'X-Agent-Key': this.token } });
    } catch (e: any) {
      throw new Error(`Migration source unreachable at ${this.baseUrl} (${path}): ${e?.message || e}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Migration source request failed (${res.status} ${path}): ${body.slice(0, 500)}`);
    }
    return res.json() as Promise<T>;
  }
}
