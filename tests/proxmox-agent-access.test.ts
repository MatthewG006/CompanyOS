import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createProxmoxClient,
  isProxmoxManageAction,
  PROXMOX_MANAGE_ACTIONS,
  ProxmoxApiError,
  type ProxmoxCredentials,
} from "../lib/integrations/proxmox-client.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const credentials: ProxmoxCredentials = {
  apiUrl: "https://proxmox.example.com:8006/",
  tokenId: "companyos@pve!agent",
  tokenSecret: "00000000-1111-2222-3333-444444444444",
};
const expectedAuth = "PVEAPIToken=companyos@pve!agent=00000000-1111-2222-3333-444444444444";

type MockReply = { status?: number; body?: unknown };
type RecordedCall = { url: string; init: RequestInit };

function mockFetch(handler: (url: string, init: RequestInit) => MockReply) {
  const calls: RecordedCall[] = [];
  const fn = async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = handler(url, init);
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn: fn as unknown as typeof fetch, calls };
}

function headersOf(call: RecordedCall): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

test("the v1 allowlist is exactly the six non-destructive actions", () => {
  assert.deepEqual([...PROXMOX_MANAGE_ACTIONS], ["start", "shutdown", "stop", "reboot", "snapshot", "resize"]);
  for (const allowed of PROXMOX_MANAGE_ACTIONS) assert.equal(isProxmoxManageAction(allowed), true);
  for (const banned of ["destroy", "delete", "rollback", "exec", "clone", "migrate", "create", "config", "", undefined, null, 42]) {
    assert.equal(isProxmoxManageAction(banned), false, `action must be rejected: ${String(banned)}`);
  }
});

test("the client has no destructive endpoint at all", () => {
  const client = read("../lib/integrations/proxmox-client.ts");
  assert.doesNotMatch(client, /method: "DELETE"/, "no DELETE calls may exist");
  assert.doesNotMatch(client, /status\/destroy/, "no destroy endpoint may exist");
  assert.doesNotMatch(client, /\/rollback/, "no snapshot rollback endpoint may exist");
  assert.doesNotMatch(client, /\/exec["'`]/, "no shell/exec endpoint may exist");
  assert.doesNotMatch(client, /console\./, "the client must never log (secrets stay out of logs)");
});

test("power actions post to the container status endpoints with the token header", async () => {
  const { fetchFn, calls } = mockFetch(() => ({ body: { data: "UPID:proxmox:0001" } }));
  const client = createProxmoxClient(credentials, fetchFn);
  assert.equal(await client.startContainer("proxmox", 102), "UPID:proxmox:0001");
  await client.shutdownContainer("proxmox", 102);
  await client.stopContainer("proxmox", 102);
  await client.rebootContainer("proxmox", 102);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://proxmox.example.com:8006/api2/json/nodes/proxmox/lxc/102/status/start",
    "https://proxmox.example.com:8006/api2/json/nodes/proxmox/lxc/102/status/shutdown",
    "https://proxmox.example.com:8006/api2/json/nodes/proxmox/lxc/102/status/stop",
    "https://proxmox.example.com:8006/api2/json/nodes/proxmox/lxc/102/status/reboot",
  ]);
  for (const call of calls) {
    assert.equal(call.init.method, "POST");
    assert.equal(headersOf(call).Authorization, expectedAuth);
  }
});

test("snapshot posts the approved name and resize PUTs only the changed config fields", async () => {
  const { fetchFn, calls } = mockFetch(() => ({ body: { data: "UPID:proxmox:0002" } }));
  const client = createProxmoxClient(credentials, fetchFn);
  await client.createSnapshot("proxmox", 101, "pre-upgrade", "before the big change");
  assert.equal(calls[0].url, "https://proxmox.example.com:8006/api2/json/nodes/proxmox/lxc/101/snapshot");
  assert.equal(calls[0].init.method, "POST");
  const snapshotBody = new URLSearchParams(String(calls[0].init.body));
  assert.equal(snapshotBody.get("snapname"), "pre-upgrade");
  assert.equal(snapshotBody.get("description"), "before the big change");

  await client.resizeContainer("proxmox", 101, { memoryMb: 4096 });
  assert.equal(calls[1].url, "https://proxmox.example.com:8006/api2/json/nodes/proxmox/lxc/101/config");
  assert.equal(calls[1].init.method, "PUT");
  const resizeBody = new URLSearchParams(String(calls[1].init.body));
  assert.equal(resizeBody.get("memory"), "4096");
  assert.equal(resizeBody.get("cores"), null, "unchanged fields must not be sent");
  assert.equal(resizeBody.get("swap"), null, "unchanged fields must not be sent");
});

