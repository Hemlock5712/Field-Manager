import {
  AccessPointOperationError,
  AccessPointSlotNotFoundError,
  AccessPointUnavailableError,
  type AccessPoint,
  type AccessPointCapabilities,
  type AccessPointInfo,
  type AccessPointStation,
  type AccessPointStationStatus,
  type TeamWirelessConfiguration,
} from "./index.js";

const VH113_SLOT_IDS = [
  "red1",
  "red2",
  "red3",
  "blue1",
  "blue2",
  "blue3",
] as const;
const VLAN_BANKS = [
  [10, 20, 30],
  [40, 50, 60],
  [70, 80, 90],
] as const;

type SlotId = (typeof VH113_SLOT_IDS)[number];
type VlanBank = "10_20_30" | "40_50_60" | "70_80_90";
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface VH113NetworkStatus {
  ssid: string;
  hashedWpaKey: string;
  wpaKeySalt: string;
  isLinked: boolean;
  macAddress: string;
  signalDbm: number;
}

interface VH113Status {
  channel: number;
  channelBandwidth: string;
  redVlans: VlanBank;
  blueVlans: VlanBank;
  status: string;
  stationStatuses: Record<SlotId, VH113NetworkStatus | null>;
  syslogIpAddress: string;
  version?: string;
}

export interface VH113AccessPointOptions {
  info: AccessPointInfo;
  /** API root. Defaults to managementAddress, adding http:// and port 8081 when omitted. */
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  applyTimeoutMs?: number;
  pollIntervalMs?: number;
  channel?: number;
  channelBandwidth?: "20MHz" | "40MHz";
  syslogIpAddress?: string;
  /** Plaintext desired state used to safely preserve other slots across the AP's whole-document writes. */
  initialConfigurations?: Partial<Record<SlotId, TeamWirelessConfiguration>>;
  fetch?: Fetch;
}

function isSlotId(value: string): value is SlotId {
  return (VH113_SLOT_IDS as readonly string[]).includes(value);
}

function validateConfiguration(
  slotId: SlotId,
  configuration: TeamWirelessConfiguration,
): void {
  if (
    !Number.isInteger(configuration.teamNumber) ||
    configuration.teamNumber < 1
  )
    throw new RangeError("teamNumber must be positive");
  if (!/^[A-Za-z0-9-]{1,14}$/.test(configuration.ssid))
    throw new RangeError(
      "VH-113 SSIDs must contain 1-14 alphanumeric or hyphen characters",
    );
  if (!configuration.wpaKey)
    throw new RangeError("VH-113 configuration requires a WPA key");
  if (!/^[A-Za-z0-9]{8,16}$/.test(configuration.wpaKey))
    throw new RangeError(
      "VH-113 WPA keys must contain 8-16 alphanumeric characters",
    );
  bankForConfiguration(slotId, configuration.vlanId);
}

function slotPosition(slotId: SlotId): number {
  return Number(slotId.at(-1)) - 1;
}

function bankForConfiguration(slotId: SlotId, vlanId: number): VlanBank {
  const position = slotPosition(slotId);
  const bank = VLAN_BANKS.find((candidate) => candidate[position] === vlanId);
  if (!bank)
    throw new RangeError(
      `VH-113 slot ${slotId} cannot use VLAN ${vlanId}; supported VLANs are ${VLAN_BANKS.map((candidate) => candidate[position]).join(", ")}`,
    );
  return bank.join("_") as VlanBank;
}

function vlanForSlot(slotId: SlotId, status: VH113Status): number {
  const bank = (slotId.startsWith("red") ? status.redVlans : status.blueVlans)
    .split("_")
    .map(Number);
  return bank[slotPosition(slotId)]!;
}

function inferredTeamNumber(ssid: string): number | undefined {
  const match = /^(?:FRC-)?([1-9]\d*)$/i.exec(ssid);
  return match ? Number(match[1]) : undefined;
}

