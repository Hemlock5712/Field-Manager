import {
  SwitchOperationError,
  SwitchPortNotFoundError,
  SwitchUnavailableError,
  type MacTableEntry,
  type ManagedSwitch,
  type SwitchCapabilities,
  type SwitchInfo,
  type SwitchPort,
  type SwitchPortRole,
} from "./index.js";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SwitchEngineCliTransport {
  execute(commands: readonly string[]): Promise<string[]>;
}

export interface SwitchEngineJsonRpcOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
  fetch?: Fetch;
}

interface JsonRpcResponse {
  error?: { code?: number; message?: string; data?: unknown };
  result?: Array<Record<string, unknown>>;
}

function jsonRpcUrl(address: string): URL {
  const url = new URL(
    /^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `http://${address}`,
  );
  url.pathname = `${url.pathname.replace(/\/$/, "")}/jsonrpc/`;
  return url;
}

/** HTTP Basic authenticated Switch Engine/EXOS JSON-RPC CLI transport. */
export class SwitchEngineJsonRpcTransport implements SwitchEngineCliTransport {
  private readonly url: URL;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly fetch: Fetch;
  private requestId = 0;

  constructor(options: SwitchEngineJsonRpcOptions) {
    this.url = jsonRpcUrl(options.baseUrl);
    this.username = options.username;
    this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? 7_500;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async execute(commands: readonly string[]): Promise<string[]> {
    if (commands.length === 0) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.url, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${this.username}:${this.password}`)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "cli",
          params: [commands.join(";")],
          id: ++this.requestId,
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok)
        throw new SwitchOperationError(
          `Switch Engine JSON-RPC failed with HTTP ${response.status}${text.trim() ? `: ${text.trim()}` : ""}`,
        );
      let document: JsonRpcResponse;
      try {
        document = JSON.parse(text) as JsonRpcResponse;
      } catch (error) {
        throw new SwitchOperationError(
          `Switch Engine returned invalid JSON: ${String(error)}`,
        );
      }
      if (document.error)
        throw new SwitchOperationError(
          `Switch Engine JSON-RPC error${document.error.code === undefined ? "" : ` ${document.error.code}`}: ${document.error.message ?? "unknown error"}`,
        );
      if (!Array.isArray(document.result))
        throw new SwitchOperationError(
          "Switch Engine JSON-RPC response has no result",
        );
      const outputs: string[] = [];
      for (const block of document.result) {
        if (block.status === "ERROR")
          throw new SwitchOperationError(
            outputs.at(-1)?.trim() || "Switch Engine rejected a CLI command",
          );
        if (typeof block.CLIoutput === "string") outputs.push(block.CLIoutput);
      }
      return outputs;
    } catch (error) {
      if (error instanceof SwitchOperationError) throw error;
      throw new SwitchUnavailableError(
        `Switch Engine request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface Extreme5420SwitchOptions {
  info: Pick<SwitchInfo, "id" | "name"> & Partial<SwitchInfo>;
  managementVlan: number;
  onboardingVlan: number;
  username?: string;
  password?: string;
  baseUrl?: string;
  timeoutMs?: number;
  transport?: SwitchEngineCliTransport;
  fetch?: Fetch;
  /** Defaults to the 48 copper and four uplink data ports on a standalone 5420M-48W-4YE. */
  portIds?: string[];
  clientPorts?: string[];
  apTrunkPorts?: string[];
  portRoles?: Partial<Record<string, SwitchPortRole>>;
  bounceDelayMs?: number;
  /** Persist successful writes to the primary configuration. Disabled by default. */
  saveConfiguration?: boolean;
}

const validVlan = (vlanId: number): void => {
  if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094)
    throw new RangeError(
      `VLAN must be an integer between 1 and 4094: ${vlanId}`,
    );
};

const normalizeMac = (mac: string): string => {
  const value = mac.trim();
  if (
    !/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}|[0-9a-f]{4}(?:\.[0-9a-f]{4}){2})$/i.test(
      value,
    )
  )
    throw new TypeError(`Invalid MAC address: ${mac}`);
  const hex = value.replaceAll(/[:-]|\./g, "").toUpperCase();
  return hex.match(/../g)!.join(":");
};

function validPortId(portId: string): boolean {
  return /^(?:\d+|\d+:\d+)$/.test(portId);
}

