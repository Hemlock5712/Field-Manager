import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  api,
  demoData,
  type DashboardData,
  type DhcpLease,
  type SimulatorState,
  type SwitchPort,
  type TeamNetwork,
  type TeamStatus,
} from "./api";

const Icon = ({ name, size = 18 }: { name: string; size?: number }) => {
  const paths: Record<string, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="6" height="6" rx="1" />
        <rect x="15" y="3" width="6" height="6" rx="1" />
        <rect x="3" y="15" width="6" height="6" rx="1" />
        <rect x="15" y="15" width="6" height="6" rx="1" />
      </>
    ),
    radio: (
      <>
        <path d="M12 20a8 8 0 1 0-8-8" />
        <path d="M12 16a4 4 0 1 0-4-4" />
        <circle cx="12" cy="12" r="1.5" />
      </>
    ),
    activity: <path d="M3 12h4l2-7 4 14 2-7h6" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.4 1.4-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-2v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L9 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H7.7v-2h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L9 9l1.4-1.4.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.2h2v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 9l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v2h-.2a1.7 1.7 0 0 0-1.5 1Z" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14M5 12h14" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14M13 6l6 6-6 6" />
      </>
    ),
    close: (
      <>
        <path d="m6 6 12 12M18 6 6 18" />
      </>
    ),
    port: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h4" />
      </>
    ),
    server: (
      <>
        <rect x="4" y="3" width="16" height="7" rx="1" />
        <rect x="4" y="14" width="16" height="7" rx="1" />
        <path d="M8 6h.01M8 17h.01" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 11a8.1 8.1 0 0 0-14.6-3L3 11" />
        <path d="M3 5v6h6M4 13a8.1 8.1 0 0 0 14.6 3L21 13" />
        <path d="M21 19v-6h-6" />
      </>
    ),
    external: (
      <>
        <path d="M14 4h6v6M20 4l-9 9" />
        <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </>
    ),
    wifi: (
      <>
        <path d="M5 12.5a11 11 0 0 1 14 0M8 16a6.5 6.5 0 0 1 8 0M11 19.2a2 2 0 0 1 2 0" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
};

function statusLabel(status: TeamStatus) {
  return status === "waiting-for-robot"
    ? "Waiting for robot"
    : status.replaceAll("-", " ");
}

function StatusDot({
  status,
  label,
}: {
  status: TeamStatus | "onboarding" | "link-down";
  label?: string;
}) {
  const tone =
    status === "online"
      ? "online"
      : status === "error" || status === "link-down"
        ? "error"
        : status === "waiting-for-robot"
          ? "waiting"
          : "neutral";
  return (
    <span className={`status ${tone}`}>
      <i />
      {label ??
        (status === "link-down"
          ? "Link down"
          : statusLabel(status as TeamStatus))}
    </span>
  );
}

function TeamCard({
  team,
  onSelect,
  onDisconnect,
  selected,
}: {
  team: TeamNetwork;
  onSelect: () => void;
  onDisconnect: () => void;
  selected: boolean;
}) {
  const connected = team.ports?.filter((port) => port.linkUp).length ?? 0;
  return (
    <article className={`team-card ${selected ? "selected" : ""}`}>
      <button
        className="team-open"
        aria-label={`Inspect Team ${team.teamNumber}`}
        onClick={onSelect}
      />
      <div className="team-card-top">
        <span className="eyebrow">ROBOT NETWORK</span>
        <StatusDot status={team.status} />
      </div>
      <strong className="team-number">{team.teamNumber}</strong>
      <div className="team-card-meta">
        <span>VLAN {team.vlanId}</span>
        <span>{team.accessPointSlot ?? "AP unassigned"}</span>
      </div>
      <div className="team-card-foot">
        <span>
          <i className={`mini-dot ${team.robotOnline ? "on" : ""}`} />
          {team.robotOnline ? "Robot connected" : "Robot not seen"}
        </span>
        <span>{connected} wired</span>
      </div>
      <button
        className="team-remove"
        aria-label={`Disconnect Team ${team.teamNumber}`}
        title="Disconnect team network"
        onClick={(event) => {
          event.stopPropagation();
          onDisconnect();
        }}
      >
        <Icon name="close" size={13} />
      </button>
    </article>
  );
}

