import Database from "better-sqlite3";

export interface InstallationConfigRecord {
  managementVlan: number;
  onboardingVlan: number;
  teamVlanStart: number;
  teamVlanEnd: number;
  portBounceDelayMs: number;
}

export interface TeamNetworkRecord {
  id: string;
  teamNumber: number;
  vlanId: number;
  accessPointId?: string;
  accessPointSlot?: string;
  wirelessSsid?: string;
  credentialRef?: string;
  status: "provisioning" | "waiting-for-robot" | "online" | "offline" | "error";
  statusMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SwitchRecord {
  id: string;
  displayName: string;
  adapterType: string;
  managementAddress: string;
  metadata: Record<string, unknown>;
}

export interface AccessPointRecord {
  id: string;
  displayName: string;
  adapterType: string;
  managementAddress: string;
  metadata: Record<string, unknown>;
}

export type PortRole =
  "client" | "ap-trunk" | "server" | "management" | "unused";

export interface PortAssignmentRecord {
  switchId: string;
  portId: string;
  teamNetworkId?: string;
  role: PortRole;
  label?: string;
  updatedAt: string;
}

const defaultConfig: InstallationConfigRecord = {
  managementVlan: 100,
  onboardingVlan: 999,
  teamVlanStart: 10,
  teamVlanEnd: 90,
  portBounceDelayMs: 350,
};

export function createDatabase(
  path = process.env.FIELD_MANAGER_DB ?? "field-manager.sqlite",
): Database.Database {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  initializeDatabase(database);
  return database;
}

export function initializeDatabase(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS installation_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      management_vlan INTEGER NOT NULL,
      onboarding_vlan INTEGER NOT NULL,
      team_vlan_start INTEGER NOT NULL,
      team_vlan_end INTEGER NOT NULL,
      port_bounce_delay_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS switches (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, adapter_type TEXT NOT NULL,
      management_address TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS access_points (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, adapter_type TEXT NOT NULL,
      management_address TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS team_networks (
      id TEXT PRIMARY KEY,
      team_number INTEGER NOT NULL UNIQUE CHECK (team_number > 0),
      vlan_id INTEGER NOT NULL UNIQUE CHECK (vlan_id BETWEEN 1 AND 4094),
      access_point_id TEXT REFERENCES access_points(id) ON DELETE SET NULL,
      access_point_slot TEXT,
      wireless_ssid TEXT,
      credential_ref TEXT,
      status TEXT NOT NULL,
      status_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(access_point_id, access_point_slot)
    );
    CREATE TABLE IF NOT EXISTS port_assignments (
      switch_id TEXT NOT NULL REFERENCES switches(id) ON DELETE CASCADE,
      port_id TEXT NOT NULL,
      team_network_id TEXT REFERENCES team_networks(id) ON DELETE SET NULL,
      role TEXT NOT NULL,
      label TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (switch_id, port_id)
    );
    CREATE TABLE IF NOT EXISTS local_credentials (
      reference TEXT PRIMARY KEY, secret TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const teamColumns = database
    .prepare("PRAGMA table_info(team_networks)")
    .all() as Array<{ name: string }>;
  if (!teamColumns.some((column) => column.name === "wireless_ssid"))
    database.exec("ALTER TABLE team_networks ADD COLUMN wireless_ssid TEXT");
  database
    .prepare(
      `INSERT OR IGNORE INTO installation_config
    (id, management_vlan, onboarding_vlan, team_vlan_start, team_vlan_end, port_bounce_delay_ms)
    VALUES (1, ?, ?, ?, ?, ?)`,
    )
    .run(
      defaultConfig.managementVlan,
      defaultConfig.onboardingVlan,
      defaultConfig.teamVlanStart,
      defaultConfig.teamVlanEnd,
      defaultConfig.portBounceDelayMs,
    );
}

type TeamRow = {
  id: string;
  team_number: number;
  vlan_id: number;
  access_point_id: string | null;
  access_point_slot: string | null;
  wireless_ssid: string | null;
  credential_ref: string | null;
  status: TeamNetworkRecord["status"];
  status_message: string | null;
  created_at: string;
  updated_at: string;
};

type PortRow = {
  switch_id: string;
  port_id: string;
  team_network_id: string | null;
  role: PortRole;
  label: string | null;
  updated_at: string;
};

function toTeam(row: TeamRow): TeamNetworkRecord {
  return {
    id: row.id,
    teamNumber: row.team_number,
    vlanId: row.vlan_id,
    ...(row.access_point_id ? { accessPointId: row.access_point_id } : {}),
    ...(row.access_point_slot
      ? { accessPointSlot: row.access_point_slot }
      : {}),
    ...(row.wireless_ssid ? { wirelessSsid: row.wireless_ssid } : {}),
    ...(row.credential_ref ? { credentialRef: row.credential_ref } : {}),
    status: row.status,
    ...(row.status_message ? { statusMessage: row.status_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPort(row: PortRow): PortAssignmentRecord {
  return {
    switchId: row.switch_id,
    portId: row.port_id,
    ...(row.team_network_id ? { teamNetworkId: row.team_network_id } : {}),
    role: row.role,
    ...(row.label ? { label: row.label } : {}),
    updatedAt: row.updated_at,
  };
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class FieldRepository {
  constructor(readonly database: Database.Database) {}

  getConfig(): InstallationConfigRecord {
    const row = this.database
      .prepare(
        `SELECT management_vlan, onboarding_vlan, team_vlan_start,
      team_vlan_end, port_bounce_delay_ms FROM installation_config WHERE id = 1`,
      )
      .get() as {
      management_vlan: number;
      onboarding_vlan: number;
      team_vlan_start: number;
      team_vlan_end: number;
      port_bounce_delay_ms: number;
    };
    return {
      managementVlan: row.management_vlan,
      onboardingVlan: row.onboarding_vlan,
      teamVlanStart: row.team_vlan_start,
      teamVlanEnd: row.team_vlan_end,
      portBounceDelayMs: row.port_bounce_delay_ms,
    };
  }

  updateConfig(config: InstallationConfigRecord): InstallationConfigRecord {
    this.database
      .prepare(
        `UPDATE installation_config SET management_vlan = ?, onboarding_vlan = ?,
      team_vlan_start = ?, team_vlan_end = ?, port_bounce_delay_ms = ? WHERE id = 1`,
      )
      .run(
        config.managementVlan,
        config.onboardingVlan,
        config.teamVlanStart,
        config.teamVlanEnd,
        config.portBounceDelayMs,
      );
    return this.getConfig();
  }

  listTeamNetworks(): TeamNetworkRecord[] {
    return (
      this.database
        .prepare("SELECT * FROM team_networks ORDER BY team_number")
        .all() as TeamRow[]
    ).map(toTeam);
  }
  getTeamNetwork(id: string): TeamNetworkRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM team_networks WHERE id = ?")
      .get(id) as TeamRow | null;
    return row ? toTeam(row) : undefined;
  }
  getTeamNetworkByNumber(teamNumber: number): TeamNetworkRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM team_networks WHERE team_number = ?")
      .get(teamNumber) as TeamRow | null;
    return row ? toTeam(row) : undefined;
  }
  insertTeamNetwork(network: TeamNetworkRecord): void {
    this.database
      .prepare(
        `INSERT INTO team_networks
      (id, team_number, vlan_id, access_point_id, access_point_slot, wireless_ssid,
       credential_ref, status, status_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        network.id,
        network.teamNumber,
        network.vlanId,
        network.accessPointId ?? null,
        network.accessPointSlot ?? null,
        network.wirelessSsid ?? null,
        network.credentialRef ?? null,
        network.status,
        network.statusMessage ?? null,
        network.createdAt,
        network.updatedAt,
      );
  }
  updateTeamNetwork(network: TeamNetworkRecord): void {
    this.database
      .prepare(
        `UPDATE team_networks SET team_number = ?, vlan_id = ?, access_point_id = ?,
      access_point_slot = ?, wireless_ssid = ?, credential_ref = ?, status = ?,
      status_message = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        network.teamNumber,
        network.vlanId,
        network.accessPointId ?? null,
        network.accessPointSlot ?? null,
        network.wirelessSsid ?? null,
        network.credentialRef ?? null,
        network.status,
        network.statusMessage ?? null,
        network.updatedAt,
        network.id,
      );
  }
  deleteTeamNetwork(id: string): void {
    this.database.prepare("DELETE FROM team_networks WHERE id = ?").run(id);
  }
  listAllocatedVlans(): number[] {
    return (
      this.database
        .prepare("SELECT vlan_id FROM team_networks ORDER BY vlan_id")
        .all() as { vlan_id: number }[]
    ).map((row) => row.vlan_id);
  }

  upsertSwitch(record: SwitchRecord): void {
    this.database
      .prepare(
        `INSERT INTO switches (id, display_name, adapter_type, management_address, metadata_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,
      adapter_type=excluded.adapter_type, management_address=excluded.management_address,
      metadata_json=excluded.metadata_json`,
      )
      .run(
        record.id,
        record.displayName,
        record.adapterType,
        record.managementAddress,
        JSON.stringify(record.metadata),
      );
  }
  listSwitches(): SwitchRecord[] {
    return (
      this.database
        .prepare("SELECT * FROM switches ORDER BY display_name")
        .all() as Array<{
        id: string;
        display_name: string;
        adapter_type: string;
        management_address: string;
        metadata_json: string;
      }>
    ).map((row) => ({
      id: row.id,
      displayName: row.display_name,
      adapterType: row.adapter_type,
      managementAddress: row.management_address,
      metadata: parseJson(row.metadata_json),
    }));
  }
  upsertAccessPoint(record: AccessPointRecord): void {
    this.database
      .prepare(
        `INSERT INTO access_points (id, display_name, adapter_type, management_address, metadata_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,
      adapter_type=excluded.adapter_type, management_address=excluded.management_address,
      metadata_json=excluded.metadata_json`,
      )
      .run(
        record.id,
        record.displayName,
        record.adapterType,
        record.managementAddress,
        JSON.stringify(record.metadata),
      );
  }
  listAccessPoints(): AccessPointRecord[] {
    return (
      this.database
        .prepare("SELECT * FROM access_points ORDER BY display_name")
        .all() as Array<{
        id: string;
        display_name: string;
        adapter_type: string;
        management_address: string;
        metadata_json: string;
      }>
    ).map((row) => ({
      id: row.id,
      displayName: row.display_name,
      adapterType: row.adapter_type,
      managementAddress: row.management_address,
      metadata: parseJson(row.metadata_json),
    }));
  }

  upsertPortAssignment(
    assignment: Omit<PortAssignmentRecord, "updatedAt"> & {
      updatedAt?: string;
    },
  ): void {
    this.database
      .prepare(
        `INSERT INTO port_assignments
      (switch_id, port_id, team_network_id, role, label, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(switch_id, port_id) DO UPDATE SET team_network_id=excluded.team_network_id,
      role=excluded.role, label=excluded.label, updated_at=excluded.updated_at`,
      )
      .run(
        assignment.switchId,
        assignment.portId,
        assignment.teamNetworkId ?? null,
        assignment.role,
        assignment.label ?? null,
        assignment.updatedAt ?? new Date().toISOString(),
      );
  }
  getPortAssignment(
    switchId: string,
    portId: string,
  ): PortAssignmentRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM port_assignments WHERE switch_id = ? AND port_id = ?",
      )
      .get(switchId, portId) as PortRow | null;
    return row ? toPort(row) : undefined;
  }
  listPortAssignments(switchId?: string): PortAssignmentRecord[] {
    const rows = (
      switchId
        ? this.database
            .prepare(
              "SELECT * FROM port_assignments WHERE switch_id = ? ORDER BY CAST(port_id AS INTEGER)",
            )
            .all(switchId)
        : this.database
            .prepare(
              "SELECT * FROM port_assignments ORDER BY switch_id, CAST(port_id AS INTEGER)",
            )
            .all()
    ) as PortRow[];
    return rows.map(toPort);
  }
  clearTeamFromPorts(teamNetworkId: string): void {
    this.database
      .prepare(
        "UPDATE port_assignments SET team_network_id = NULL, updated_at = ? WHERE team_network_id = ?",
      )
      .run(new Date().toISOString(), teamNetworkId);
  }
  runInTransaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }
}

export interface CredentialStore {
  put(reference: string, secret: string): Promise<void>;
  get(reference: string): Promise<string | null>;
  delete(reference: string): Promise<void>;
}

/** Development-only store. Values are plain text in SQLite; use an OS vault adapter in production. */
export class LocalSqliteCredentialStore implements CredentialStore {
  constructor(private readonly database: Database.Database) {}
  async put(reference: string, secret: string): Promise<void> {
    this.database
      .prepare(
        "INSERT OR REPLACE INTO local_credentials (reference, secret, created_at) VALUES (?, ?, ?)",
      )
      .run(reference, secret, new Date().toISOString());
  }
  async get(reference: string): Promise<string | null> {
    const row = this.database
      .prepare("SELECT secret FROM local_credentials WHERE reference = ?")
      .get(reference) as { secret: string } | null;
    return row?.secret ?? null;
  }
  async delete(reference: string): Promise<void> {
    this.database
      .prepare("DELETE FROM local_credentials WHERE reference = ?")
      .run(reference);
  }
}

export class EnvironmentCredentialStore implements CredentialStore {
  async put(): Promise<void> {
    throw new Error("Environment credentials are read-only");
  }
  async get(reference: string): Promise<string | null> {
    return process.env[reference] ?? null;
  }
  async delete(): Promise<void> {
    throw new Error("Environment credentials are read-only");
  }
}
