import { PILLAR_API_URL, PILLAR_API_KEY } from "../config/pillar.js";

class PillarApiService {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = PILLAR_API_URL;
    this.apiKey = PILLAR_API_KEY;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;

    if (queryParams) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined) {
          params.set(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Pillar API error (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  async get<T>(path: string, queryParams?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>("GET", path, undefined, queryParams);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}

let _instance: PillarApiService | null = null;

export function getPillarApi(): PillarApiService {
  if (!_instance) {
    _instance = new PillarApiService();
  }
  return _instance;
}