test("config reads parse the string values Proxmox returns", async () => {
  const { fetchFn } = mockFetch(() => ({
    body: { data: { hostname: "companyos-rag", cores: "4", memory: "6144", swap: "512", net0: "name=eth0" } },
  }));
  const config = await createProxmoxClient(credentials, fetchFn).getContainerConfig("proxmox", 102);
  assert.deepEqual(config, { hostname: "companyos-rag", cores: 4, memoryMb: 6144, swapMb: 512 });
});

test("the permissions probe accepts both response shapes and stays read-only", async () => {
  const keyed = mockFetch(() => ({ body: { data: { "/vms/102": { "VM.PowerMgmt": 1, "VM.Snapshot": 1 } } } }));
  const keyedPrivileges = await createProxmoxClient(credentials, keyed.fetchFn).getPermissions("/vms/102");
  assert.deepEqual(keyedPrivileges, { "VM.PowerMgmt": 1, "VM.Snapshot": 1 });

  const flat = mockFetch(() => ({ body: { data: { "VM.PowerMgmt": 1, "VM.Config.CPU": 1, "VM.Config.Memory": 0 } } }));
  const flatPrivileges = await createProxmoxClient(credentials, flat.fetchFn).getPermissions("/vms/102");
  assert.deepEqual(flatPrivileges, { "VM.PowerMgmt": 1, "VM.Config.CPU": 1, "VM.Config.Memory": 0 });

  for (const call of [...keyed.calls, ...flat.calls]) {
    assert.equal(call.init.method ?? "GET", "GET", "the manage-access probe must never write");
    assert.match(call.url, /\/access\/permissions\?path=%2Fvms%2F102/);
  }
});

test("container lists map vmid, name and status", async () => {
  const { fetchFn } = mockFetch(() => ({
    body: { data: [{ vmid: 100, name: "nextcloud", status: "running" }, { vmid: 102, name: "companyos-rag", status: "stopped" }] },
  }));
  const containers = await createProxmoxClient(credentials, fetchFn).listContainers("proxmox");
  assert.deepEqual(containers, [
    { vmid: 100, name: "nextcloud", status: "running" },
    { vmid: 102, name: "companyos-rag", status: "stopped" },
  ]);
});

