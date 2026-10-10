import type { SupabaseClient } from '@supabase/supabase-js';

export interface InMemoryDb {
  videos: Record<string, any>[];
  video_assets: Record<string, any>[];
  yt_provider_configs: Record<string, any>[];
  yt_stage_bindings: Record<string, any>[];
  yt_jobs: Record<string, any>[];
  yt_job_stages: Record<string, any>[];
  yt_job_units: Record<string, any>[];
  narrators: Record<string, any>[];
  style_narrator_defaults: Record<string, any>[];
  vault_secrets: Record<string, string>;
  simulateUpdateError?: { table?: string; error: Error } | null;
}

export function createMockSupabase(initialData?: Partial<InMemoryDb>): {
  supabase: SupabaseClient;
  db: InMemoryDb;
} {
  const db: InMemoryDb = {
    videos: initialData?.videos ? [...initialData.videos] : [],
    video_assets: initialData?.video_assets ? [...initialData.video_assets] : [],
    yt_provider_configs: initialData?.yt_provider_configs ? [...initialData.yt_provider_configs] : [],
    yt_stage_bindings: initialData?.yt_stage_bindings ? [...initialData.yt_stage_bindings] : [],
    yt_jobs: initialData?.yt_jobs ? [...initialData.yt_jobs] : [],
    yt_job_stages: initialData?.yt_job_stages ? [...initialData.yt_job_stages] : [],
    yt_job_units: initialData?.yt_job_units ? [...initialData.yt_job_units] : [],
    narrators: initialData?.narrators ? [...initialData.narrators] : [],
    style_narrator_defaults: initialData?.style_narrator_defaults ? [...initialData.style_narrator_defaults] : [],
    vault_secrets: initialData?.vault_secrets ? { ...initialData.vault_secrets } : {},
    simulateUpdateError: null,
  };

  const client: any = {
    rpc: async (fnName: string, params: any) => {
      if (fnName === 'yt_read_vault_secret') {
        const secret = db.vault_secrets[params.secret_id];
        if (!secret) {
          return { data: null, error: { message: `Secret not found: ${params.secret_id}` } };
        }
        return { data: secret, error: null };
      }
      if (fnName === 'yt_claim_next_job') {
        const queuedJobIndex = db.yt_jobs.findIndex((j) => j.status === 'queued');
        if (queuedJobIndex === -1) {
          return { data: null, error: null };
        }
        db.yt_jobs[queuedJobIndex].status = 'running';
        db.yt_jobs[queuedJobIndex].updated_at = new Date().toISOString();
        return { data: [db.yt_jobs[queuedJobIndex]], error: null };
      }
      return { data: null, error: { message: `Unknown RPC ${fnName}` } };
    },
    from: (table: string) => {
      const records = (db as any)[table] as Record<string, any>[];
      if (!records) {
        throw new Error(`Mock table "${table}" does not exist in mock DB`);
      }

      let filtered = [...records];

      const queryBuilder: any = {
        select: (_cols?: string) => {
          return queryBuilder;
        },
        eq: (col: string, val: any) => {
          filtered = filtered.filter((r) => r[col] === val);
          return queryBuilder;
        },
        in: (col: string, vals: any[]) => {
          filtered = filtered.filter((r) => vals.includes(r[col]));
          return queryBuilder;
        },
        order: (col: string, { ascending = true } = {}) => {
          filtered.sort((a, b) => {
            if (a[col] < b[col]) return ascending ? -1 : 1;
            if (a[col] > b[col]) return ascending ? 1 : -1;
            return 0;
          });
          return queryBuilder;
        },
        limit: (n: number) => {
          filtered = filtered.slice(0, n);
          return queryBuilder;
        },
        single: async () => {
          if (filtered.length === 0) {
            return { data: null, error: { message: 'Row not found' } };
          }
          return { data: resolveJoins(filtered[0], table, db), error: null };
        },
        maybeSingle: async () => {
          if (filtered.length === 0) {
            return { data: null, error: null };
          }
          return { data: resolveJoins(filtered[0], table, db), error: null };
        },
        then: (resolve: (res: any) => void) => {
          const joined = filtered.map((r) => resolveJoins(r, table, db));
          resolve({ data: joined, error: null });
        },
        insert: (rowOrRows: any) => {
          const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
          const inserted: any[] = [];
          for (const r of rows) {
            const newRow = { id: r.id || `mock-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`, ...r };
            records.push(newRow);
            inserted.push(newRow);
          }
          const insertChain: any = {
            select: () => insertChain,
            single: async () => ({ data: inserted[0], error: null }),
            maybeSingle: async () => ({ data: inserted[0] || null, error: null }),
            then: (resolve: (res: any) => void) => resolve({ data: inserted, error: null }),
          };
          return insertChain;
        },
        upsert: async (row: any, options?: { onConflict?: string }) => {
          const onConflict = options?.onConflict?.split(',') || ['id'];
          const matchIndex = records.findIndex((r) =>
            onConflict.every((k) => r[k.trim()] === row[k.trim()]),
          );

          if (matchIndex >= 0) {
            records[matchIndex] = { ...records[matchIndex], ...row };
            return { data: records[matchIndex], error: null };
          } else {
            const newRow = { id: row.id || `mock-${Date.now()}-${Math.random()}`, ...row };
            records.push(newRow);
            return { data: newRow, error: null };
          }
        },
        update: (updates: any) => {
          const filters: Array<{ col: string; val: any }> = [];

          const execUpdate = () => {
            if (db.simulateUpdateError && (!db.simulateUpdateError.table || db.simulateUpdateError.table === table)) {
              return { data: null, error: db.simulateUpdateError.error };
            }
            for (let i = 0; i < records.length; i++) {
              const match = filters.every((f) => records[i][f.col] === f.val);
              if (match) {
                records[i] = { ...records[i], ...updates };
              }
            }
            return { data: null, error: null };
          };

          const chain: any = {
            eq: (col: string, val: any) => {
              filters.push({ col, val });
              return chain;
            },
            then: (resolve: (res: any) => void) => {
              resolve(execUpdate());
            },
          };

          return chain;
        },
        delete: () => {
          const filters: Array<{ col: string; val: any }> = [];
          const chain: any = {
            eq: (col: string, val: any) => {
              filters.push({ col, val });
              return chain;
            },
            then: (resolve: (res: any) => void) => {
              for (let i = records.length - 1; i >= 0; i--) {
                const match = filters.every((f) => records[i][f.col] === f.val);
                if (match) {
                  records.splice(i, 1);
                }
              }
              resolve({ data: null, error: null });
            },
          };
          return chain;
        },
      };

      return queryBuilder;
    },
  };

  return { supabase: client as unknown as SupabaseClient, db };
}

function resolveJoins(row: any, table: string, db: InMemoryDb): any {
  if (table === 'yt_stage_bindings') {
    const config = db.yt_provider_configs.find((c) => c.id === row.provider_config_id);
    return {
      ...row,
      yt_provider_configs: config || null,
    };
  }
  if (table === 'narrators') {
    const config = db.yt_provider_configs.find((c) => c.id === row.provider_config_id);
    return {
      ...row,
      yt_provider_configs: config || null,
    };
  }
  return { ...row };
}
