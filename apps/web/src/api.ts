export type TeamStatus =
  "provisioning" | "waiting-for-robot" | "online" | "offline" | "error";
export type PortRole =
  "client" | "ap-trunk" | "server" | "management" | "unused";

export interface WiredDevice {
  portId: string;
  label?: string;
  linkUp: boolean;
  mac?: string;
}

export interface TeamNetwork {
  id: string;
  teamNumber: number;
  vlanId: number;
  status: TeamStatus;
  accessPointId?: string;
  accessPointSlot?: string;
  robotOnline?: boolean;
  updatedAt?: string;
  ports?: WiredDevice[];
}

export interface SwitchPort {
  id: string;
  name: string;
  enabled: boolean;
  linkUp: boolean;
  speedMbps?: number;
  duplex?: "half" | "full";
  mode: "access" | "trunk";
  accessVlan?: number;
  taggedVlans?: number[];
  nativeVlan?: number;
  role: PortRole;
  teamNetworkId?: string;
  teamNumber?: number;
  label?: string;
  macs?: string[];
}

export interface SwitchInfo {
  id: string;
  name: string;
  managementAddress: string;
  model?: string;
  firmwareVersion?: string;
  ports: SwitchPort[];
}

export interface AccessPoint {
  id: string;
  name: string;
  managementAddress?: string;
  availableSlots?: number;
  online?: boolean;
}

export interface AppConfig {
  managementVlan: number;
  onboardingVlan: number;
  teamVlanStart: number;
  teamVlanEnd: number;
  portBounceDelayMs?: number;
}

export interface DhcpLease {
  ip: string;
  mac: string;
  vlanId?: number;
  hostname?: string;
  expiresAt?: string;
}

export interface SimulatorState {
  mode: "mock";
  config: AppConfig;
  teams: TeamNetwork[];
  switches: Array<{
    id: string;
    available: boolean;
    info?: Omit<SwitchInfo, "ports">;
    capabilities?: { maxPorts: number };
    ports?: Array<
      SwitchPort & {
        learnedMacs?: Array<{ mac: string; vlanId: number }>;
      }
    >;
    error?: string;
  }>;
  accessPoints: Array<{
    id: string;
    available: boolean;
    info?: { name: string; managementAddress?: string };
    capabilities?: { maxStations: number; slotIds: string[] };
    stations?: Array<{
      slotId: string;
      state: "available" | "configured" | "associated" | "error";
      configuration?: {
        teamNumber: number;
        ssid: string;
        vlanId: number;
      };
      station?: {
        macAddress: string;
        signalStrengthDbm?: number;
      };
    }>;
    error?: string;
  }>;
  leases: DhcpLease[];
  switchAvailable: boolean;
  accessPointAvailable: boolean;
}

export interface DashboardData {
  teams: TeamNetwork[];
  switches: SwitchInfo[];
  accessPoints: AccessPoint[];
  config: AppConfig;
}

type RawOverviewSwitch = {
  id: string;
  name?: string;
  displayName?: string;
  managementAddress?: string;
  model?: string;
  firmwareVersion?: string;
  ports?: Record<string, unknown>[];
  info?: Partial<SwitchInfo> & { displayName?: string };
  available?: boolean;
  error?: string;
};

type RawOverviewAccessPoint = {
  id: string;
  name?: string;
  managementAddress?: string;
  availableSlots?: number;
  online?: boolean;
  info?: { name?: string; displayName?: string; managementAddress?: string };
  capabilities?: { slotIds?: string[] };
  available?: boolean;
};

type RawWiredPort = {
  portId: string;
  label?: string;
  linkUp?: boolean;
  mac?: string;
};

function normalizePort(port: Record<string, unknown>): SwitchPort {
  const learned = Array.isArray(port.learnedMacs) ? port.learnedMacs : [];
  const macs = learned
    .map((entry) =>
      typeof entry === "object" && entry !== null && "mac" in entry
        ? String(entry.mac)
        : "",
    )
    .filter(Boolean);
  return {
    id: String(port.id),
    name: String(port.name ?? `Port ${port.id}`),
    enabled: Boolean(port.enabled),
    linkUp: Boolean(port.linkUp),
    speedMbps: typeof port.speedMbps === "number" ? port.speedMbps : undefined,
    duplex:
      port.duplex === "half" || port.duplex === "full"
        ? port.duplex
        : undefined,
    mode:
      port.mode === "trunk" || port.portType === "trunk" ? "trunk" : "access",
    accessVlan:
      typeof port.accessVlan === "number" ? port.accessVlan : undefined,
    taggedVlans: Array.isArray(port.taggedVlans)
      ? port.taggedVlans.filter((v): v is number => typeof v === "number")
      : undefined,
    nativeVlan:
      typeof port.nativeVlan === "number" ? port.nativeVlan : undefined,
    role: (port.role as PortRole) ?? "unused",
    teamNetworkId:
      typeof port.teamNetworkId === "string" ? port.teamNetworkId : undefined,
    teamNumber:
      typeof port.teamNumber === "number" ? port.teamNumber : undefined,
    label: typeof port.label === "string" ? port.label : undefined,
    macs,
  };
}