/** Managed-switch adapter for a 5420M-48W-4YE running Switch Engine/EXOS. */
export class Extreme5420Switch implements ManagedSwitch {
  private readonly info: SwitchInfo;
  private readonly managementVlan: number;
  private readonly onboardingVlan: number;
  private readonly transport: SwitchEngineCliTransport;
  private readonly portIds: string[];
  private readonly portIdSet: Set<string>;
  private readonly roles = new Map<string, SwitchPortRole>();
  private readonly bounceDelayMs: number;
  private readonly saveConfiguration: boolean;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: Extreme5420SwitchOptions) {
    validVlan(options.managementVlan);
    validVlan(options.onboardingVlan);
    if (options.managementVlan === options.onboardingVlan)
      throw new RangeError("Management and onboarding VLANs must differ");
    this.info = {
      manufacturer: "Extreme Networks",
      model: "5420M-48W-4YE",
      ...options.info,
    };
    this.managementVlan = options.managementVlan;
    this.onboardingVlan = options.onboardingVlan;
    this.portIds =
      options.portIds ??
      Array.from({ length: 52 }, (_, index) => String(index + 1));
    if (
      this.portIds.length === 0 ||
      new Set(this.portIds).size !== this.portIds.length ||
      this.portIds.some((portId) => !validPortId(portId))
    )
      throw new RangeError(
        "portIds must be unique physical Switch Engine port identifiers",
      );
    this.portIdSet = new Set(this.portIds);
    const clientPorts = new Set(
      options.clientPorts ??
        this.portIds.filter((portId) => Number(portId) <= 48),
    );
    const apTrunkPorts = new Set(options.apTrunkPorts ?? []);
    for (const portId of this.portIds) {
      this.roles.set(
        portId,
        options.portRoles?.[portId] ??
          (apTrunkPorts.has(portId)
            ? "ap-trunk"
            : clientPorts.has(portId)
              ? "client"
              : "unused"),
      );
    }
    this.bounceDelayMs = options.bounceDelayMs ?? 350;
    this.saveConfiguration = options.saveConfiguration ?? false;
    if (options.transport) this.transport = options.transport;
    else {
      const baseUrl = options.baseUrl ?? options.info.managementAddress;
      if (!baseUrl)
        throw new TypeError(
          "Extreme 5420 requires baseUrl or info.managementAddress",
        );
      if (options.username === undefined || options.password === undefined)
        throw new TypeError("Extreme 5420 requires username and password");
      this.transport = new SwitchEngineJsonRpcTransport({
        baseUrl,
        username: options.username,
        password: options.password,
        timeoutMs: options.timeoutMs,
        fetch: options.fetch,
      });
    }
  }

  async getInfo(): Promise<SwitchInfo> {
    const output = (await this.transport.execute(["show switch"])).join("\n");
    const model = /(?:System Type|System Model|Platform)\s*:\s*([^\r\n]+)/i
      .exec(output)?.[1]
      ?.trim();
    const firmwareVersion =
      /(?:ExtremeXOS|Switch Engine)(?:\s+version)?\s+([^\s,]+)/i.exec(
        output,
      )?.[1] ??
      /(?:Primary Ver|Image Version)\s*:\s*([^\s,]+)/i.exec(output)?.[1];
    if (model && !/5420M-48W-4YE/i.test(model))
      throw new SwitchOperationError(
        `Expected a 5420M-48W-4YE running Switch Engine, found ${model}`,
      );
    return {
      ...this.info,
      ...(model ? { model } : {}),
      ...(firmwareVersion ? { firmwareVersion } : {}),
    };
  }

  async getCapabilities(): Promise<SwitchCapabilities> {
    await this.getInfo();
    return {
      maxPorts: this.portIds.length,
      supportsAccessVlans: true,
      supportsTrunks: true,
      supportsPortBounce: true,
      supportsMacTable: true,
      supportsPortEnable: true,
    };
  }

  async getPorts(): Promise<SwitchPort[]> {
    const list = this.portIds.join(",");
    const output = (
      await this.transport.execute([
        `show ports ${list} information detail`,
        `show port ${list} vid`,
      ])
    ).join("\n");
    return this.portIds.map((portId) => this.parsePort(portId, output));
  }

  async getPort(portId: string): Promise<SwitchPort> {
    const port = this.requirePort(portId);
    const output = (
      await this.transport.execute([
        `show ports ${port} information detail`,
        `show port ${port} vid`,
      ])
    ).join("\n");
    return this.parsePort(port, output);
  }

  setAccessVlan(portId: string, vlanId: number): Promise<void> {
    const port = this.requirePort(portId);
    validVlan(vlanId);
    return this.serializedWrite(async () => {
      const current = await this.getPort(port);
      const commands = await this.membershipReplacementCommands(port, current, [
        vlanId,
      ]);
      commands.push(`configure vlan ${vlanId} add ports ${port} untagged`);
      await this.write(commands);
      const readback = await this.getPort(port);
      if (readback.mode !== "access" || readback.accessVlan !== vlanId)
        throw new SwitchOperationError(
          `Access VLAN readback mismatch on port ${port}: expected ${vlanId}`,
        );
    });
  }

  setTrunkVlans(
    portId: string,
    taggedVlans: number[],
    nativeVlan?: number,
  ): Promise<void> {
    const port = this.requirePort(portId);
    const tagged = [...new Set(taggedVlans)].sort(
      (left, right) => left - right,
    );
    tagged.forEach(validVlan);
    if (nativeVlan !== undefined) validVlan(nativeVlan);
    if (nativeVlan !== undefined && tagged.includes(nativeVlan))
      throw new RangeError("The native VLAN cannot also be tagged");
    return this.serializedWrite(async () => {
      const current = await this.getPort(port);
      const desired =
        nativeVlan === undefined ? tagged : [...tagged, nativeVlan];
      const commands = await this.membershipReplacementCommands(
        port,
        current,
        desired,
      );
      if (nativeVlan !== undefined)
        commands.push(
          `configure vlan ${nativeVlan} add ports ${port} untagged`,
        );
      if (tagged.length > 0)
        commands.push(
          `configure vlan ${tagged.join(",")} add ports ${port} tagged`,
        );
      await this.write(commands);
      const readback = await this.getPort(port);
      if (
        readback.mode !== "trunk" ||
        readback.nativeVlan !== nativeVlan ||
        !sameNumbers(readback.taggedVlans ?? [], tagged)
      )
        throw new SwitchOperationError(
          `Trunk VLAN readback mismatch on port ${port}`,
        );
    });
  }

  setPortEnabled(portId: string, enabled: boolean): Promise<void> {
    const port = this.requirePort(portId);
    return this.serializedWrite(async () => {
      await this.write([`${enabled ? "enable" : "disable"} ports ${port}`]);
      const readback = await this.getPort(port);
      if (readback.enabled !== enabled)
        throw new SwitchOperationError(
          `Port ${port} enable-state readback mismatch`,
        );
    });
  }

  async bouncePort(
    portId: string,
    delayMs = this.bounceDelayMs,
  ): Promise<void> {
    const port = this.requirePort(portId);
    if (!Number.isFinite(delayMs) || delayMs < 0)
      throw new RangeError("delayMs must be non-negative");
    return this.serializedWrite(async () => {
      const wasEnabled = (await this.getPort(port)).enabled;
      await this.write([`disable ports ${port}`], false);
      if (delayMs > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      if (wasEnabled) await this.write([`enable ports ${port}`]);
    });
  }

  async getMacTable(): Promise<MacTableEntry[]> {
    const output = (await this.transport.execute(["show fdb"])).join("\n");
    return parseFdb(output);
  }

  async getMacsOnPort(portId: string): Promise<MacTableEntry[]> {
    const port = this.requirePort(portId);
    const output = (
      await this.transport.execute([`show fdb ports ${port}`])
    ).join("\n");
    return parseFdb(output).filter((entry) => entry.portId === port);
  }

  async findPortByMac(mac: string): Promise<string | null> {
    const normalized = normalizeMac(mac);
    const output = (
      await this.transport.execute([`show fdb ${normalized}`])
    ).join("\n");
    return (
      parseFdb(output).find((entry) => entry.mac === normalized)?.portId ?? null
    );
  }

  async resetPort(portId: string): Promise<void> {
    const port = this.requirePort(portId);
    await this.setAccessVlan(port, this.onboardingVlan);
    await this.setPortEnabled(port, true);
    await this.clearMacsOnPort(port);
  }

  async clearMacsOnPort(portId: string): Promise<void> {
    const port = this.requirePort(portId);
    await this.serializedWrite(() =>
      this.write([`clear fdb ports ${port}`], false),
    );
  }

  private requirePort(portId: string): string {
    const normalized = String(portId);
    if (!this.portIdSet.has(normalized))
      throw new SwitchPortNotFoundError(`Unknown 5420M port: ${portId}`);
    return normalized;
  }

  private parsePort(portId: string, output: string): SwitchPort {
    const escaped = portId.replaceAll(":", "\\:");
    const section = new RegExp(
      `(?:^|\\n)\\s*Port:\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n\\s*Port:\\s*\\d|$)`,
      "i",
    ).exec(output)?.[1];
    if (!section)
      throw new SwitchPortNotFoundError(
        `Switch Engine did not return details for port ${portId}`,
      );
    const enabled = /Admin state:\s*Enabled/i.test(section);
    const link = /Link State:\s*([^\r\n]+)/i.exec(section)?.[1]?.trim() ?? "";
    const linkUp = /^Active\b/i.test(link);
    const speed = /,\s*([\d.]+)\s*([MGT])bps/i.exec(link);
    const speedMbps = speed
      ? Math.round(
          Number(speed[1]) *
            (speed[2]!.toUpperCase() === "G"
              ? 1_000
              : speed[2]!.toUpperCase() === "T"
                ? 1_000_000
                : 1),
        )
      : undefined;
    const duplexMatch = /,\s*(full|half)-duplex/i
      .exec(link)?.[1]
      ?.toLowerCase();
    const membership = parsePortVids(output, portId);
    const role = this.roles.get(portId) ?? "unused";
    const mode =
      membership.tagged.length > 0 || role === "ap-trunk" ? "trunk" : "access";
    return {
      id: portId,
      name: `Port ${portId}`,
      enabled,
      linkUp,
      ...(speedMbps !== undefined ? { speedMbps } : {}),
      ...(duplexMatch === "full" || duplexMatch === "half"
        ? { duplex: duplexMatch }
        : {}),
      mode,
      ...(mode === "access"
        ? { accessVlan: membership.untagged }
        : {
            taggedVlans: membership.tagged,
            ...(membership.untagged !== undefined
              ? { nativeVlan: membership.untagged }
              : {}),
          }),
      role,
    };
  }

  private async membershipReplacementCommands(
    portId: string,
    current: SwitchPort,
    desiredVlans: number[],
  ): Promise<string[]> {
    const currentVlans = [
      ...(current.accessVlan === undefined ? [] : [current.accessVlan]),
      ...(current.nativeVlan === undefined ? [] : [current.nativeVlan]),
      ...(current.taggedVlans ?? []),
    ];
    const output = (await this.transport.execute(["show vlan"])).join("\n");
    const existing = parseVlanIds(output);
    const commands = [...new Set(currentVlans)].map(
      (vlanId) => `configure vlan ${vlanId} delete ports ${portId}`,
    );
    for (const vlanId of desiredVlans)
      if (!existing.has(vlanId))
        commands.push(`create vlan FM-${vlanId} tag ${vlanId}`);
    return commands;
  }

  private async write(
    commands: string[],
    save = this.saveConfiguration,
  ): Promise<void> {
    if (commands.length > 0) await this.transport.execute(commands);
    if (save) await this.transport.execute(["save configuration primary"]);
  }

  private serializedWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }
}

