import { Client, type ClientChannel } from "ssh2";
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

export interface FabricEngineCliTransport {
  execute(commands: readonly string[]): Promise<string[]>;
}

export interface FabricEngineSshOptions {
  address: string;
  username: string;
  password: string;
  /** OpenSSH SHA256 fingerprint, for example SHA256:abc123... */
  hostKeySha256: string;
  /** Permit group14-sha1 for legacy VOSS releases that cannot offer a SHA-2 KEX. */
  allowLegacySha1Kex?: boolean;
  readyTimeoutMs?: number;
  commandTimeoutMs?: number;
}

function sshAddress(address: string): { host: string; port: number } {
  const url = new URL(
    /^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `ssh://${address}`,
  );
  if (url.protocol !== "ssh:")
    throw new TypeError("Fabric Engine management address must use ssh://");
  if (!url.hostname) throw new TypeError("Fabric Engine SSH host is missing");
  return { host: url.hostname, port: url.port ? Number(url.port) : 22 };
}

function fingerprintHex(fingerprint: string): string {
  const match = /^SHA256:([A-Za-z0-9+/]+={0,2})$/.exec(fingerprint.trim());
  if (!match)
    throw new TypeError(
      "Fabric Engine host key fingerprint must use OpenSSH SHA256:<base64> format",
    );
  const bytes = Buffer.from(match[1]!, "base64");
  if (bytes.length !== 32)
    throw new TypeError("Fabric Engine SHA256 host key fingerprint is invalid");
  return bytes.toString("hex");
}