const configDefaults: AppConfig = {
  managementVlan: 100,
  onboardingVlan: 999,
  teamVlanStart: 10,
  teamVlanEnd: 90,
  portBounceDelayMs: 450,
};

export const emptyData: DashboardData = {
  config: configDefaults,
  teams: [],
  accessPoints: [],
  switches: [],
};

export const demoData: DashboardData = {
  config: configDefaults,
  teams: [
    {
      id: "team-5712",
      teamNumber: 5712,
      vlanId: 30,
      status: "online",
      accessPointId: "vh-113-01",
      accessPointSlot: "station-2",
      robotOnline: true,
      ports: [
        {
          portId: "3",
          label: "Driver Station",
          linkUp: true,
          mac: "AA:57:12:03:01:01",
        },
      ],
    },
    {
      id: "team-862",
      teamNumber: 862,
      vlanId: 31,
      status: "online",
      accessPointId: "vh-113-01",
      accessPointSlot: "station-1",
      robotOnline: true,
      ports: [
        {
          portId: "4",
          label: "Driver Station",
          linkUp: true,
          mac: "AA:08:62:04:01:01",
        },
      ],
    },
    {
      id: "team-302",
      teamNumber: 302,
      vlanId: 32,
      status: "waiting-for-robot",
      accessPointId: "vh-113-01",
      accessPointSlot: "station-3",
      robotOnline: false,
      ports: [],
    },
  ],
  accessPoints: [
    {
      id: "vh-113-01",
      name: "VH-113 · Field AP",
      managementAddress: "10.100.0.12",
      availableSlots: 3,
      online: true,
    },
  ],
  switches: [
    {
      id: "switch-01",
      name: "Pit Row Switch 01",
      managementAddress: "10.100.0.10",
      model: "Mock 24-port managed switch",
      firmwareVersion: "simulated",
      ports: Array.from({ length: 24 }, (_, index) => {
        const number = index + 1;
        const team =
          number === 3
            ? { id: "team-5712", teamNumber: 5712, vlanId: 30 }
            : number === 4
              ? { id: "team-862", teamNumber: 862, vlanId: 31 }
              : undefined;
        return {
          id: String(number),
          name: `Port ${number}`,
          enabled: true,
          linkUp: [3, 4, 8].includes(number),
          speedMbps: 1000,
          duplex: "full" as const,
          mode: "access" as const,
          accessVlan: team?.vlanId ?? 999,
          role: "client" as PortRole,
          teamNetworkId: team?.id,
          teamNumber: team?.teamNumber,
          label:
            number === 3 || number === 4
              ? "Driver Station"
              : number === 8
                ? "Unassigned laptop"
                : undefined,
          macs:
            number === 3
              ? ["AA:57:12:03:01:01"]
              : number === 4
                ? ["AA:08:62:04:01:01"]
                : number === 8
                  ? ["AA:BB:CC:DD:EE:FF"]
                  : [],
        } satisfies SwitchPort;
      }),
    },
  ],
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      throw new Error(
        parsed.error?.message ?? `Request failed (${response.status})`,
      );
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(text || `Request failed (${response.status})`, {
          cause: error,
        });
      throw error;
    }
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  async getDashboard(): Promise<DashboardData> {
    const overview = await request<{
      teamNetworks?: (TeamNetwork & { wiredPorts?: RawWiredPort[] })[];
      switches?: RawOverviewSwitch[];
      accessPoints?: RawOverviewAccessPoint[];
      config?: Partial<AppConfig>;
    }>("/overview");
    const teams = (overview.teamNetworks ?? []).map(
      ({ wiredPorts, ...team }) => ({
        ...team,
        ports: (wiredPorts ?? team.ports ?? []).map((wired) => ({
          ...wired,
          linkUp: wired.linkUp ?? false,
        })),
      }),
    );
    const switches = await Promise.all(
      (overview.switches ?? []).map(async (item) => {
        const info = item.info ?? item;
        let rawPorts: Record<string, unknown>[] = item.ports ?? [];
        if (item.available !== false && rawPorts.length === 0) {
          try {
            const result = await request<{ ports?: Record<string, unknown>[] }>(
              `/switches/${item.id}/ports`,
            );
            rawPorts = result.ports ?? [];
          } catch {
            /* keep an available switch visible even when its port query is unavailable */
          }
        }
        return {
          id: item.id,
          name: info.name ?? info.displayName ?? item.id,
          managementAddress: info.managementAddress ?? "—",
          model: info.model,
          firmwareVersion: info.firmwareVersion,
          ports: rawPorts.map(normalizePort),
        } satisfies SwitchInfo;
      }),
    );
    const accessPoints = (overview.accessPoints ?? []).map(
      (item) =>
        ({
          id: item.id,
          name:
            item.info?.name ?? item.info?.displayName ?? item.name ?? item.id,
          managementAddress:
            item.info?.managementAddress ?? item.managementAddress,
          availableSlots:
            item.availableSlots ?? item.capabilities?.slotIds?.length,
          online: item.online ?? item.available !== false,
        }) satisfies AccessPoint,
    );
    // The API stores wired ports as assignments on a team. Reflect those assignments in switch port cards.
    for (const team of teams) {
      for (const wired of team.ports ?? []) {
        for (const switchInfo of switches) {
          const port = switchInfo.ports.find(
            (candidate) => candidate.id === wired.portId,
          );
          if (port) {
            port.teamNetworkId = team.id;
            port.teamNumber = team.teamNumber;
            port.label = wired.label ?? port.label;
            port.linkUp = wired.linkUp ?? port.linkUp;
            if (wired.mac)
              port.macs = [...new Set([...(port.macs ?? []), wired.mac])];
          }
        }
      }
    }
    return {
      teams,
      switches,
      accessPoints,
      config: { ...configDefaults, ...(overview.config ?? {}) },
    };
  },
  createTeam: (teamNumber: number) =>
    request<TeamNetwork>("/team-networks", {
      method: "POST",
      body: JSON.stringify({ teamNumber }),
    }),
  deleteTeam: (id: string) =>
    request<void>(`/team-networks/${id}`, { method: "DELETE" }),
  assignPort: (switchId: string, portId: string, teamNetworkId: string) =>
    request<SwitchPort>(`/switches/${switchId}/ports/${portId}`, {
      method: "PATCH",
      body: JSON.stringify({ teamNetworkId }),
    }),
  returnPortToOnboarding: (switchId: string, portId: string) =>
    request<SwitchPort>(`/switches/${switchId}/ports/${portId}`, {
      method: "PATCH",
      body: JSON.stringify({ teamNetworkId: null }),
    }),
  bouncePort: (switchId: string, portId: string) =>
    request<void>(`/switches/${switchId}/ports/${portId}/bounce`, {
      method: "POST",
    }),
  setPortEnabled: (switchId: string, portId: string, enabled: boolean) =>
    request<SwitchPort>(`/switches/${switchId}/ports/${portId}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  setPortRole: (switchId: string, portId: string, role: PortRole) =>
    request<SwitchPort>(`/switches/${switchId}/ports/${portId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  reconnectPortal: (teamNumber: number) =>
    request<{
      teamNetworkId: string;
      switchId: string;
      portId: string;
      vlanId: number;
    }>("/portal/connect", {
      method: "POST",
      body: JSON.stringify({ teamNumber, ip: "10.99.0.42" }),
    }),
  getReconciliation: () => request<unknown>("/reconciliation"),
  simulator: {
    getState: () => request<SimulatorState>("/dev/state"),
    reset: (mode: "hardware-to-desired" | "seeded-demo") =>
      request<void>("/dev/reset", {
        method: "POST",
        body: JSON.stringify({ mode }),
      }),
    patchPort: (
      switchId: string,
      portId: string,
      change: {
        enabled?: boolean;
        linkUp?: boolean;
        mac?: string;
        ip?: string;
        vlanId?: number;
        clearMacs?: boolean;
      },
    ) =>
      request<SwitchPort>(`/dev/switches/${switchId}/ports/${portId}`, {
        method: "POST",
        body: JSON.stringify(change),
      }),
    createLease: (lease: DhcpLease) =>
      request<DhcpLease>("/dev/dhcp/leases", {
        method: "POST",
        body: JSON.stringify(lease),
      }),
    deleteLease: (ip: string) =>
      request<void>(`/dev/dhcp/leases/${encodeURIComponent(ip)}`, {
        method: "DELETE",
      }),
    setStation: (
      accessPointId: string,
      slotId: string,
      state: { associated: boolean; mac?: string; signalStrengthDbm?: number },
    ) =>
      request<unknown>(
        `/dev/access-points/${accessPointId}/stations/${slotId}`,
        {
          method: "POST",
          body: JSON.stringify(state),
        },
      ),
    setLink: (switchId: string, portId: string, linkUp: boolean) =>
      request<void>(`/dev/switches/${switchId}/ports/${portId}`, {
        method: "POST",
        body: JSON.stringify({ linkUp }),
      }),
    setApOnline: (id: string, online: boolean) =>
      request<void>(`/dev/access-points/${id}/availability`, {
        method: "POST",
        body: JSON.stringify({ available: online }),
      }),
    setSwitchOnline: (id: string, online: boolean) =>
      request<void>(`/dev/switches/${id}/availability`, {
        method: "POST",
        body: JSON.stringify({ available: online }),
      }),
  },
};
