const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

// ─── Settings ────────────────────────────────────────────────────────────────
export const api = {
  settings: {
    list: () => request<any>('/settings'),
    update: (kv: Record<string, string>) =>
      request<any>('/settings', { method: 'PUT', body: JSON.stringify(kv) }),
    models: () => request<any>('/settings/models'),
  },

  // ─── Skills ────────────────────────────────────────────────────────────────
  skills: {
    list: (params?: { type?: string; status?: string; q?: string }) => {
      const p = Object.fromEntries(Object.entries(params || {}).filter(([,v]) => v !== undefined && v !== ''));
      const qs = new URLSearchParams(p as any).toString();
      return request<any>(`/skills${qs ? '?' + qs : ''}`);
    },
    get: (id: string) => request<any>(`/skills/${id}`),
    create: (body: any) =>
      request<any>('/skills', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: any) =>
      request<any>(`/skills/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string) =>
      request<any>(`/skills/${id}`, { method: 'DELETE' }),
    review: (id: string) =>
      request<any>(`/skills/${id}/review`, { method: 'POST' }),
    setH5Config: (id: string, h5_config: any) =>
      request<any>(`/skills/${id}/h5-config`, { method: 'PUT', body: JSON.stringify({ h5_config }) }),
    publish: (id: string) =>
      request<any>(`/skills/${id}/publish`, { method: 'PUT' }),
    reject: (id: string, reason: string) =>
      request<any>(`/skills/${id}/reject`, { method: 'PUT', body: JSON.stringify({ reason }) }),
    importClawhub: (url: string, type = 'external') =>
      request<any>('/skills/import-clawhub', { method: 'POST', body: JSON.stringify({ url, type }) }),
    sandboxTest: async (id: string) => {
      const res = await fetch(`${API_BASE}/skills/${id}/sandbox-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (!res.ok && res.status !== 202) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    uploadScripts: async (id: string, file: File): Promise<any> => {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const res = await fetch(`${API_BASE}/skills/${id}/upload-scripts`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ archiveBase64: reader.result, filename: file.name }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            resolve(data);
          } catch (e) { reject(e); }
        };
        reader.onerror = () => reject(new Error('FileReader error'));
        reader.readAsDataURL(file);
      });
    },
  },

  // ─── Upload ────────────────────────────────────────────────────────────────
  upload: {
    files: async (files: File[]): Promise<any> => {
      const fd = new FormData();
      files.forEach(f => fd.append('files', f));
      const res = await fetch(`${API_BASE}/upload`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Upload failed`);
      return data;
    },
  },

  // ─── Tickets ───────────────────────────────────────────────────────────────
  tickets: {
    list: (params?: { status?: string; skill_id?: string; q?: string }) => {
      const p = Object.fromEntries(Object.entries(params || {}).filter(([,v]) => v !== undefined && v !== ''));
      const qs = new URLSearchParams(p as any).toString();
      return request<any>(`/tickets${qs ? '?' + qs : ''}`);
    },
    get: (id: string) => request<any>(`/tickets/${id}`),
    create: (body: any) =>
      request<any>('/tickets', { method: 'POST', body: JSON.stringify(body) }),
    return: (id: string, reason: string) =>
      request<any>(`/tickets/${id}/return`, { method: 'PUT', body: JSON.stringify({ reason }) }),
    status: (id: string) => request<any>(`/tickets/${id}/status`),
  },

  // ─── Results ───────────────────────────────────────────────────────────────
  results: {
    process: (ticketId: string) =>
      request<any>(`/results/process/${ticketId}`, { method: 'POST' }),
    get: (ticketId: string) => request<any>(`/results/${ticketId}`),
    update: (ticketId: string, body: { revised_result?: string; revision_notes?: string; revised_by?: string }) =>
      request<any>(`/results/${ticketId}`, { method: 'PUT', body: JSON.stringify(body) }),
    reportUrl: (ticketId: string, format: 'html' | 'pdf' = 'html') =>
      `/api/results/${ticketId}/report?format=${format}`,
  },

  // ─── Test ──────────────────────────────────────────────────────────────────
  test: {
    run: (skillId: string, inputs: Record<string, string>, createdBy?: string) =>
      request<any>('/test/run', { method: 'POST', body: JSON.stringify({ skill_id: skillId, inputs, created_by: createdBy }) }),
    runs: (skillId: string) => request<any>(`/test/runs/${skillId}`),
    getRun: (runId: string) => request<any>(`/test/run/${runId}`),
  },
  // ─── MCP Configs ───────────────────────────────────────────────────────────
  mcpConfigs: {
    list: () => request<any>('/mcp-configs'),
    create: (body: { name: string; command: string; args?: string; description?: string }) =>
      request<any>('/mcp-configs', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: any) =>
      request<any>(`/mcp-configs/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    delete: (id: string) => request<any>(`/mcp-configs/${id}`, { method: 'DELETE' }),
  },
};
