// Proxmox VE API client (Proxmox agent-access pack).
//
// This module is the pure HTTP core of the Proxmox adapter: it knows how to
// build api2/json requests and map responses, but it never reads the
// environment, the database, or the secret store. Credentials are injected
// by lib/integrations/proxmox.ts, which keeps them server-side. Keeping the
// client dependency-free also makes it unit-testable with a mocked fetch
// (see tests/proxmox-agent-access.test.ts).
//
// Every management write here is executed only from an owner-approved agent
// action in lib/ai/tool-registry.ts; nothing in this file decides policy.
// The action surface is deliberately narrow: the v1 allowlist below is the
// complete set of container operations this client can perform. Destructive
// operations (destroy a container, delete a disk or snapshot, roll back a
// snapshot), arbitrary shell/exec, and host-level changes have no code path
// here at all, so no approval can ever trigger them.

export type ProxmoxCredentials = {
  apiUrl: string;
  tokenId: string;
  tokenSecret: string;
};

export type ProxmoxFetch = typeof fetch;

export class ProxmoxApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(`Proxmox API error (${status}): ${message}`);
    this.name = "ProxmoxApiError";
    this.status = status;
  }
}

/**
 * The complete v1 management allowlist for LXC containers. Anything not in
 * this list is rejected by the tool layer at proposal time and again at
 * execution time, and has no endpoint in this client.
 */
export const PROXMOX_MANAGE_ACTIONS = ["start", "shutdown", "stop", "reboot", "snapshot", "resize"] as const;

export type ProxmoxManageAction = (typeof PROXMOX_MANAGE_ACTIONS)[number];

export function isProxmoxManageAction(value: unknown): value is ProxmoxManageAction {
  return typeof value === "string" && (PROXMOX_MANAGE_ACTIONS as readonly string[]).includes(value);
}

export type ProxmoxNode = {
  node: string;
  status: string;
};

export type ProxmoxContainer = {
  vmid: number;
  name: string;
  status: string;
};

export type ProxmoxContainerConfig = {
  hostname: string;
  cores?: number;
  memoryMb?: number;
  swapMb?: number;
};

export type ProxmoxResize = {
  cores?: number;
  memoryMb?: number;
  swapMb?: number;
};

function parseConfigInt(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function createProxmoxClient(credentials: ProxmoxCredentials, fetchFn: ProxmoxFetch = fetch) {
  const base = credentials.apiUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchFn(`${base}/api2/json${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        Authorization: `PVEAPIToken=${credentials.tokenId}=${credentials.tokenSecret}`,
        ...(init?.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...init?.headers,
      },
    });
    const body = await response.text();
    let parsed: { data?: T } | string | null = null;
    try {
      parsed = body ? (JSON.parse(body) as { data?: T }) : null;
    } catch {
      parsed = body;
    }
    if (!response.ok) {
      const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      throw new ProxmoxApiError(response.status, detail.slice(0, 500));
    }
    return (parsed && typeof parsed === "object" ? parsed.data : undefined) as T;
  }

  function formBody(fields: Record<string, string | number>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) params.set(key, String(value));
    return params.toString();
  }

  const containerPath = (node: string, vmid: number) => `/nodes/${encodeURIComponent(node)}/lxc/${vmid}`;

  return {
    /** Read-only: cluster node list (also used by the status sync). */
    listNodes(): Promise<ProxmoxNode[]> {
      return request<ProxmoxNode[]>("/nodes");
    },

    /** Read-only: node detail (uptime, cpu, memory, rootfs). */
    getNodeStatus(node: string) {
      return request<{ uptime?: number; cpu?: number; memory?: { used?: number; total?: number }; rootfs?: { used?: number; total?: number } }>(
        `/nodes/${encodeURIComponent(node)}/status`,
      );
    },

    /** Read-only: LXC containers on one node. */
    async listContainers(node: string): Promise<ProxmoxContainer[]> {
      const rows = await request<Array<{ vmid: number; name?: string; status?: string }>>(
        `/nodes/${encodeURIComponent(node)}/lxc`,
      );
      return rows.map((row) => ({ vmid: row.vmid, name: row.name ?? "", status: row.status ?? "" }));
    },

    /** Read-only: one container's config (hostname, cores, memory, swap). */
    async getContainerConfig(node: string, vmid: number): Promise<ProxmoxContainerConfig> {
      const raw = await request<Record<string, unknown>>(`${containerPath(node, vmid)}/config`);
      return {
        hostname: typeof raw.hostname === "string" ? raw.hostname : "",
        cores: parseConfigInt(raw.cores),
        memoryMb: parseConfigInt(raw.memory),
        swapMb: parseConfigInt(raw.swap),
      };
    },

    /**
     * Read-only: the token's effective privileges on one ACL path, e.g.
     * /vms/102. The API answers either a map keyed by path or the privilege
     * map directly depending on version; both shapes are handled.
     */
    async getPermissions(path: string): Promise<Record<string, number>> {
      const raw = await request<Record<string, unknown>>(`/access/permissions?path=${encodeURIComponent(path)}`);
      const nested = raw?.[path];
      const map = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : raw;
      const privileges: Record<string, number> = {};
      for (const [key, value] of Object.entries(map ?? {})) {
        const parsed = parseConfigInt(value);
        if (parsed !== undefined) privileges[key] = parsed;
      }
      return privileges;
    },

    startContainer(node: string, vmid: number): Promise<string> {
      return request<string>(`${containerPath(node, vmid)}/status/start`, { method: "POST", body: formBody({}) });
    },

    shutdownContainer(node: string, vmid: number): Promise<string> {
      return request<string>(`${containerPath(node, vmid)}/status/shutdown`, { method: "POST", body: formBody({}) });
    },

    stopContainer(node: string, vmid: number): Promise<string> {
      return request<string>(`${containerPath(node, vmid)}/status/stop`, { method: "POST", body: formBody({}) });
    },

    rebootContainer(node: string, vmid: number): Promise<string> {
      return request<string>(`${containerPath(node, vmid)}/status/reboot`, { method: "POST", body: formBody({}) });
    },

    createSnapshot(node: string, vmid: number, snapname: string, description?: string): Promise<string> {
      return request<string>(`${containerPath(node, vmid)}/snapshot`, {
        method: "POST",
        body: formBody(description ? { snapname, description } : { snapname }),
      });
    },

    /** Apply a config resize; only the provided fields are sent. */
    resizeContainer(node: string, vmid: number, resize: ProxmoxResize): Promise<null> {
      const fields: Record<string, string | number> = {};
      if (resize.cores !== undefined) fields.cores = resize.cores;
      if (resize.memoryMb !== undefined) fields.memory = resize.memoryMb;
      if (resize.swapMb !== undefined) fields.swap = resize.swapMb;
      return request<null>(`${containerPath(node, vmid)}/config`, { method: "PUT", body: formBody(fields) });
    },
  };
}

export type ProxmoxClient = ReturnType<typeof createProxmoxClient>;