test("Proxmox errors map to a typed error carrying the status", async () => {
  const { fetchFn } = mockFetch(() => ({ status: 403, body: { data: null, errors: { perm: "not allowed" } } }));
  await assert.rejects(
    () => createProxmoxClient(credentials, fetchFn).listNodes(),
    (error: unknown) => {
      assert.ok(error instanceof ProxmoxApiError);
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test("the wrapper reads the same server-side env credential as the sync and never logs", () => {
  const wrapper = read("../lib/integrations/proxmox.ts");
  assert.match(wrapper, /process\.env\.PVE_API_URL/);
  assert.match(wrapper, /process\.env\.PVE_TOKEN_ID/);
  assert.match(wrapper, /process\.env\.PVE_TOKEN_SECRET/);
  assert.match(wrapper, /createProxmoxClient/);
  assert.match(wrapper, /checkProxmoxManageAccess/);
  assert.match(wrapper, /getPermissions\(`\/vms\/\$\{container\.vmid\}`\)/, "the health probe reads per-container privileges");
  assert.match(wrapper, /"VM\.PowerMgmt"/);
  assert.match(wrapper, /"VM\.Snapshot"/);
  assert.match(wrapper, /"VM\.Config\.CPU"/);
  assert.doesNotMatch(wrapper, /console\./, "the adapter must never log credentials");
  const client = read("../lib/integrations/proxmox-client.ts");
  assert.doesNotMatch(client, /process\.env|from "\.\.\/db"/, "the client must stay dependency-free and credential-agnostic");
  assert.match(client, /PVEAPIToken=\$\{credentials\.tokenId\}=\$\{credentials\.tokenSecret\}/);
});

test("the sync delegates to the shared client and surfaces manage access as a systems check", () => {
  const sync = read("../lib/integrations/sync.ts");
  assert.match(sync, /from "\.\/proxmox"/);
  assert.match(sync, /getProxmoxNodes\(\)/);
  assert.match(sync, /getProxmoxNodeStatus\(node\.node\)/);
  assert.match(sync, /checkProxmoxManageAccess\(\)/);
  assert.match(sync, /Proxmox:manage-access/, "manage access must land in system_checks like every other systems check");
  assert.doesNotMatch(sync, /PVEAPIToken=/, "the token header is built by the shared client now, not the sync");
});

test("the manage tool is registered under request_proxmox_manage with the approval contract", () => {
  const registry = read("../lib/ai/tool-registry.ts");
  assert.match(
    registry,
    /manageProxmoxContainerTool: AgentTool = \{\s+actionType: "manage_proxmox_container",\s+permission: "request_proxmox_manage"/,
  );
  assert.match(registry, /\[manageProxmoxContainerTool\.actionType, manageProxmoxContainerTool\]/);
  // Proposal AND execution both validate against the allowlist.
  const validations = registry.match(/isProxmoxManageAction\(rawAction\)/g) ?? [];
  assert.equal(validations.length, 2, "parseProposal and execute must both re-check the allowlist");
  // The approval names the target and, for resize, the exact before → after.
  assert.match(registry, /proxmoxResizeParts\(value\)\.join\("; "\)/);
  assert.match(registry, /memory \$\{value\.currentMemoryMb\} MB → \$\{value\.memoryMb\} MB/);
  // Execution refuses a resize whose live config moved since approval.
  assert.match(registry, /live config no longer matches the approved before-values/);
  // Execution writes the standard event row.
  assert.match(registry, /'proxmox','proxmox_container_managed'/);
});

test("only the DevOps agent can propose Proxmox management anywhere the grant is checked", () => {
  const actions = read("../lib/ai/actions.ts");
  assert.match(actions, /tool\.actionType === "manage_proxmox_container" && run\.agent_name\?\.toLowerCase\(\) !== "devops"/);

  const router = read("../lib/ai/router.ts");
  assert.match(
    router,
    /includes\("request_proxmox_manage"\) && task\.agent_name\?\.toLowerCase\(\) === "devops" \? \["manage_proxmox_container"\]/,
  );
  assert.match(router, /"type":"manage_proxmox_container"/, "the JSON contract must include the new proposal type");
  assert.match(router, /For manage_proxmox_container:/, "missing usage guidance for the new tool");

  const agentsRoute = read("../app/api/agents/route.ts");
  assert.match(agentsRoute, /"request_proxmox_manage"/);
  assert.match(agentsRoute, /Proxmox management proposals are available only to the DevOps agent/);
});

test("the permission grant is DevOps-only in schema and seed", () => {
  const schema = read("../db/schema.sql");
  assert.match(
    schema,
    /UPDATE agents SET allowed_actions=COALESCE\(allowed_actions,'\[\]'::jsonb\) \|\| '\["request_proxmox_manage"\]'::jsonb\s+WHERE LOWER\(name\)='devops'/,
  );
  const seed = read("../scripts/seed.mjs");
  assert.match(seed, /row\[0\] === "DevOps" \? \["request_proxmox_manage"\]/);
});

test("the database-mode worker mirrors the manage tool with the same bounds", () => {
  const worker = read("../scripts/agent-worker.mjs");
  assert.match(worker, /task\.agent_allowed_actions\.includes\("request_proxmox_manage"\)/);
  assert.match(worker, /task\.agent_name\.toLowerCase\(\) === "devops"/);
  assert.match(worker, /prop\?\.type !== "manage_proxmox_container"/);
  assert.match(worker, /new Set\(\["start", "shutdown", "stop", "reboot", "snapshot", "resize"\]\)/);
});
