import {
  createProxmoxClient,
  type ProxmoxClient,
  type ProxmoxContainer,
  type ProxmoxContainerConfig,
  type ProxmoxCredentials,
  type ProxmoxResize,
} from "./proxmox-client";

export type { ProxmoxContainer, ProxmoxContainerConfig, ProxmoxResize } from "./proxmox-client";
export { isProxmoxManageAction, PROXMOX_MANAGE_ACTIONS, type ProxmoxManageAction } from "./proxmox-client";

/**
 * The Proxmox credential lives in the server environment only — the same
 * PVE_API_URL / PVE_TOKEN_ID / PVE_TOKEN_SECRET the read-only status sync
 * has always used (see lib/integrations/sync.ts). It must be a dedicated
 * API token created for CompanyOS in Proxmox, never root@pam and never the
 * owner's personal login; the Proxmox-side ACLs on that token are what
 * actually bound what management can touch (see the PR description for the
 * exact grant steps).
 */
export function getProxmoxCredentials(): ProxmoxCredentials | null {
  const apiUrl = process.env.PVE_API_URL?.trim();
  const tokenId = process.env.PVE_TOKEN_ID?.trim();
  const tokenSecret = process.env.PVE_TOKEN_SECRET?.trim();
  if (!apiUrl || !tokenId || !tokenSecret) return null;
  return { apiUrl: apiUrl.replace(/\/+$/, ""), tokenId, tokenSecret };
}

export function proxmoxClient(): ProxmoxClient {
  const credentials = getProxmoxCredentials();
  if (!credentials) throw new Error("PVE_API_URL, PVE_TOKEN_ID and PVE_TOKEN_SECRET are required.");
  return createProxmoxClient(credentials);
}

/** Read-only node + status reads, shared with the integration sync. */
export async function getProxmoxNodes() {
  return proxmoxClient().listNodes();
}

export async function getProxmoxNodeStatus(node: string) {
  return proxmoxClient().getNodeStatus(node);
}

/** Read-only: every LXC container across all nodes. */
export async function listAllProxmoxContainers(): Promise<Array<ProxmoxContainer & { node: string }>> {
  const client = proxmoxClient();
  const nodes = await client.listNodes();
  const containers: Array<ProxmoxContainer & { node: string }> = [];
  for (const entry of nodes) {
    const rows = await client.listContainers(entry.node);
    for (const row of rows) containers.push({ ...row, node: entry.node });
  }
  return containers;
}

/** Read-only: one container by node + vmid, or null when it does not exist. */
export async function getProxmoxContainer(node: string, vmid: number): Promise<ProxmoxContainer | null> {
  const rows = await proxmoxClient().listContainers(node);
  return rows.find((row) => row.vmid === vmid) ?? null;
}

export async function getProxmoxContainerConfig(node: string, vmid: number): Promise<ProxmoxContainerConfig> {
  return proxmoxClient().getContainerConfig(node, vmid);
}

export async function startProxmoxContainer(node: string, vmid: number): Promise<string> {
  return proxmoxClient().startContainer(node, vmid);
}

export async function shutdownProxmoxContainer(node: string, vmid: number): Promise<string> {
  return proxmoxClient().shutdownContainer(node, vmid);
}

export async function stopProxmoxContainer(node: string, vmid: number): Promise<string> {
  return proxmoxClient().stopContainer(node, vmid);
}

export async function rebootProxmoxContainer(node: string, vmid: number): Promise<string> {
  return proxmoxClient().rebootContainer(node, vmid);
}

export async function snapshotProxmoxContainer(node: string, vmid: number, snapname: string, description?: string): Promise<string> {
  return proxmoxClient().createSnapshot(node, vmid, snapname, description);
}

export async function resizeProxmoxContainer(node: string, vmid: number, resize: ProxmoxResize): Promise<void> {
  await proxmoxClient().resizeContainer(node, vmid, resize);
}

export type ProxmoxManageAccess = {
  configured: boolean;
  containers: Array<{
    node: string;
    vmid: number;
    name: string;
    canPower: boolean;
    canSnapshot: boolean;
    canResize: boolean;
  }>;
  manageableCount: number;
  message: string;
};

/**
 * Read-only health probe, analogous to the WordPress administrator check:
 * reports whether the configured token actually holds the privileges the
 * management tool needs, per container. It only ever issues GET requests
 * (node/container lists and the permissions endpoint) — never a test write.
 */
export async function checkProxmoxManageAccess(): Promise<ProxmoxManageAccess> {
  const client = (() => {
    try {
      return proxmoxClient();
    } catch {
      return null;
    }
  })();
  if (!client) {
    return { configured: false, containers: [], manageableCount: 0, message: "Proxmox credentials are not configured." };
  }

  try {
    const all = await listAllProxmoxContainers();
    const containers: ProxmoxManageAccess["containers"] = [];
    for (const container of all) {
      const privileges = await client.getPermissions(`/vms/${container.vmid}`);
      const has = (name: string) => (privileges[name] ?? 0) > 0;
      containers.push({
        node: container.node,
        vmid: container.vmid,
        name: container.name,
        canPower: has("VM.PowerMgmt"),
        canSnapshot: has("VM.Snapshot"),
        canResize: has("VM.Config.CPU") && has("VM.Config.Memory"),
      });
    }
    const manageableCount = containers.filter((entry) => entry.canPower && entry.canSnapshot && entry.canResize).length;
    const message = !containers.length
      ? "Proxmox token authenticated; no LXC containers were found."
      : manageableCount === containers.length
        ? `Proxmox token can manage all ${containers.length} container(s) (power, snapshot, resize).`
        : manageableCount === 0
          ? `Proxmox token is read-only on all ${containers.length} container(s); management proposals would fail until the token is granted VM privileges.`
          : `Proxmox token can fully manage ${manageableCount} of ${containers.length} container(s); the rest are read-only to it.`;
    return { configured: true, containers, manageableCount, message };
  } catch (error) {
    return {
      configured: true,
      containers: [],
      manageableCount: 0,
      message: error instanceof Error ? error.message : "Failed to probe Proxmox manage access.",
    };
  }
}