function parsePortVids(
  output: string,
  portId: string,
): { untagged?: number; tagged: number[] } {
  const result: { untagged?: number; tagged: number[] } = { tagged: [] };
  let activePort: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^\s*(?:(\d+(?::\d+)?)\s+)?(Untagged|Tagged)\s+(.+?)\s*$/i.exec(line);
    if (!match) continue;
    if (match[1]) activePort = match[1];
    if (activePort !== portId) continue;
    const values = match[3]!.trim();
    const vlans =
      values.toLowerCase() === "none"
        ? []
        : values
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(Number)
            .filter(Number.isInteger);
    if (match[2]!.toLowerCase() === "untagged") result.untagged = vlans[0];
    else result.tagged = vlans.sort((left, right) => left - right);
  }
  return result;
}

function parseVlanIds(output: string): Set<number> {
  const ids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\S+\s+(\d{1,4})(?:\s|$)/.exec(line);
    if (match) ids.add(Number(match[1]));
  }
  return ids;
}

function parseFdb(output: string): MacTableEntry[] {
  const entries: MacTableEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const mac = /(?:^|\s)((?:[0-9a-f]{2}:){5}[0-9a-f]{2})(?:\s|$)/i.exec(
      line,
    )?.[1];
    const vlan = /\((\d{1,4})\)/.exec(line)?.[1];
    const port = /(\d+(?::\d+)?)(?:\(\d+\))?\s*$/.exec(line)?.[1];
    if (!mac || !vlan || !port) continue;
    const afterVlan = line.slice(line.indexOf(`(${vlan})`) + vlan.length + 2);
    const age = /^\s*(\d+)\s+/.exec(afterVlan)?.[1];
    const flags = afterVlan
      .replace(/^\s*\d+\s+/, "")
      .slice(0, afterVlan.lastIndexOf(port));
    entries.push({
      mac: normalizeMac(mac),
      portId: port,
      vlanId: Number(vlan),
      dynamic: /(?:^|\s)d(?:\s|$)/.test(flags),
      ...(age ? { ageSeconds: Number(age) } : {}),
    });
  }
  return entries;
}

function sameNumbers(left: number[], right: number[]): boolean {
  return (
    [...left].sort((a, b) => a - b).join(",") ===
    [...right].sort((a, b) => a - b).join(",")
  );
}

export class Extreme5420M48W4YESwitch extends Extreme5420Switch {}