function SwitchRack({
  switchInfo,
  selectedId,
  onSelect,
}: {
  switchInfo: DashboardData["switches"][number];
  selectedId?: string;
  onSelect: (port: SwitchPort) => void;
}) {
  const ports = switchInfo.ports;
  return (
    <section className="switch-panel panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">PHYSICAL FABRIC</span>
          <h2>
            {switchInfo.name} <small>{ports.length} ports</small>
          </h2>
        </div>
        <span className="live-pill">
          <i /> live telemetry
        </span>
      </div>
      <div className="switch-meta">
        <span>
          <b className="green-dot" />
          Online
        </span>
        <span>
          <Icon name="server" size={14} />{" "}
          {switchInfo.model ?? "Managed switch"}
        </span>
        <span>{switchInfo.managementAddress}</span>
      </div>
      <div className="port-grid" aria-label="Switch ports">
        {ports.map((port) => (
          <button
            key={port.id}
            className={`switch-port ${port.linkUp ? "link-up" : ""} ${port.enabled ? "" : "disabled"} ${port.teamNumber ? "assigned" : "onboarding"} ${selectedId === port.id ? "is-selected" : ""}`}
            onClick={() => onSelect(port)}
            aria-label={`Port ${port.id}, ${port.enabled ? (port.linkUp ? "link up" : "link down") : "administratively disabled"}${port.teamNumber ? `, Team ${port.teamNumber}` : ""}`}
            title={`Port ${port.id} · ${port.enabled ? (port.linkUp ? "link up" : "link down") : "disabled"}`}
          >
            <span className="port-number">{port.id}</span>
            <span className="port-state">
              {!port.enabled ? "OFF" : port.linkUp ? <i /> : "—"}
            </span>
            {port.teamNumber && (
              <span className="port-team">{port.teamNumber}</span>
            )}
          </button>
        ))}
      </div>
      <div className="legend">
        <span>
          <i className="legend-swatch assigned" /> assigned
        </span>
        <span>
          <i className="legend-swatch onboarding" /> onboarding
        </span>
        <span>
          <i className="legend-swatch down" /> link down
        </span>
      </div>
    </section>
  );
}

function PortInspector({
  port,
  teams,
  switchId,
  onClose,
  onUpdate,
  onRefresh,
  usingDemo,
}: {
  port: SwitchPort;
  teams: TeamNetwork[];
  switchId: string;
  onClose: () => void;
  onUpdate: (port: SwitchPort) => void;
  onRefresh: () => Promise<void>;
  usingDemo: boolean;
}) {
  const [working, setWorking] = useState(false);
  const [operationError, setOperationError] = useState("");
  const run = async (
    operation: () => Promise<SwitchPort | void>,
    optimistic?: SwitchPort,
  ) => {
    setWorking(true);
    setOperationError("");
    try {
      await operation();
      await onRefresh();
    } catch (error) {
      if (usingDemo && optimistic) onUpdate(optimistic);
      setOperationError(
        error instanceof Error ? error.message : "The port action failed.",
      );
    } finally {
      setWorking(false);
    }
  };
  const currentTeam = teams.find((team) => team.id === port.teamNetworkId);
  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div>
          <span className="eyebrow">PORT INSPECTOR</span>
          <h2>Port {port.id}</h2>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close inspector"
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="inspector-status">
        <StatusDot
          status={port.linkUp ? "online" : "link-down"}
          label={port.linkUp ? "Link active" : "Link down"}
        />
        <span>{port.enabled ? "Enabled" : "Disabled"}</span>
      </div>
      <div className="inspector-facts">
        <div>
          <span>Assigned VLAN</span>
          <b>{port.accessVlan ?? "—"}</b>
        </div>
        <div>
          <span>Role</span>
          <b>{port.role}</b>
        </div>
        <div>
          <span>Speed</span>
          <b>{port.speedMbps ? `${port.speedMbps} Mbps` : "—"}</b>
        </div>
        <div>
          <span>Duplex</span>
          <b>{port.duplex ?? "—"}</b>
        </div>
      </div>
      <div className="inspector-block">
        <span className="eyebrow">ASSIGNMENT</span>
        {currentTeam ? (
          <div className="assignment">
            <span className="team-mark small">
              {String(currentTeam.teamNumber).slice(-2)}
            </span>
            <div>
              <strong>Team {currentTeam.teamNumber}</strong>
              <span>VLAN {currentTeam.vlanId}</span>
            </div>
          </div>
        ) : (
          <p className="muted">
            This client port is on the onboarding VLAN. Assign it once the
            laptop is identified.
          </p>
        )}
        <label className="select-label">
          Move to team
          <select
            value={port.teamNetworkId ?? ""}
            onChange={(event) => {
              const team = teams.find((item) => item.id === event.target.value);
              if (team)
                void run(() => api.assignPort(switchId, port.id, team.id), {
                  ...port,
                  teamNetworkId: team.id,
                  teamNumber: team.teamNumber,
                  accessVlan: team.vlanId,
                });
            }}
            disabled={working}
          >
            <option value="">Select a team…</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                Team {team.teamNumber} · VLAN {team.vlanId}
              </option>
            ))}
          </select>
        </label>
        {!currentTeam && (
          <label className="select-label">
            Port role
            <select
              value={port.role}
              disabled={working}
              onChange={(event) =>
                void run(() =>
                  api.setPortRole(
                    switchId,
                    port.id,
                    event.target.value as SwitchPort["role"],
                  ),
                )
              }
            >
              <option value="client">Client</option>
              <option value="unused">Unused</option>
              <option value="ap-trunk">AP trunk</option>
              <option value="server">Server</option>
              <option value="management">Management</option>
            </select>
          </label>
        )}
      </div>
      {port.macs?.length ? (
        <div className="inspector-block">
          <span className="eyebrow">LEARNED DEVICES</span>
          {port.macs.map((mac) => (
            <div className="mac-row" key={mac}>
              <span className="mac-icon">
                <Icon name="port" size={15} />
              </span>
              <code>{mac}</code>
              <span className="muted">dynamic</span>
            </div>
          ))}
        </div>
      ) : null}
      {operationError && <p className="form-error">{operationError}</p>}
      <div className="inspector-actions">
        <button
          className="button secondary"
          disabled={
            working || (port.role !== "client" && port.role !== "unused")
          }
          title={
            port.role !== "client" && port.role !== "unused"
              ? `Reserved ${port.role} ports cannot be returned to onboarding`
              : undefined
          }
          onClick={() =>
            void run(() => api.returnPortToOnboarding(switchId, port.id), {
              ...port,
              teamNetworkId: undefined,
              teamNumber: undefined,
              accessVlan: 999,
            })
          }
        >
          Return to onboarding
        </button>
        <button
          className="button secondary"
          disabled={working}
          onClick={() => void run(() => api.bouncePort(switchId, port.id))}
        >
          <Icon name="refresh" size={15} /> Bounce port
        </button>
        <button
          className={`button ${port.enabled ? "danger" : "primary"}`}
          disabled={working}
          onClick={() =>
            void run(
              () => api.setPortEnabled(switchId, port.id, !port.enabled),
              { ...port, enabled: !port.enabled },
            )
          }
        >
          {port.enabled ? "Disable port" : "Enable port"}
        </button>
      </div>
    </aside>
  );
}