const promptPattern = /(?:^|\n)[^\n]*[>#]\s*$/;
const ansiPattern = new RegExp(String.raw`\x1b\[[0-?]*[ -/]*[@-~]`, "g");

function cleanTerminalOutput(output: string, command: string): string {
  const lines = output
    .replaceAll("\r", "")
    .replaceAll(ansiPattern, "")
    .split("\n");
  if (lines[0]?.trim() === command) lines.shift();
  if (lines.at(-1)?.trim() === "") lines.pop();
  if (/^[^\n]*[>#]\s*$/.test(lines.at(-1) ?? "")) lines.pop();
  return lines.join("\n").trim();
}

function assertCliSuccess(output: string, command: string): void {
  const failure = output
    .split(/\r?\n/)
    .find((line) =>
      /(?:^\s*(?:%\s*)?(?:error|invalid|incomplete|ambiguous)\s*:|invalid (?:input|command)|incomplete command|ambiguous command|not authorized|permission denied)/i.test(
        line,
      ),
    );
  if (failure)
    throw new SwitchOperationError(
      `Fabric Engine rejected "${command}": ${failure.trim()}`,
    );
}

/** Password-authenticated VOSS/Fabric Engine interactive SSH CLI transport. */
export class FabricEngineSshTransport implements FabricEngineCliTransport {
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly password: string;
  private readonly expectedFingerprintHex: string;
  private readonly allowLegacySha1Kex: boolean;
  private readonly readyTimeoutMs: number;
  private readonly commandTimeoutMs: number;

  constructor(options: FabricEngineSshOptions) {
    const address = sshAddress(options.address);
    this.host = address.host;
    this.port = address.port;
    this.username = options.username;
    this.password = options.password;
    this.expectedFingerprintHex = fingerprintHex(options.hostKeySha256);
    this.allowLegacySha1Kex = options.allowLegacySha1Kex ?? false;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 7_500;
  }

  async execute(commands: readonly string[]): Promise<string[]> {
    if (commands.length === 0) return [];
    const connection = new Client();
    try {
      const stream = await this.openShell(connection);
      let pending = "";
      let terminalError: Error | undefined;
      let wake: (() => void) | undefined;
      stream.setEncoding("utf8");
      stream.on("data", (data: string) => {
        pending += data;
        wake?.();
      });
      stream.stderr.setEncoding("utf8");
      stream.stderr.on("data", (data: string) => {
        terminalError = new Error(data.trim() || "SSH terminal error");
        wake?.();
      });
      stream.on("error", (error: Error) => {
        terminalError = error;
        wake?.();
      });
      stream.on("close", () => {
        terminalError ??= new Error("SSH shell closed unexpectedly");
        wake?.();
      });

      const readPrompt = async (): Promise<string> => {
        const deadline = Date.now() + this.commandTimeoutMs;
        while (!promptPattern.test(pending)) {
          if (terminalError) throw terminalError;
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            throw new Error(
              "Timed out waiting for the Fabric Engine CLI prompt",
            );
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              wake = undefined;
              resolve();
            }, remaining);
            wake = () => {
              clearTimeout(timer);
              wake = undefined;
              resolve();
            };
          });
        }
        const output = pending;
        pending = "";
        return output;
      };

      await readPrompt();
      stream.write("terminal more disable\n");
      assertCliSuccess(
        cleanTerminalOutput(await readPrompt(), "terminal more disable"),
        "terminal more disable",
      );

      const outputs: string[] = [];
      for (const command of commands) {
        if (/\r|\n/.test(command))
          throw new TypeError("Fabric Engine CLI commands must be single-line");
        stream.write(`${command}\n`);
        const output = cleanTerminalOutput(await readPrompt(), command);
        assertCliSuccess(output, command);
        outputs.push(output);
      }
      stream.end("exit\n");
      return outputs;
    } catch (error) {
      if (error instanceof SwitchOperationError || error instanceof TypeError)
        throw error;
      throw new SwitchUnavailableError(
        `Fabric Engine SSH request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      connection.end();
    }
  }

  private openShell(connection: Client): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      connection
        .once("error", fail)
        .once("ready", () => {
          connection.shell(
            { term: "vt100", cols: 240, rows: 64 },
            (error, stream) => {
              if (error) return fail(error);
              if (settled) return stream.end();
              settled = true;
              resolve(stream);
            },
          );
        })
        .connect({
          host: this.host,
          port: this.port,
          username: this.username,
          password: this.password,
          readyTimeout: this.readyTimeoutMs,
          keepaliveInterval: 5_000,
          keepaliveCountMax: 2,
          hostHash: "sha256",
          hostVerifier: (fingerprint: string) =>
            fingerprint.toLowerCase() === this.expectedFingerprintHex,
          ...(this.allowLegacySha1Kex
            ? {
                algorithms: {
                  kex: {
                    append: "diffie-hellman-group14-sha1" as const,
                    prepend: [],
                    remove: [],
                  },
                },
              }
            : {}),
        });
    });
  }
}

export interface Extreme5420FabricEngineSwitchOptions {
  info: Pick<SwitchInfo, "id" | "name"> & Partial<SwitchInfo>;
  managementVlan: number;
  onboardingVlan: number;
  username?: string;
  password?: string;
  address?: string;
  hostKeySha256?: string;
  allowLegacySha1Kex?: boolean;
  readyTimeoutMs?: number;
  commandTimeoutMs?: number;
  transport?: FabricEngineCliTransport;
  /** Defaults to ports 1/1 through 1/52 on a standalone 5420M-48W-4YE. */
  portIds?: string[];
  clientPorts?: string[];
  apTrunkPorts?: string[];
  portRoles?: Partial<Record<string, SwitchPortRole>>;
  bounceDelayMs?: number;
  /** Persist successful writes to the primary configuration. Disabled by default. */
  saveConfiguration?: boolean;
}

const validVlan = (vlanId: number): void => {
  if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4059)
    throw new RangeError(
      `Fabric Engine VLAN must be an integer between 1 and 4059: ${vlanId}`,
    );
};

function validPortId(portId: string): boolean {
  return /^\d+\/\d+(?:\/\d+)?$/.test(portId);
}

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

const fabricEngineMacArgument = (mac: string): string =>
  mac
    .split(":")
    .map((octet) => `0x${octet}`)
    .join(":");

function sameNumbers(left: number[], right: number[]): boolean {
  return (
    [...left].sort((a, b) => a - b).join(",") ===
    [...right].sort((a, b) => a - b).join(",")
  );
}

interface FabricEnginePortVlanState {
  tagging: boolean;
  discardUntagged: boolean;
  defaultVlan: number;
  vlans: number[];
}

/** Managed-switch adapter for a 5420M-48W-4YE running VOSS/Fabric Engine. */
export class Extreme5420FabricEngineSwitch implements ManagedSwitch {
  private readonly info: SwitchInfo;
  private readonly managementVlan: number;
  private readonly onboardingVlan: number;
  private readonly transport: FabricEngineCliTransport;
  private readonly portIds: string[];
  private readonly portIdSet: Set<string>;
  private readonly roles = new Map<string, SwitchPortRole>();
  private readonly bounceDelayMs: number;
  private readonly saveConfiguration: boolean;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: Extreme5420FabricEngineSwitchOptions) {
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
      Array.from({ length: 52 }, (_, index) => `1/${index + 1}`);
    if (
      this.portIds.length === 0 ||
      new Set(this.portIds).size !== this.portIds.length ||
      this.portIds.some((portId) => !validPortId(portId))
    )
      throw new RangeError(
        "portIds must be unique physical Fabric Engine slot/port identifiers",
      );
    this.portIdSet = new Set(this.portIds);
    const clientPorts = new Set(
      options.clientPorts ??
        this.portIds.filter((portId) => Number(portId.split("/").at(-1)) <= 48),
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
      const address = options.address ?? options.info.managementAddress;
      if (!address)
        throw new TypeError(
          "Extreme 5420 Fabric Engine requires address or info.managementAddress",
        );
      if (
        options.username === undefined ||
        options.password === undefined ||
        options.hostKeySha256 === undefined
      )
        throw new TypeError(
          "Extreme 5420 Fabric Engine requires username, password, and hostKeySha256",
        );
      this.transport = new FabricEngineSshTransport({
        address,
        username: options.username,
        password: options.password,
        hostKeySha256: options.hostKeySha256,
        allowLegacySha1Kex: options.allowLegacySha1Kex,
        readyTimeoutMs: options.readyTimeoutMs,
        commandTimeoutMs: options.commandTimeoutMs,
      });
    }
  }

  async getInfo(): Promise<SwitchInfo> {
    const [system = "", software = ""] = await this.read([
      "show sys-info",
      "show software",
    ]);
    const reportedModel = /(?:ModelName|Chassis|SysDescr)\s*:\s*([^\r\n]+)/i
      .exec(system)?.[1]
      ?.trim();
    const model = reportedModel?.replace(/\s+\([^)]*\).*$/, "");
    const firmwareVersion =
      /(?:^|\n)\s*(5420\.\S+)\s+\(Primary Release\)/i.exec(software)?.[1] ??
      /SysDescr\s*:\s*[^\r\n]*\((\d+(?:\.\d+)+(?:[._-][^\s)]+)?)\)/i.exec(
        system,
      )?.[1];
    if (model && !/5420M-48W-4YE|5420M-48W-4YE-FabricEngine/i.test(model))
      throw new SwitchOperationError(
        `Expected a 5420M-48W-4YE running Fabric Engine, found ${model}`,
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
    const [physical = "", vlanState = "", ...memberships] = await this.read([
      "show interfaces gigabitEthernet",
      "show interfaces gigabitEthernet vlan",
      ...this.portIds.map((portId) => `show vlan members port ${portId}`),
    ]);
    return this.portIds.map((portId, index) =>
      this.parsePort(portId, physical, vlanState, memberships[index] ?? ""),
    );
  }

  async getPort(portId: string): Promise<SwitchPort> {
    const port = this.requirePort(portId);
    const [physical = "", vlanState = "", membership = ""] = await this.read([
      `show interfaces gigabitEthernet ${port}`,
      "show interfaces gigabitEthernet vlan",
      `show vlan members port ${port}`,
    ]);
    return this.parsePort(port, physical, vlanState, membership);
  }

  setAccessVlan(portId: string, vlanId: number): Promise<void> {
    const port = this.requirePort(portId);
    validVlan(vlanId);
    return this.serializedWrite(async () => {
      const current = await this.getPort(port);
      const commands = await this.membershipReplacementCommands(port, current, [
        vlanId,
      ]);
      commands.push(
        `vlan members add ${vlanId} ${port} portmember`,
        `interface GigabitEthernet ${port}`,
        "no untag-port-default-vlan",
        "no encapsulation dot1q",
        `default-vlan-id ${vlanId}`,
        "no untagged-frames-discard",
        "tagged-frames-discard enable",
        "exit",
        "end",
      );
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
    if (tagged.length === 0 && nativeVlan === undefined)
      throw new RangeError("A trunk requires at least one VLAN");
    return this.serializedWrite(async () => {
      const current = await this.getPort(port);
      const desired =
        nativeVlan === undefined ? tagged : [...tagged, nativeVlan];
      const commands = await this.membershipReplacementCommands(
        port,
        current,
        desired,
      );
      for (const vlanId of desired)
        commands.push(`vlan members add ${vlanId} ${port} portmember`);
      commands.push(
        `interface GigabitEthernet ${port}`,
        "encapsulation dot1q",
        "no tagged-frames-discard",
      );
      if (nativeVlan === undefined) {
        commands.push("untagged-frames-discard", "no untag-port-default-vlan");
      } else {
        commands.push(
          `default-vlan-id ${nativeVlan}`,
          "no untagged-frames-discard",
          "untag-port-default-vlan enable",
        );
      }
      commands.push("exit", "end");
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
      await this.write([
        "configure terminal",
        `interface GigabitEthernet ${port}`,
        enabled ? "no shutdown" : "shutdown",
        "exit",
        "end",
      ]);
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
      await this.write(
        [
          "configure terminal",
          `interface GigabitEthernet ${port}`,
          "shutdown",
          "exit",
          "end",
        ],
        false,
      );
      if (delayMs > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      if (wasEnabled)
        await this.write([
          "configure terminal",
          `interface GigabitEthernet ${port}`,
          "no shutdown",
          "exit",
          "end",
        ]);
    });
  }

  async getMacTable(): Promise<MacTableEntry[]> {
    const [output = ""] = await this.read(["show vlan mac-address-entry"]);
    return parseFabricEngineFdb(output);
  }

  async getMacsOnPort(portId: string): Promise<MacTableEntry[]> {
    const port = this.requirePort(portId);
    const [output = ""] = await this.read([
      `show vlan mac-address-entry port ${port}`,
    ]);
    return parseFabricEngineFdb(output).filter(
      (entry) => entry.portId === port,
    );
  }

  async findPortByMac(mac: string): Promise<string | null> {
    const normalized = normalizeMac(mac);
    const [output = ""] = await this.read([
      `show vlan mac-address-entry mac ${fabricEngineMacArgument(normalized)}`,
    ]);
    return (
      parseFabricEngineFdb(output).find(
        (entry) => entry.mac === normalized && this.portIdSet.has(entry.portId),
      )?.portId ?? null
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
    await this.serializedWrite(async () => {
      const entries = await this.getMacsOnPort(port);
      if (entries.length === 0) return;
      await this.write(
        entries.flatMap((entry) => [
          "configure terminal",
          `interface GigabitEthernet ${port}`,
          `clear mac-address-table dynamic ${entry.mac} ${entry.vlanId}`,
          "exit",
          "end",
        ]),
        false,
      );
    });
  }

  private requirePort(portId: string): string {
    const normalized = String(portId);
    if (!this.portIdSet.has(normalized))
      throw new SwitchPortNotFoundError(
        `Unknown 5420M Fabric Engine port: ${portId}`,
      );
    return normalized;
  }

  private parsePort(
    portId: string,
    physicalOutput: string,
    vlanOutput: string,
    membershipOutput: string,
  ): SwitchPort {
    const physical = parsePhysicalPort(physicalOutput, portId);
    const vlan = parsePortVlanState(vlanOutput, portId, membershipOutput);
    const role = this.roles.get(portId) ?? "unused";
    const mode =
      vlan.vlans.some((vlanId) => vlanId !== vlan.defaultVlan) ||
      vlan.discardUntagged ||
      role === "ap-trunk"
        ? "trunk"
        : "access";
    const nativeVlan = vlan.discardUntagged ? undefined : vlan.defaultVlan;
    return {
      id: portId,
      name: `Port ${portId}`,
      enabled: physical.enabled,
      linkUp: physical.linkUp,
      ...(physical.speedMbps === undefined
        ? {}
        : { speedMbps: physical.speedMbps }),
      mode,
      ...(mode === "access"
        ? { accessVlan: vlan.defaultVlan }
        : {
            taggedVlans: vlan.vlans
              .filter((vlanId) => vlanId !== nativeVlan)
              .sort((left, right) => left - right),
            ...(nativeVlan === undefined ? {} : { nativeVlan }),
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
    const [output = ""] = await this.read(["show vlan basic"]);
    const existing = parseVlanIds(output);
    const commands = ["configure terminal"];
    for (const vlanId of [...new Set(currentVlans)])
      commands.push(`vlan members remove ${vlanId} ${portId} portmember`);
    for (const vlanId of desiredVlans)
      if (!existing.has(vlanId))
        commands.push(
          `vlan create ${vlanId} name FM-${vlanId} type port-mstprstp 0`,
        );
    return commands;
  }

  private async read(commands: string[]): Promise<string[]> {
    const outputs = await this.execute(["enable", ...commands]);
    return outputs.slice(1);
  }

  private async write(
    commands: string[],
    save = this.saveConfiguration,
  ): Promise<void> {
    if (commands.length > 0) await this.execute(["enable", ...commands]);
    if (save) await this.execute(["enable", "save config"]);
  }

  private async execute(commands: string[]): Promise<string[]> {
    const outputs = await this.transport.execute(commands);
    outputs.forEach((output, index) =>
      assertCliSuccess(output, commands[index] ?? "unknown command"),
    );
    return outputs;
  }

  private serializedWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }
}

function parsePhysicalPort(
  output: string,
  portId: string,
): { enabled: boolean; linkUp: boolean; speedMbps?: number } {
  const escaped = portId.replaceAll("/", "\\/");
  const line = output
    .split(/\r?\n/)
    .find((candidate) => new RegExp(`^\\s*${escaped}\\s+`).test(candidate));
  if (!line)
    throw new SwitchPortNotFoundError(
      `Fabric Engine did not return details for port ${portId}`,
    );
  const state = /\s(up|down)\s+(up|down)\s*$/i.exec(line);
  if (!state)
    throw new SwitchOperationError(
      `Could not parse Fabric Engine state for port ${portId}`,
    );
  const description = line
    .replace(new RegExp(`^\\s*${escaped}\\s+\\d+\\s+`), "")
    .split(/\s+(?:true|false)\s+(?:true|false)\s+/i)[0];
  const speed = /(\d+(?:\.\d+)?)\s*(T|G|M)(?:BASE|igabit|bps)/i.exec(
    description ?? "",
  );
  const speedMbps = speed
    ? Math.round(
        Number(speed[1]) *
          (speed[2]!.toUpperCase() === "T"
            ? 1_000_000
            : speed[2]!.toUpperCase() === "G"
              ? 1_000
              : 1),
      )
    : /\b(\d{2,6})Base/i.exec(description ?? "")?.[1];
  return {
    enabled: state[1]!.toLowerCase() === "up",
    linkUp: state[2]!.toLowerCase() === "up",
    ...(speedMbps === undefined ? {} : { speedMbps: Number(speedMbps) }),
  };
}

function parsePortVlanState(
  vlanOutput: string,
  portId: string,
  membershipOutput: string,
): FabricEnginePortVlanState {
  const escaped = portId.replaceAll("/", "\\/");
  const line = vlanOutput
    .split(/\r?\n/)
    .find((candidate) => new RegExp(`^\\s*${escaped}\\s+`).test(candidate));
  const state = line
    ? new RegExp(
        `^\\s*${escaped}\\s+(enable|disable)\\s+(?:true|false)\\s+(true|false)\\s+(\\d+)\\s+`,
        "i",
      ).exec(line)
    : undefined;
  if (!state)
    throw new SwitchOperationError(
      `Could not parse Fabric Engine VLAN state for port ${portId}`,
    );
  const vlans = new Set<number>();
  for (const candidate of membershipOutput.split(/\r?\n/)) {
    const match = /^\s*(\d{1,4})\s+/.exec(candidate);
    if (match) vlans.add(Number(match[1]));
  }
  return {
    tagging: state[1]!.toLowerCase() === "enable",
    discardUntagged: state[2]!.toLowerCase() === "true",
    defaultVlan: Number(state[3]),
    vlans: [...vlans],
  };
}

function parseVlanIds(output: string): Set<number> {
  const ids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d{1,4})\s+\S+\s+(?:byPort|port|protocol|spbm)/i.exec(
      line,
    );
    if (match) ids.add(Number(match[1]));
  }
  return ids;
}

function parseFabricEngineFdb(output: string): MacTableEntry[] {
  const entries: MacTableEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^\s*(\d{1,4})\s+(learned|self|mgmt|other|invalid)\s+((?:[0-9a-f]{2}:){5}[0-9a-f]{2})\s+Port-(\d+\/\d+(?:\/\d+)?)(?:\s|$)/i.exec(
        line,
      );
    if (!match) continue;
    entries.push({
      vlanId: Number(match[1]),
      dynamic: match[2]!.toLowerCase() === "learned",
      mac: normalizeMac(match[3]!),
      portId: match[4]!,
    });
  }
  return entries;
}

export class Extreme5420VossSwitch extends Extreme5420FabricEngineSwitch {}
