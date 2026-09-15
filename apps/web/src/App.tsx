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
  emptyData,
  type DashboardData,
  type DhcpLease,
  type PortRole,
  type SimulatorState,
  type SwitchPort,
  type TeamNetwork,
  type TeamStatus,
} from "./api";

const ROLE_LABEL: Record<PortRole, string> = {
  client: "Computer",
  unused: "Unused",
  "ap-trunk": "Access point",
  server: "Server",
  management: "Management",
};

const Icon = ({ name, size = 16 }: { name: string; size?: number }) => {
  const paths: Record<string, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    refresh: (
      <>
        <path d="M20 11a8.1 8.1 0 0 0-14.6-3L3 11" />
        <path d="M3 5v6h6M4 13a8.1 8.1 0 0 0 14.6 3L21 13" />
        <path d="M21 19v-6h-6" />
      </>
    ),
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
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

function statusTone(status: TeamStatus | "link-down" | "ready") {
  if (status === "online" || status === "ready") return "live";
  if (status === "error" || status === "link-down") return "down";
  if (status === "waiting-for-robot" || status === "provisioning")
    return "wait";
  return "idle";
}

function statusText(status: TeamStatus) {
  if (status === "online") return "Live";
  if (status === "waiting-for-robot") return "Waiting";
  if (status === "provisioning") return "Setup";
  if (status === "offline") return "Offline";
  return "Error";
}

function Status({
  status,
  label,
}: {
  status: TeamStatus | "link-down" | "ready";
  label?: string;
}) {
  const text =
    label ??
    (status === "link-down"
      ? "Down"
      : status === "ready"
        ? "Ready"
        : statusText(status as TeamStatus));
  return (
    <span className={`status ${statusTone(status)}`}>
      <i />
      {text}
    </span>
  );
}

function CreateTeamModal({
  onClose,
  onCreate,
}: {
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
      setError("Enter a team number.");
      return;
    }
    setError("");
    setWorking(true);
    try {
      await onCreate(number);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add team.");
    } finally {
      setWorking(false);
    }
  };
  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <h2>Add team</h2>
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="close" />
          </button>
        </div>
        <label className="field">
          Team number
          <input
            autoFocus
            inputMode="numeric"
            value={teamNumber}
            onChange={(event) => setTeamNumber(event.target.value)}
            placeholder="5712"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn accent" disabled={working}>
            {working ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Inspector({
  port,
  team,
  teams,
  switchId,
  ports,
  onClose,
  onUpdate,
  onRefresh,
  onDisconnect,
  usingDemo,
}: {
  port?: SwitchPort;
  team?: TeamNetwork;
  teams: TeamNetwork[];
  switchId?: string;
  ports: SwitchPort[];
  onClose: () => void;
  onUpdate: (port: SwitchPort) => void;
  onRefresh: () => Promise<void>;
  onDisconnect: (team: TeamNetwork) => void;
  usingDemo: boolean;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const run = async (
    operation: () => Promise<unknown>,
    optimistic?: SwitchPort,
  ) => {
    if (!switchId) return;
    setWorking(true);
    setError("");
    try {
      await operation();
      await onRefresh();
    } catch (err) {
      if (usingDemo && optimistic) onUpdate(optimistic);
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setWorking(false);
    }
  };
  const assignable = ports.filter(
    (item) =>
      (item.role === "client" || item.role === "unused") && !item.teamNetworkId,
  );
  if (!port && !team) {
    return (
      <aside className="inspect empty">
        <p>Select a team or port</p>
      </aside>
    );
  }
  if (port && switchId) {
    const current = teams.find((item) => item.id === port.teamNetworkId);
    return (
      <aside className="inspect">
        <div className="inspect-head">
          <div>
            <span className="kicker">Port</span>
            <h2>{port.id}</h2>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="inspect-row">
          <Status
            status={port.linkUp ? "online" : "link-down"}
            label={port.linkUp ? "Up" : "Down"}
          />
          <span>{port.enabled ? "On" : "Off"}</span>
        </div>
        <label className="field">
          Team
          <select
            value={port.teamNetworkId ?? ""}
            disabled={working}
            onChange={(event) => {
              const next = teams.find((item) => item.id === event.target.value);
              if (next)
                void run(() => api.assignPort(switchId, port.id, next.id), {
                  ...port,
                  teamNetworkId: next.id,
                  teamNumber: next.teamNumber,
                });
            }}
          >
            <option value="">Unassigned</option>
            {teams.map((item) => (
              <option key={item.id} value={item.id}>
                {item.teamNumber}
              </option>
            ))}
          </select>
        </label>
        {!current && (
          <label className="field">
            Role
            <select
              value={port.role}
              disabled={working}
              onChange={(event) =>
                void run(() =>
                  api.setPortRole(
                    switchId,
                    port.id,
                    event.target.value as PortRole,
                  ),
                )
              }
            >
              {Object.entries(ROLE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        {port.macs?.length ? (
          <ul className="macs">
            {port.macs.map((mac) => (
              <li key={mac}>
                <code>{mac}</code>
              </li>
            ))}
          </ul>
        ) : null}
        {error && <p className="error">{error}</p>}
        <div className="inspect-actions">
          {current && (
            <button
              className="btn"
              disabled={working}
              onClick={() =>
                void run(() => api.returnPortToOnboarding(switchId, port.id), {
                  ...port,
                  teamNetworkId: undefined,
                  teamNumber: undefined,
                })
              }
            >
              Unassign
            </button>
          )}
          <button
            className="btn"
            disabled={working}
            onClick={() => void run(() => api.bouncePort(switchId, port.id))}
          >
            Cycle
          </button>
          <button
            className={`btn ${port.enabled ? "danger" : "accent"}`}
            disabled={working}
            onClick={() =>
              void run(
                () => api.setPortEnabled(switchId, port.id, !port.enabled),
                { ...port, enabled: !port.enabled },
              )
            }
          >
            {port.enabled ? "Disable" : "Enable"}
          </button>
        </div>
      </aside>
    );
  }
  if (!team) return null;
  return (
    <aside className="inspect">
      <div className="inspect-head">
        <div>
          <span className="kicker">Team</span>
          <h2>{team.teamNumber}</h2>
        </div>
        <button className="ghost" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="inspect-row">
        <Status status={team.status} />
        <span>{team.robotOnline ? "Robot" : "No robot"}</span>
      </div>
      {team.ports?.length ? (
        <ul className="port-list">
          {team.ports.map((wired) => (
            <li key={wired.portId}>
              Port {wired.portId}
              <Status
                status={wired.linkUp ? "online" : "link-down"}
                label={wired.linkUp ? "Up" : "Down"}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="quiet">No ports</p>
      )}
      {switchId && (
        <label className="field">
          Connect port
          <select
            value=""
            disabled={working}
            onChange={(event) => {
              const next = ports.find((item) => item.id === event.target.value);
              if (next)
                void run(() => api.assignPort(switchId, next.id, team.id), {
                  ...next,
                  teamNetworkId: team.id,
                  teamNumber: team.teamNumber,
                });
            }}
          >
            <option value="">Choose…</option>
            {assignable.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
                {item.teamNumber ? ` · ${item.teamNumber}` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div className="inspect-actions">
        <button className="btn danger" onClick={() => onDisconnect(team)}>
          Remove team
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
      onToast(usingDemo ? "Local only." : "Lab change failed.");
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
      onToast("Availability change failed.");
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
      onToast("Station update failed.");
    } finally {
      setWorking(false);
    }
  };
  const reset = async (scope: "hardware" | "demo") => {
    if (
      !window.confirm(scope === "demo" ? "Reset demo data?" : "Reset hardware?")
    )
      return;
    setWorking(true);
    try {
      await api.simulator.reset(
        scope === "hardware" ? "hardware-to-desired" : "seeded-demo",
      );
      await onRefresh();
      await refreshSimulation();
      onToast("Reset.");
    } catch {
      onToast("Reset failed.");
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="lab">
      <header>
        <h2>Lab</h2>
      </header>
      <div className="lab-row">
        <button
          className={`chip ${switchOnline ? "on" : ""}`}
          disabled={working || !switchId}
          onClick={() => void setAvailability("switch")}
        >
          Switch {switchOnline ? "on" : "off"}
        </button>
        <button
          className={`chip ${apOnline ? "on" : ""}`}
          disabled={working || !accessPointId}
          onClick={() => void setAvailability("access-point")}
        >
          AP {apOnline ? "on" : "off"}
        </button>
      </div>
      <label className="field">
        Port
        <select
          value={selectedPort?.id ?? ""}
          onChange={(event) => onSelectPort(event.target.value)}
        >
          {ports.map((port) => (
            <option key={port.id} value={port.id}>
              {port.id}
              {port.teamNumber ? ` · ${port.teamNumber}` : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="lab-row">
        <button
          className={`chip ${enabled ? "on" : ""}`}
          disabled={working || !selectedPort}
          onClick={() => {
            if (selectedPort)
              void patchPort(
                { enabled: !enabled },
                { ...selectedPort, enabled: !enabled },
              );
          }}
        >
          {enabled ? "Enabled" : "Disabled"}
        </button>
        <button
          className={`chip ${linkUp ? "on" : ""}`}
          disabled={working || !selectedPort}
          onClick={() => {
            if (selectedPort)
              void patchPort(
                { linkUp: !linkUp },
                { ...selectedPort, linkUp: !linkUp },
              );
          }}
        >
          Link {linkUp ? "up" : "down"}
        </button>
      </div>
      <div className="lab-grid">
        <label className="field">
          MAC
          <input value={mac} onChange={(event) => setMac(event.target.value)} />
        </label>
        <label className="field">
          VLAN
          <input
            inputMode="numeric"
            value={vlanId}
            onChange={(event) => setVlanId(event.target.value)}
          />
        </label>
      </div>
      <div className="lab-row">
        <button
          className="btn"
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
          Learn MAC
        </button>
        <button
          className="btn"
          disabled={working || !selectedPort}
          onClick={() => {
            if (selectedPort)
              void patchPort(
                { clearMacs: true },
                { ...selectedPort, macs: [] },
              );
          }}
        >
          Clear MACs
        </button>
      </div>
      <div className="lab-grid">
        <label className="field">
          IP
          <input value={ip} onChange={(event) => setIp(event.target.value)} />
        </label>
        <label className="field">
          MAC
          <input value={mac} onChange={(event) => setMac(event.target.value)} />
        </label>
      </div>
      <button
        className="btn"
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
          } catch {
            if (usingDemo)
              setFallbackLeases((current) => [
                ...current.filter((item) => item.ip !== ip),
                lease,
              ]);
            onToast(usingDemo ? "Lease saved locally." : "Lease failed.");
          }
        }}
      >
        Set lease
      </button>
      {leases.length > 0 && (
        <ul className="lease-list">
          {leases.map((lease) => (
            <li key={lease.ip}>
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
                    onToast("Lease delete failed.");
                  }
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="lab-grid">
        <label className="field">
          Slot
          <select
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
                    ? ` · ${station.configuration.teamNumber}`
                    : ""}
                </option>
              );
            })}
          </select>
        </label>
        <label className="field">
          Radio
          <select
            value={associated ? "associated" : "disconnected"}
            onChange={(event) =>
              setAssociated(event.target.value === "associated")
            }
          >
            <option value="associated">Associated</option>
            <option value="disconnected">Disconnected</option>
          </select>
        </label>
      </div>
      <label className="field">
        Signal
        <input
          value={signalDbm}
          onChange={(event) => setSignalDbm(event.target.value)}
        />
      </label>
      <button
        className="btn"
        disabled={working || !apOnline || !selectedStation?.configuration}
        onClick={() => void applyStation()}
      >
        Apply radio
      </button>
      <div className="lab-foot">
        <button
          className="text"
          disabled={working}
          onClick={() => void reset("hardware")}
        >
          Reset hardware
        </button>
        <button
          className="text danger"
          disabled={working}
          onClick={() => void reset("demo")}
        >
          Reset demo
        </button>
      </div>
    </section>
  );
}

function friendlyPortalError(error: unknown) {
  const text = (error instanceof Error ? error.message : "").toLowerCase();
  if (text.includes("not found") || text.includes("configured"))
    return "Team not found.";
  if (
    text.includes("port") ||
    text.includes("lease") ||
    text.includes("device") ||
    text.includes("mac")
  )
    return "Could not find this computer.";
  return "Could not connect.";
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
      setMessage("Enter your team number.");
      return;
    }
    setState("working");
    try {
      const result = await onConnect(number);
      if (!result) throw new Error("Team not found.");
      setState("success");
      setMessage("Connected.");
    } catch (error) {
      setState("error");
      setMessage(friendlyPortalError(error));
    }
  };
  return (
    <main className="portal">
      <div className="portal-grid" />
      <header className="portal-bar">
        <span className="mark">FM</span>
        Field Manager
      </header>
      <section className="portal-body">
        <h1>Connect</h1>
        <form onSubmit={submit}>
          <label className="field">
            Team number
            <input
              autoFocus
              inputMode="numeric"
              value={team}
              onChange={(event) => setTeam(event.target.value)}
              placeholder="5712"
            />
          </label>
          <button className="btn accent lg" disabled={state === "working"}>
            {state === "working" ? "Connecting…" : "Join"}
            <Icon name="arrow" size={16} />
          </button>
        </form>
        {state !== "idle" && <p className={`note ${state}`}>{message}</p>}
      </section>
    </main>
  );
}

export function App() {
  const isPortal = window.location.pathname.startsWith("/portal");
  const search = new URLSearchParams(window.location.search);
  const showLab = search.has("lab");
  const demoRequested = search.has("demo");
  const [data, setData] = useState<DashboardData>(
    demoRequested ? demoData : emptyData,
  );
  const [usingDemo, setUsingDemo] = useState(demoRequested);
  const [apiOffline, setApiOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedPortId, setSelectedPortId] = useState<string>();
  const [selectedTeamId, setSelectedTeamId] = useState<string>();
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true);
    if (demoRequested) {
      setData(demoData);
      setUsingDemo(true);
      setApiOffline(false);
      setLoading(false);
      return;
    }
    try {
      const remote = await api.getDashboard();
      setData(remote);
      setUsingDemo(false);
      setApiOffline(false);
    } catch {
      setApiOffline(true);
    } finally {
      setLoading(false);
    }
  }, [demoRequested]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelectedPortId(undefined);
      setSelectedTeamId(undefined);
      setModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const switchInfo = data.switches[0];
  const allPorts = switchInfo?.ports ?? [];
  const selectedPort = selectedPortId
    ? allPorts.find((port) => port.id === selectedPortId)
    : undefined;
  const selectedTeam = selectedTeamId
    ? data.teams.find((team) => team.id === selectedTeamId)
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
    setToast(`Team ${teamNumber} added.`);
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
    return team;
  };
  const disconnectTeam = async (team: TeamNetwork) => {
    if (!window.confirm(`Remove Team ${team.teamNumber}?`)) return;
    try {
      if (!usingDemo) await api.deleteTeam(team.id);
      setData((current) => ({
        ...current,
        teams: current.teams.filter((item) => item.id !== team.id),
      }));
      setSelectedPortId(undefined);
      setSelectedTeamId(undefined);
      setToast(`Team ${team.teamNumber} removed.`);
      if (!usingDemo) await refresh();
    } catch (error) {
      setToast(
        error instanceof Error ? error.message : "Could not remove team.",
      );
    }
  };
  const liveCount = data.teams.filter(
    (team) => team.status === "online",
  ).length;
  const apOnline = data.accessPoints.some((ap) => ap.online !== false);
  if (isPortal) return <Portal onConnect={connectPortal} />;
  return (
    <div className="shell">
      <div className="glow" />
      <div className="grid-bg" />
      <header className="bar">
        <div className="brand">
          <span className="mark">FM</span>
          <strong>Field Manager</strong>
        </div>
        <div className="bar-meta">
          <span className={`pulse ${apiOffline || usingDemo ? "off" : ""}`} />
          {apiOffline ? (
            <button className="text" onClick={() => void refresh()}>
              Offline
            </button>
          ) : usingDemo ? (
            <span>Demo</span>
          ) : (
            <span>
              {liveCount}/{data.teams.length} live
            </span>
          )}
          {data.accessPoints.length > 0 && (
            <span className={apOnline ? "live-copy" : "quiet"}>
              {apOnline ? "AP" : "AP down"}
            </span>
          )}
        </div>
        <div className="bar-actions">
          <a className="text" href="/portal" target="_blank" rel="noreferrer">
            Portal
          </a>
          <button
            className="ghost"
            onClick={() => void refresh()}
            aria-label="Refresh"
          >
            <Icon name="refresh" />
          </button>
          <button className="btn accent" onClick={() => setModalOpen(true)}>
            <Icon name="plus" size={14} /> Team
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="rail">
          <div className="rail-head">
            <h1>Teams</h1>
            <span>{data.teams.length}</span>
          </div>
          <ul className="team-list">
            {data.teams.map((team) => (
              <li key={team.id}>
                <button
                  className={`team ${selectedTeam?.id === team.id ? "on" : ""}`}
                  onClick={() => {
                    setSelectedTeamId(team.id);
                    setSelectedPortId(undefined);
                  }}
                >
                  <strong>{team.teamNumber}</strong>
                  <Status status={team.status} />
                </button>
                <button
                  className="team-x"
                  aria-label={`Remove Team ${team.teamNumber}`}
                  onClick={() => void disconnectTeam(team)}
                >
                  <Icon name="close" size={12} />
                </button>
              </li>
            ))}
          </ul>
          {data.teams.length === 0 && <p className="quiet">No teams</p>}
          <button className="add-team" onClick={() => setModalOpen(true)}>
            <Icon name="plus" size={14} /> Add team
          </button>
        </aside>
        <section className="deck">
          {data.switches.map((item) => (
            <div className="face" key={item.id}>
              <div className="face-head">
                <h2>{item.name}</h2>
                <span>
                  {item.ports.filter((port) => port.linkUp).length}/
                  {item.ports.length} up
                </span>
              </div>
              <div className="ports" aria-label="Switch ports">
                {item.ports.map((port) => (
                  <button
                    key={port.id}
                    className={[
                      "port",
                      port.linkUp ? "up" : "",
                      port.enabled ? "" : "off",
                      port.teamNumber ? "assigned" : "",
                      selectedPortId === port.id ? "sel" : "",
                      selectedTeamId && port.teamNetworkId === selectedTeamId
                        ? "focus"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => {
                      setSelectedPortId(port.id);
                      setSelectedTeamId(port.teamNetworkId);
                    }}
                    aria-label={`Port ${port.id}`}
                  >
                    <span>{port.id}</span>
                    {port.teamNumber ? (
                      <b>{port.teamNumber}</b>
                    ) : (
                      <i className={port.linkUp ? "lit" : ""} />
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {showLab && (
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
          )}
        </section>
        <Inspector
          port={selectedPort}
          team={selectedPort ? undefined : selectedTeam}
          teams={data.teams}
          switchId={switchInfo?.id}
          ports={allPorts}
          onClose={() => {
            setSelectedPortId(undefined);
            setSelectedTeamId(undefined);
          }}
          onUpdate={updatePort}
          onRefresh={refresh}
          onDisconnect={(team) => void disconnectTeam(team)}
          usingDemo={usingDemo}
        />
      </div>
      {modalOpen && (
        <CreateTeamModal
          onClose={() => setModalOpen(false)}
          onCreate={createTeam}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      {loading && <div className="loader" />}
    </div>
  );
}