function SimulationLab({
  data,
  switchInfo,
  selectedPortId,
  onSelectPort,
  onUpdatePort,
  onRefresh,
  onToast,
  usingDemo,
}: {
  data: DashboardData;
  switchInfo?: DashboardData["switches"][number];
  selectedPortId?: string;
  onSelectPort: (id: string) => void;
  onUpdatePort: (port: SwitchPort) => void;
  onRefresh: () => Promise<void>;
  onToast: (message: string) => void;
  usingDemo: boolean;
}) {
  const ports = switchInfo?.ports ?? [];
  const selectedPort =
    ports.find((port) => port.id === selectedPortId) ?? ports[0];
  const [enabled, setEnabled] = useState(selectedPort?.enabled ?? true);
  const [linkUp, setLinkUp] = useState(selectedPort?.linkUp ?? false);
  const [mac, setMac] = useState("AA:BB:CC:DD:EE:FF");
  const [ip, setIp] = useState("10.99.0.42");
  const [vlanId, setVlanId] = useState(
    String(selectedPort?.accessVlan ?? data.config.onboardingVlan),
  );
  const [simulationState, setSimulationState] = useState<SimulatorState>();
  const [fallbackLeases, setFallbackLeases] = useState<DhcpLease[]>([]);
  const [slotId, setSlotId] = useState("slot-2");
  const [associated, setAssociated] = useState(true);
  const [signalDbm, setSignalDbm] = useState("-48");
  const [working, setWorking] = useState(false);
  const simulatedSwitch = simulationState?.switches[0];
  const simulatedAccessPoint = simulationState?.accessPoints[0];
  const switchId = simulatedSwitch?.id ?? switchInfo?.id;
  const accessPointId = simulatedAccessPoint?.id ?? data.accessPoints[0]?.id;
  const switchOnline =
    simulatedSwitch?.available ?? simulationState?.switchAvailable ?? true;
  const apOnline =
    simulatedAccessPoint?.available ??
    simulationState?.accessPointAvailable ??
    data.accessPoints[0]?.online ??
    true;
  const stations = simulatedAccessPoint?.stations ?? [];
  const slotIds =
    simulatedAccessPoint?.capabilities?.slotIds ??
    stations.map((station) => station.slotId);
  const selectedStation = stations.find((station) => station.slotId === slotId);
  const leases = simulationState?.leases ?? fallbackLeases;

  const refreshSimulation = useCallback(async () => {
    try {
      const next = await api.simulator.getState();
      setSimulationState(next);
      setFallbackLeases([]);
    } catch {
      setSimulationState(undefined);
      if (usingDemo && fallbackLeases.length === 0)
        setFallbackLeases([
          {
            ip: "10.99.0.42",
            mac: "AA:BB:CC:DD:EE:FF",
            vlanId: data.config.onboardingVlan,
          },
        ]);
    }
  }, [data.config.onboardingVlan, fallbackLeases.length, usingDemo]);

  useEffect(() => {
    if (!selectedPort) return;
    setEnabled(selectedPort.enabled);
    setLinkUp(selectedPort.linkUp);
    setVlanId(String(selectedPort.accessVlan ?? data.config.onboardingVlan));
  }, [selectedPort, data.config.onboardingVlan]);
  useEffect(() => {
    void refreshSimulation();
  }, [data, refreshSimulation]);
  useEffect(() => {
    if (!selectedStation) return;
    setAssociated(selectedStation.state === "associated");
    setSignalDbm(String(selectedStation.station?.signalStrengthDbm ?? -55));
  }, [selectedStation]);

  const patchPort = async (
    change: Parameters<typeof api.simulator.patchPort>[2],
    fallback: SwitchPort,
  ) => {
    if (!selectedPort || !switchId) return;
    setWorking(true);
    try {
      await api.simulator.patchPort(switchId, selectedPort.id, change);
      await onRefresh();
      await refreshSimulation();
    } catch {
      if (usingDemo) onUpdatePort(fallback);
      onToast(
        usingDemo
          ? "Simulator API unavailable; the change is local to this session."
          : "Simulator change failed; hardware state was not changed.",
      );
    } finally {
      setWorking(false);
    }
  };
  const setAvailability = async (kind: "switch" | "access-point") => {
    const current = kind === "switch" ? switchOnline : apOnline;
    const id = kind === "switch" ? switchId : accessPointId;
    if (!id) return;
    try {
      if (kind === "switch") await api.simulator.setSwitchOnline(id, !current);
      else await api.simulator.setApOnline(id, !current);
      await onRefresh();
      await refreshSimulation();
    } catch {
      onToast(
        usingDemo
          ? "Hardware availability requires the simulator API."
          : `${kind === "switch" ? "Switch" : "AP"} availability change failed; state was not changed.`,
      );
    }
  };
  const applyStation = async () => {
    if (!accessPointId) return;
    setWorking(true);
    try {
      await api.simulator.setStation(accessPointId, slotId, {
        associated,
        signalStrengthDbm: Number(signalDbm),
      });
      await onRefresh();
      await refreshSimulation();
    } catch {
      onToast(
        usingDemo
          ? "Station state changed in local simulation."
          : "Station update failed; hardware state was not changed.",
      );
    } finally {
      setWorking(false);
    }
  };
  const reset = async (scope: "hardware" | "demo") => {
    const mode = scope === "hardware" ? "hardware-to-desired" : "seeded-demo";
    const label = scope === "demo" ? "seeded demo data" : "simulated hardware";
    const consequence =
      scope === "demo"
        ? "This rebuilds demo teams, APs, links, and DHCP leases."
        : "Desired team assignments stay intact; learned links and MACs are repaired. DHCP leases are preserved.";
    if (!window.confirm(`Reset ${label}? ${consequence}`)) return;
    setWorking(true);
    try {
      await api.simulator.reset(mode);
      await onRefresh();
      await refreshSimulation();
      onToast(`${scope === "demo" ? "Demo" : "Hardware"} simulation reset.`);
    } catch {
      onToast("Reset endpoint unavailable; no state was changed.");
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="lab panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">DEVELOPMENT TOOL</span>
          <h2>Simulation lab</h2>
        </div>
        <span className="sim-badge">MOCK HARDWARE</span>
      </div>
      <p className="muted">
        Exercise the handoff chain with deterministic switch, DHCP, and AP
        state. These controls are development-only.
      </p>
      <div
        className="lab-hardware-row"
        aria-label="Simulated hardware availability"
      >
        <button
          className={`lab-toggle ${switchOnline ? "active" : ""}`}
          disabled={working || !switchId}
          onClick={() => void setAvailability("switch")}
        >
          <i /> Switch {switchOnline ? "available" : "offline"}
        </button>
        <button
          className={`lab-toggle ${apOnline ? "active" : ""}`}
          disabled={working || !accessPointId}
          onClick={() => void setAvailability("access-point")}
        >
          <i /> AP {apOnline ? "available" : "offline"}
        </button>
      </div>
      <div className="lab-section">
        <div className="lab-section-head">
          <span className="eyebrow">SWITCH PORT</span>
          <span className="muted">{ports.length} ports available</span>
        </div>
        <label className="lab-label">
          Selected port
          <select
            aria-label="Simulation port"
            value={selectedPort?.id ?? ""}
            onChange={(event) => onSelectPort(event.target.value)}
          >
            {ports.map((port) => (
              <option key={port.id} value={port.id}>
                Port {port.id}
                {port.teamNumber
                  ? ` · Team ${port.teamNumber}`
                  : " · onboarding"}
              </option>
            ))}
          </select>
        </label>
        <div className="lab-toggle-row">
          <button
            className={`lab-toggle ${enabled ? "active" : ""}`}
            disabled={working || !selectedPort}
            onClick={() => {
              if (selectedPort)
                void patchPort(
                  { enabled: !enabled },
                  { ...selectedPort, enabled: !enabled },
                );
            }}
          >
            <i /> Admin {enabled ? "enabled" : "disabled"}
          </button>
          <button
            className={`lab-toggle ${linkUp ? "active" : ""}`}
            disabled={working || !selectedPort}
            onClick={() => {
              if (selectedPort)
                void patchPort(
                  { linkUp: !linkUp },
                  { ...selectedPort, linkUp: !linkUp },
                );
            }}
          >
            <i /> Physical link {linkUp ? "up" : "down"}
          </button>
        </div>
        <div className="lab-fields">
          <label className="lab-label">
            Learn MAC
            <input
              aria-label="MAC address"
              value={mac}
              onChange={(event) => setMac(event.target.value)}
              placeholder="AA:BB:CC:DD:EE:FF"
            />
          </label>
          <label className="lab-label">
            VLAN
            <input
              aria-label="VLAN ID"
              inputMode="numeric"
              value={vlanId}
              onChange={(event) => setVlanId(event.target.value)}
            />
          </label>
        </div>
        <div className="lab-action-row">
          <button
            className="button secondary"
            disabled={working || !selectedPort}
            onClick={() => {
              if (selectedPort)
                void patchPort(
                  { mac, vlanId: Number(vlanId) },
                  {
                    ...selectedPort,
                    macs: [...(selectedPort.macs ?? []), mac],
                    linkUp: true,
                  },
                );
            }}
          >
            <Icon name="plus" size={14} /> Learn MAC
          </button>
          <button
            className="button secondary"
            disabled={working || !selectedPort}
            onClick={() => {
              if (selectedPort)
                void patchPort(
                  { clearMacs: true },
                  { ...selectedPort, macs: [] },
                );
            }}
          >
            Clear learned MACs
          </button>
        </div>
      </div>
      <div className="lab-section">
        <div className="lab-section-head">
          <span className="eyebrow">DHCP LEASE</span>
          <span className="muted">Correlate IP → MAC → port</span>
        </div>
        <div className="lab-fields">
          <label className="lab-label">
            Client IP
            <input
              aria-label="Client IP address"
              value={ip}
              onChange={(event) => setIp(event.target.value)}
            />
          </label>
          <label className="lab-label">
            MAC
            <input
              aria-label="Lease MAC address"
              value={mac}
              onChange={(event) => setMac(event.target.value)}
            />
          </label>
        </div>
        <button
          className="button secondary full"
          disabled={working}
          onClick={async () => {
            const lease = { ip, mac, vlanId: Number(vlanId) };
            try {
              const created = await api.simulator.createLease(lease);
              setFallbackLeases((current) => [
                ...current.filter((item) => item.ip !== ip),
                created,
              ]);
              await onRefresh();
              await refreshSimulation();
              onToast(`DHCP lease ${ip} added.`);
            } catch {
              if (usingDemo)
                setFallbackLeases((current) => [
                  ...current.filter((item) => item.ip !== ip),
                  lease,
                ]);
              onToast(
                usingDemo
                  ? "Lease added to local simulation."
                  : "Lease update failed; state was not changed.",
              );
            }
          }}
        >
          Add / update lease
        </button>
        {leases.length > 0 && (
          <div className="lease-list">
            {leases.map((lease) => (
              <div className="lease-row" key={lease.ip}>
                <code>{lease.ip}</code>
                <span>{lease.mac}</span>
                <button
                  aria-label={`Delete lease ${lease.ip}`}
                  onClick={async () => {
                    try {
                      await api.simulator.deleteLease(lease.ip);
                      if (usingDemo)
                        setFallbackLeases((current) =>
                          current.filter((item) => item.ip !== lease.ip),
                        );
                      else {
                        await onRefresh();
                        await refreshSimulation();
                      }
                    } catch {
                      if (usingDemo)
                        setFallbackLeases((current) =>
                          current.filter((item) => item.ip !== lease.ip),
                        );
                      onToast(
                        usingDemo
                          ? "Lease removed from local simulation."
                          : "Lease delete failed; state was not changed.",
                      );
                    }
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="lab-section">
        <div className="lab-section-head">
          <span className="eyebrow">ACCESS POINT</span>
          <span className="muted">VH-113 station simulation</span>
        </div>
        <div className="ap-control-row">
          <label className="lab-label inline">
            Slot
            <select
              aria-label="Access point station slot"
              value={slotId}
              onChange={(event) => setSlotId(event.target.value)}
            >
              {(slotIds.length
                ? slotIds
                : ["slot-1", "slot-2", "slot-3", "slot-4", "slot-5", "slot-6"]
              ).map((slot) => {
                const station = stations.find((item) => item.slotId === slot);
                return (
                  <option key={slot} value={slot}>
                    {slot}
                    {station?.configuration
                      ? ` · Team ${station.configuration.teamNumber}`
                      : " · free"}
                  </option>
                );
              })}
            </select>
          </label>
          <span className={`slot-state ${selectedStation?.state ?? "unknown"}`}>
            {selectedStation?.state ?? "state unavailable"}
          </span>
        </div>
        <div className="lab-fields">
          <label className="lab-label">
            Association
            <select
              aria-label="Robot association state"
              value={associated ? "associated" : "disconnected"}
              onChange={(event) =>
                setAssociated(event.target.value === "associated")
              }
            >
              <option value="associated">Robot associated</option>
              <option value="disconnected">Disconnected</option>
            </select>
          </label>
          <label className="lab-label">
            Signal
            <input
              aria-label="Signal strength dBm"
              value={signalDbm}
              onChange={(event) => setSignalDbm(event.target.value)}
            />
          </label>
        </div>
        <button
          className="button secondary full"
          disabled={working || !apOnline || !selectedStation?.configuration}
          onClick={() => void applyStation()}
        >
          Apply station state
        </button>
      </div>
      <div className="lab-footer">
        <span>
          <i className="green-dot" /> State is ephemeral
        </span>
        <div>
          <button
            className="text-button"
            disabled={working}
            onClick={() => void reset("hardware")}
          >
            Reset hardware
          </button>
          <button
            className="text-button destructive"
            disabled={working}
            onClick={() => void reset("demo")}
          >
            Reset demo data
          </button>
        </div>
      </div>
    </section>
  );
}

function CreateTeamModal({
  config,
  onClose,
  onCreate,
}: {
  config: DashboardData["config"];
  onClose: () => void;
  onCreate: (teamNumber: number) => Promise<void>;
}) {
  const [teamNumber, setTeamNumber] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const number = Number(teamNumber);
    if (!Number.isInteger(number) || number < 1 || number > 99999) {
      setError("Enter a valid FRC team number.");
      return;
    }
    setError("");
    setWorking(true);
    try {
      await onCreate(number);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to create team network.",
      );
    } finally {
      setWorking(false);
    }
  };
  return (
    <div
      className="modal-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <form className="modal" onSubmit={submit}>
        <div className="modal-top">
          <div>
            <span className="eyebrow">NEW NETWORK</span>
            <h2>Provision a team</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <p className="muted">
          A VLAN will be reserved from the configured pool and held for this
          team while the robot comes online.
        </p>
        <label className="form-label">
          FRC team number
          <input
            autoFocus
            inputMode="numeric"
            value={teamNumber}
            onChange={(event) => setTeamNumber(event.target.value)}
            placeholder="e.g. 5712"
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="allocation-preview">
          <span>Available VLAN range</span>
          <b>
            {config.teamVlanStart}–{config.teamVlanEnd}
          </b>
        </div>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={working}>
            {working ? "Provisioning…" : "Provision network"}
            <Icon name="arrow" size={15} />
          </button>
        </div>
      </form>
    </div>
  );
}

function Portal({
  onConnect,
}: {
  onConnect: (teamNumber: number) => Promise<TeamNetwork | undefined>;
}) {
  const [team, setTeam] = useState("");
  const [state, setState] = useState<"idle" | "working" | "success" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const number = Number(team);
    if (!number) {
      setState("error");
      setMessage("Enter your team number to continue.");
      return;
    }
    setState("working");
    try {
      const result = await onConnect(number);
      if (!result)
        throw new Error(
          "That team has not been configured yet. Ask an event operator to provision it first.",
        );
      setState("success");
      setMessage(
        `Port handoff complete for Team ${number}. Your laptop is joining VLAN ${result.vlanId}.`,
      );
    } catch (error) {
      setState("error");
      setMessage(
        error instanceof Error ? error.message : "Unable to complete handoff.",
      );
    }
  };
  return (
    <main className="portal-page">
      <div className="portal-noise" />
      <header className="portal-header">
        <span className="brand-mark">FM</span>
        <span>FIELD MANAGER</span>
        <span className="portal-badge">
          <i /> Practice network
        </span>
      </header>
      <section className="portal-content">
        <span className="eyebrow">ETHERNET ONBOARDING</span>
        <h1>
          Connect to your
          <br />
          <em>robot network.</em>
        </h1>
        <p>
          Enter your FRC team number. We’ll identify this cable and move it into
          your isolated team network.
        </p>
        <form className="portal-form" onSubmit={submit}>
          <label>
            Team number
            <input
              autoFocus
              inputMode="numeric"
              value={team}
              onChange={(event) => setTeam(event.target.value)}
              placeholder="5712"
            />
          </label>
          <button
            className="button primary large"
            disabled={state === "working"}
          >
            {state === "working" ? "Connecting…" : "Connect to team"}
            <Icon name="arrow" size={18} />
          </button>
        </form>
        {state !== "idle" && (
          <div className={`portal-message ${state}`}>
            <span className="message-icon">
              {state === "success" ? "✓" : "!"}
            </span>
            <span>{message}</span>
          </div>
        )}
        <div className="portal-foot">
          <span>
            <i className="green-dot" /> Link detected
          </span>
          <span>Need help? Find an event operator.</span>
        </div>
      </section>
      <footer className="portal-footer">
        <span>Field Manager · Practice networks</span>
        <a href="/">
          Operator dashboard <Icon name="external" size={13} />
        </a>
      </footer>
    </main>
  );
}

export function App() {
  const isPortal = window.location.pathname.startsWith("/portal");
  const [data, setData] = useState<DashboardData>(demoData);
  const [usingDemo, setUsingDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedPortId, setSelectedPortId] = useState<string>();
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [activeNav, setActiveNav] = useState("Overview");
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const remote = await api.getDashboard();
      if (remote.switches.length || remote.teams.length) {
        setData(remote);
        setUsingDemo(false);
      } else throw new Error("empty");
    } catch {
      setUsingDemo(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const switchInfo = data.switches[0];
  const allPorts = switchInfo?.ports ?? [];
  const selectedPort = selectedPortId
    ? allPorts.find((port) => port.id === selectedPortId)
    : undefined;
  const selectedTeam = selectedPort?.teamNetworkId
    ? data.teams.find((team) => team.id === selectedPort.teamNetworkId)
    : undefined;
  const updatePort = (updated: SwitchPort) => {
    if (!switchInfo) return;
    setData((current) => ({
      ...current,
      switches: current.switches.map((item) =>
        item.id === switchInfo.id
          ? {
              ...item,
              ports: item.ports.map((port) =>
                port.id === updated.id ? { ...port, ...updated } : port,
              ),
            }
          : item,
      ),
      teams: current.teams
        .map((team) => ({
          ...team,
          ports: team.ports?.filter((port) => port.portId !== updated.id) ?? [],
        }))
        .map((team) =>
          team.id === updated.teamNetworkId
            ? {
                ...team,
                ports: [
                  ...(team.ports ?? []),
                  {
                    portId: updated.id,
                    label: updated.label,
                    linkUp: updated.linkUp,
                    mac: updated.macs?.[0],
                  },
                ],
              }
            : team,
        ),
    }));
    // The inspector is keyed by ID, so it re-reads the fresh port from state after every mutation.
  };
  const createTeam = async (teamNumber: number) => {
    if (!usingDemo) {
      const created = await api.createTeam(teamNumber);
      setData((current) => ({
        ...current,
        teams: [...current.teams, created],
      }));
    } else {
      const nextVlan = Math.max(
        data.config.teamVlanStart,
        ...data.teams.map((team) => team.vlanId + 1),
      );
      const localTeam: TeamNetwork = {
        id: `team-${teamNumber}`,
        teamNumber,
        vlanId: nextVlan,
        status: "provisioning",
        robotOnline: false,
        ports: [],
      };
      setData((current) => ({
        ...current,
        teams: [...current.teams, localTeam],
      }));
    }
    setToast(`Team ${teamNumber} network is ready to configure.`);
  };
  const connectPortal = async (teamNumber: number) => {
    try {
      const response = await api.reconnectPortal(teamNumber);
      const connected = data.teams.find(
        (team) => team.id === response.teamNetworkId,
      );
      if (connected) return connected;
    } catch (error) {
      if (!usingDemo) throw error;
    }
    const team = data.teams.find((item) => item.teamNumber === teamNumber);
    if (!team) return undefined;
    setToast(`Portal handoff simulated for Team ${teamNumber}.`);
    return team;
  };
  const disconnectTeam = async (team: TeamNetwork) => {
    if (
      !window.confirm(
        `Disconnect Team ${team.teamNumber} and return its ports to onboarding?`,
      )
    )
      return;
    try {
      if (!usingDemo) await api.deleteTeam(team.id);
      setData((current) => ({
        ...current,
        teams: current.teams.filter((item) => item.id !== team.id),
      }));
      setSelectedPortId(undefined);
      setToast(`Team ${team.teamNumber} was disconnected.`);
      if (!usingDemo) await refresh();
    } catch (error) {
      setToast(
        error instanceof Error
          ? error.message
          : "Unable to disconnect the team network.",
      );
    }
  };
  const assignPort = (port: SwitchPort) => {
    setSelectedPortId(port.id);
  };
  const connectedCount = allPorts.filter((port) => port.linkUp).length;
  const onboardingClient = allPorts.find(
    (port) =>
      port.enabled &&
      port.linkUp &&
      !port.teamNetworkId &&
      (port.role === "client" || port.role === "unused"),
  );
  const assignedLinkCount = allPorts.filter(
    (port) => port.linkUp && port.teamNetworkId,
  ).length;
  const disabledPortCount = allPorts.filter((port) => !port.enabled).length;
  const onlineCount = data.teams.filter(
    (team) => team.status === "online",
  ).length;
  const navItems = [
    { label: "Overview", icon: "grid" },
    { label: "Team networks", icon: "radio" },
    { label: "Switch ports", icon: "port" },
    { label: "Diagnostics", icon: "activity" },
  ];
  if (isPortal) return <Portal onConnect={connectPortal} />;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">FM</span>
          <div>
            <strong>
              FIELD
              <br />
              MANAGER
            </strong>
            <small>NETWORK CONSOLE</small>
          </div>
        </div>
        <div className="event-context">
          <span className="eyebrow">ACTIVE FIELD</span>
          <strong>Practice field A</strong>
          <span className="muted">
            <i className="green-dot" /> Local simulation
          </span>
        </div>
        <nav>
          {navItems.map((item) => (
            <button
              key={item.label}
              className={activeNav === item.label ? "active" : ""}
              onClick={() => setActiveNav(item.label)}
            >
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
              {item.label === "Team networks" && <b>{data.teams.length}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a href="/portal" target="_blank">
            <Icon name="external" size={15} /> Open captive portal
          </a>
          <button
            onClick={() =>
              setToast("Settings are managed by the field configuration.")
            }
          >
            <Icon name="settings" size={16} /> Settings
          </button>
          <div className="operator">
            <span className="avatar">OP</span>
            <span>
              <strong>Event operator</strong>
              <small>Administrator</small>
            </span>
            <span className="online-indicator" />
          </div>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="crumbs">
            <span>FIELD / PRACTICE A</span>
            <span className="slash">/</span>
            <strong>{activeNav.toUpperCase()}</strong>
          </div>
          <div className="top-actions">
            <span className={`connection-chip ${usingDemo ? "demo" : ""}`}>
              <i />
              {usingDemo ? "Demo snapshot" : "API connected"}
            </span>
            <button
              className="icon-button"
              onClick={() => void refresh()}
              aria-label="Refresh data"
            >
              <Icon name="refresh" size={17} />
            </button>
            <span className="top-time">
              {new Date().toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        </header>
        <div className="content">
          <div className="page-intro">
            <div>
              <span className="eyebrow">
                FIELD OPERATIONS ·{" "}
                {new Date()
                  .toLocaleDateString([], {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                  .toUpperCase()}
              </span>
              <h1>Network overview</h1>
              <p>
                Keep each team’s robot network reachable, isolated, and ready
                for practice.
              </p>
            </div>
            <button
              className="button primary"
              onClick={() => setModalOpen(true)}
            >
              <Icon name="plus" size={16} /> Provision team
            </button>
          </div>
          {usingDemo && (
            <div className="demo-banner">
              <span>
                <i className="spark" /> You’re viewing the simulated field
              </span>
              <span>
                API unavailable — changes stay in this browser session.
              </span>
              <button onClick={() => void refresh()}>Retry connection</button>
            </div>
          )}
          <section className="metrics">
            <div>
              <span className="eyebrow">TEAM NETWORKS</span>
              <strong>{data.teams.length.toString().padStart(2, "0")}</strong>
              <span className="metric-note">
                <i className="green-dot" /> {onlineCount} online
              </span>
            </div>
            <div>
              <span className="eyebrow">ACTIVE LINKS</span>
              <strong>{connectedCount.toString().padStart(2, "0")}</strong>
              <span className="metric-note">
                of {allPorts.length} switch ports
              </span>
            </div>
            <div>
              <span className="eyebrow">ONBOARDING</span>
              <strong>
                {allPorts
                  .filter((port) => !port.teamNumber)
                  .length.toString()
                  .padStart(2, "0")}
              </strong>
              <span className="metric-note">ports available</span>
            </div>
            <div>
              <span className="eyebrow">VLAN POOL</span>
              <strong>
                {data.config.teamVlanStart}–{data.config.teamVlanEnd}
              </strong>
              <span className="metric-note">
                {data.config.onboardingVlan} onboarding
              </span>
            </div>
          </section>
          <div className="section-heading">
            <div>
              <span className="eyebrow">ISOLATED NETWORKS</span>
              <h2>Team networks</h2>
            </div>
            <button
              className="text-button"
              onClick={() => setActiveNav("Team networks")}
            >
              View all <Icon name="arrow" size={15} />
            </button>
          </div>
          <div className="team-cards">
            {data.teams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                selected={selectedTeam?.id === team.id}
                onDisconnect={() => void disconnectTeam(team)}
                onSelect={() => {
                  const port = allPorts.find(
                    (item) => item.teamNetworkId === team.id,
                  );
                  if (port) setSelectedPortId(port.id);
                }}
              />
            ))}
            <button className="add-card" onClick={() => setModalOpen(true)}>
              <span>
                <Icon name="plus" size={19} />
              </span>
              <strong>Add team network</strong>
              <small>Reserve the next available VLAN</small>
            </button>
          </div>
          <div className="network-layout">
            <div>
              <div className="section-heading compact">
                <div>
                  <span className="eyebrow">SWITCH INVENTORY</span>
                  <h2>Physical ports</h2>
                </div>
                <span className="muted">Click any port to inspect</span>
              </div>
              {switchInfo && (
                <SwitchRack
                  switchInfo={switchInfo}
                  selectedId={selectedPortId}
                  onSelect={assignPort}
                />
              )}
              <div className="recent-heading">
                <span className="eyebrow">LIVE FIELD STATE</span>
              </div>
              <div className="activity-list">
                <div>
                  <span className="activity-icon orange">
                    <Icon name="port" size={15} />
                  </span>
                  <p>
                    {onboardingClient ? (
                      <>
                        <strong>Port {onboardingClient.id}</strong> has an
                        onboarding client
                      </>
                    ) : (
                      <strong>No onboarding client detected</strong>
                    )}
                    <span>VLAN {data.config.onboardingVlan}</span>
                  </p>
                  <StatusDot
                    status={onboardingClient ? "onboarding" : "link-down"}
                    label={onboardingClient ? "Ready" : "Idle"}
                  />
                </div>
                <div>
                  <span className="activity-icon green">
                    <Icon name="wifi" size={15} />
                  </span>
                  <p>
                    <strong>{onlineCount} robot radios</strong> currently
                    associated
                    <span>{data.accessPoints.length} access point online</span>
                  </p>
                  <StatusDot
                    status={onlineCount > 0 ? "online" : "waiting-for-robot"}
                    label={onlineCount > 0 ? "Online" : "Waiting"}
                  />
                </div>
                <div>
                  <span className="activity-icon blue">
                    <Icon name="refresh" size={15} />
                  </span>
                  <p>
                    <strong>{assignedLinkCount} assigned links</strong> active
                    <span>
                      {disabledPortCount} ports administratively disabled
                    </span>
                  </p>
                  <StatusDot
                    status={disabledPortCount > 0 ? "link-down" : "online"}
                    label={disabledPortCount > 0 ? "Attention" : "Healthy"}
                  />
                </div>
              </div>
            </div>
            {selectedPort && switchInfo && (
              <PortInspector
                port={selectedPort}
                teams={data.teams}
                switchId={switchInfo.id}
                onClose={() => setSelectedPortId(undefined)}
                onUpdate={updatePort}
                onRefresh={refresh}
                usingDemo={usingDemo}
              />
            )}
          </div>
          <SimulationLab
            data={data}
            switchInfo={switchInfo}
            selectedPortId={selectedPortId}
            onSelectPort={setSelectedPortId}
            onUpdatePort={updatePort}
            onRefresh={refresh}
            onToast={setToast}
            usingDemo={usingDemo}
          />
        </div>
        {modalOpen && (
          <CreateTeamModal
            config={data.config}
            onClose={() => setModalOpen(false)}
            onCreate={createTeam}
          />
        )}
        {toast && (
          <div className="toast">
            <span>✓</span>
            {toast}
          </div>
        )}
        {loading && <div className="loading-bar" />}
      </main>
    </div>
  );
}