function normalizedBaseUrl(address: string): URL {
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(address)
    ? address
    : `http://${address}`;
  const url = new URL(withScheme);
  if (!url.port && !/^[a-z][a-z\d+.-]*:\/\//i.test(address)) url.port = "8081";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

/** Adapter for the frc-radio-api shipped on the VH-113 field access point. */
export class VH113AccessPoint implements AccessPoint {
  private readonly info: AccessPointInfo;
  private readonly baseUrl: URL;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly applyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly channel?: number;
  private readonly channelBandwidth?: "20MHz" | "40MHz";
  private readonly syslogIpAddress?: string;
  private readonly fetch: Fetch;
  private readonly configurations = new Map<
    SlotId,
    TeamWirelessConfiguration
  >();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: VH113AccessPointOptions | AccessPointInfo) {
    const resolved: VH113AccessPointOptions =
      "info" in options ? options : { info: options };
    const address = resolved.baseUrl ?? resolved.info.managementAddress;
    if (!address)
      throw new TypeError("VH-113 requires baseUrl or info.managementAddress");
    this.info = {
      manufacturer: "Vivid Hosting",
      model: "VH-113",
      ...resolved.info,
    };
    this.baseUrl = normalizedBaseUrl(address);
    this.token = resolved.token;
    this.timeoutMs = resolved.timeoutMs ?? 5_000;
    this.applyTimeoutMs = resolved.applyTimeoutMs ?? 60_000;
    this.pollIntervalMs = resolved.pollIntervalMs ?? 500;
    this.channel = resolved.channel;
    this.channelBandwidth = resolved.channelBandwidth;
    this.syslogIpAddress = resolved.syslogIpAddress;
    this.fetch = resolved.fetch ?? globalThis.fetch.bind(globalThis);
    for (const [slotId, configuration] of Object.entries(
      resolved.initialConfigurations ?? {},
    )) {
      if (!isSlotId(slotId))
        throw new AccessPointSlotNotFoundError(
          `Unknown VH-113 station slot in initialConfigurations: ${slotId}`,
        );
      if (!configuration) continue;
      validateConfiguration(slotId, configuration);
      this.configurations.set(slotId, { ...configuration });
    }
  }

  async getInfo(): Promise<AccessPointInfo> {
    const status = await this.getStatus();
    return {
      ...this.info,
      ...(status.version ? { firmwareVersion: status.version } : {}),
    };
  }

  async getCapabilities(): Promise<AccessPointCapabilities> {
    await this.getStatus();
    return {
      maxStations: VH113_SLOT_IDS.length,
      slotIds: [...VH113_SLOT_IDS],
      supportsVlanAssignment: true,
      supportsAssociationStatus: true,
      supportedVlansBySlot: Object.fromEntries(
        VH113_SLOT_IDS.map((slotId) => [
          slotId,
          VLAN_BANKS.map((bank) => bank[slotPosition(slotId)]!),
        ]),
      ),
    };
  }

  async getStations(): Promise<AccessPointStation[]> {
    const status = await this.getStatus();
    return VH113_SLOT_IDS.flatMap((slotId) => {
      const station = status.stationStatuses[slotId];
      if (!station?.isLinked || !station.macAddress) return [];
      const configuration = this.configurationFromStatus(slotId, status);
      if (!configuration) return [];
      return [this.toStation(slotId, station, configuration)];
    });
  }

  configureTeam(
    slotId: string,
    configuration: TeamWirelessConfiguration,
  ): Promise<void> {
    const slot = this.requireSlot(slotId);
    validateConfiguration(slot, configuration);
    return this.serializedWrite(async () => {
      const status = await this.getStatus();
      this.assertCanPreserveOtherStations(status, slot);
      const next = new Map(this.configurations);
      next.set(slot, { ...configuration });
      await this.apply(next, status);
      this.configurations.clear();
      for (const [key, value] of next) this.configurations.set(key, value);
    });
  }

  clearTeam(slotId: string): Promise<void> {
    const slot = this.requireSlot(slotId);
    return this.serializedWrite(async () => {
      const status = await this.getStatus();
      this.assertCanPreserveOtherStations(status, slot);
      const next = new Map(this.configurations);
      next.delete(slot);
      await this.apply(next, status);
      this.configurations.delete(slot);
    });
  }

  async getStationStatus(slotId: string): Promise<AccessPointStationStatus> {
    const slot = this.requireSlot(slotId);
    const status = await this.getStatus();
    const remote = status.stationStatuses[slot];
    if (status.status === "ERROR")
      return { slotId, state: "error", message: "VH-113 reported ERROR" };
    if (!remote)
      return status.status === "ACTIVE"
        ? { slotId, state: "available" }
        : {
            slotId,
            state: "offline",
            message: `VH-113 is ${status.status}`,
          };
    const configuration = this.configurationFromStatus(slot, status);
    if (!configuration)
      return {
        slotId,
        state: "error",
        message: `Cannot infer a team number from VH-113 SSID '${remote.ssid}'`,
      };
    if (!remote.isLinked || !remote.macAddress)
      return {
        slotId,
        state: "configured",
        configuration,
        ...(status.status !== "ACTIVE"
          ? { message: `VH-113 is ${status.status}` }
          : {}),
      };
    return {
      slotId,
      state: "associated",
      configuration,
      station: this.toStation(slot, remote, configuration),
    };
  }

  private requireSlot(slotId: string): SlotId {
    if (!isSlotId(slotId))
      throw new AccessPointSlotNotFoundError(
        `Unknown VH-113 station slot: ${slotId}`,
      );
    return slotId;
  }

  private configurationFromStatus(
    slotId: SlotId,
    status: VH113Status,
  ): TeamWirelessConfiguration | undefined {
    const remote = status.stationStatuses[slotId];
    if (!remote) return undefined;
    const desired = this.configurations.get(slotId);
    const teamNumber =
      desired?.ssid === remote.ssid
        ? desired.teamNumber
        : inferredTeamNumber(remote.ssid);
    if (!teamNumber) return undefined;
    return {
      teamNumber,
      ssid: remote.ssid,
      vlanId: vlanForSlot(slotId, status),
      ...(desired?.ssid === remote.ssid && desired.wpaKey
        ? { wpaKey: desired.wpaKey }
        : {}),
    };
  }

  private toStation(
    slotId: SlotId,
    station: VH113NetworkStatus,
    configuration: TeamWirelessConfiguration,
  ): AccessPointStation {
    return {
      slotId,
      macAddress: station.macAddress.toUpperCase(),
      teamNumber: configuration.teamNumber,
      connected: station.isLinked,
      signalStrengthDbm: station.signalDbm,
      vlanId: configuration.vlanId,
      ssid: station.ssid,
    };
  }

  private assertCanPreserveOtherStations(
    status: VH113Status,
    changingSlot: SlotId,
  ): void {
    const unknown = VH113_SLOT_IDS.filter(
      (slotId) =>
        slotId !== changingSlot &&
        status.stationStatuses[slotId] !== null &&
        !this.configurations.has(slotId),
    );
    if (unknown.length > 0)
      throw new AccessPointOperationError(
        `Cannot safely update VH-113: plaintext configuration for existing slot(s) ${unknown.join(", ")} is unknown; provide initialConfigurations`,
      );
  }

  private async apply(
    configurations: Map<SlotId, TeamWirelessConfiguration>,
    current: VH113Status,
  ): Promise<void> {
    for (const [slotId, configuration] of configurations) {
      validateConfiguration(slotId, configuration);
    }
    const redBanks = banksForAlliance(configurations, "red");
    const blueBanks = banksForAlliance(configurations, "blue");
    if (redBanks.size > 1)
      throw new RangeError(
        "All configured red slots must use one VH-113 VLAN bank",
      );
    if (blueBanks.size > 1)
      throw new RangeError(
        "All configured blue slots must use one VH-113 VLAN bank",
      );
    let redVlans = [...redBanks][0] ?? current.redVlans;
    let blueVlans = [...blueBanks][0] ?? current.blueVlans;
    if (redVlans === blueVlans) {
      const alternatives: VlanBank[] = ["10_20_30", "40_50_60", "70_80_90"];
      if (redBanks.size === 0)
        redVlans = alternatives.find((bank) => bank !== blueVlans)!;
      else if (blueBanks.size === 0)
        blueVlans = alternatives.find((bank) => bank !== redVlans)!;
      else
        throw new RangeError(
          "VH-113 red and blue alliances must use different VLAN banks",
        );
    }

    const stationConfigurations = Object.fromEntries(
      [...configurations].map(([slotId, value]) => [
        slotId,
        { ssid: value.ssid, wpaKey: value.wpaKey! },
      ]),
    );
    await this.request("/configuration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(this.channel ? { channel: this.channel } : {}),
        ...(this.channelBandwidth
          ? { channelBandwidth: this.channelBandwidth }
          : {}),
        redVlans,
        blueVlans,
        stationConfigurations,
        ...(this.syslogIpAddress
          ? { syslogIpAddress: this.syslogIpAddress }
          : {}),
      }),
    });
    await this.waitForApplied(configurations, redVlans, blueVlans);
  }

  private async waitForApplied(
    configurations: Map<SlotId, TeamWirelessConfiguration>,
    redVlans: VlanBank,
    blueVlans: VlanBank,
  ): Promise<void> {
    const deadline = Date.now() + this.applyTimeoutMs;
    let lastStatus = "unknown";
    while (Date.now() <= deadline) {
      const status = await this.getStatus();
      lastStatus = status.status;
      if (status.status === "ERROR")
        throw new AccessPointOperationError(
          "VH-113 rejected the configuration",
        );
      if (
        status.status === "ACTIVE" &&
        status.redVlans === redVlans &&
        status.blueVlans === blueVlans &&
        (await this.matchesConfigurations(status, configurations))
      )
        return;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.pollIntervalMs),
      );
    }
    throw new AccessPointOperationError(
      `Timed out waiting for VH-113 configuration (last status: ${lastStatus})`,
    );
  }

  private async matchesConfigurations(
    status: VH113Status,
    configurations: Map<SlotId, TeamWirelessConfiguration>,
  ): Promise<boolean> {
    for (const slotId of VH113_SLOT_IDS) {
      const desired = configurations.get(slotId);
      const actual = status.stationStatuses[slotId];
      if (!desired) {
        if (actual !== null) return false;
        continue;
      }
      if (!actual || actual.ssid !== desired.ssid) return false;
      if (
        actual.hashedWpaKey &&
        actual.wpaKeySalt &&
        (await sha256(`${desired.wpaKey}${actual.wpaKeySalt}`)) !==
          actual.hashedWpaKey.toLowerCase()
      )
        return false;
    }
    return true;
  }

  private async getStatus(): Promise<VH113Status> {
    const value = await this.requestJson("/status");
    if (!isStatus(value))
      throw new AccessPointOperationError(
        "VH-113 returned an invalid status document",
      );
    return value;
  }

  private async requestJson(path: string): Promise<unknown> {
    const response = await this.request(path);
    try {
      return JSON.parse(await response.text());
    } catch (error) {
      throw new AccessPointOperationError(
        `VH-113 returned invalid JSON: ${String(error)}`,
      );
    }
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    try {
      const base = new URL(this.baseUrl);
      base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
      const url = new URL(path.replace(/^\//, ""), base);
      const response = await this.fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).trim();
        throw new AccessPointOperationError(
          `VH-113 ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof AccessPointOperationError) throw error;
      throw new AccessPointUnavailableError(
        `VH-113 request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private serializedWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }
}

function banksForAlliance(
  configurations: Map<SlotId, TeamWirelessConfiguration>,
  alliance: "red" | "blue",
): Set<VlanBank> {
  return new Set(
    [...configurations]
      .filter(([slotId]) => slotId.startsWith(alliance))
      .map(([slotId, configuration]) =>
        bankForConfiguration(slotId, configuration.vlanId),
      ),
  );
}

function isStatus(value: unknown): value is VH113Status {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<VH113Status>;
  const validBanks = new Set<VlanBank>(["10_20_30", "40_50_60", "70_80_90"]);
  if (
    typeof status.status !== "string" ||
    !validBanks.has(status.redVlans as VlanBank) ||
    !validBanks.has(status.blueVlans as VlanBank) ||
    !status.stationStatuses ||
    typeof status.stationStatuses !== "object"
  )
    return false;
  return VH113_SLOT_IDS.every((slotId) => {
    if (!(slotId in status.stationStatuses!)) return false;
    const station = status.stationStatuses![slotId];
    return (
      station === null ||
      (typeof station === "object" &&
        typeof station.ssid === "string" &&
        typeof station.hashedWpaKey === "string" &&
        typeof station.wpaKeySalt === "string" &&
        typeof station.isLinked === "boolean" &&
        typeof station.macAddress === "string" &&
        typeof station.signalDbm === "number")
    );
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class VH113Adapter extends VH113AccessPoint {}
