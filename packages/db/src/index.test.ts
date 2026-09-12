import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, FieldRepository } from "./index.js";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("FieldRepository", () => {
  it("makes VLAN allocations unique", () => {
    const database = createDatabase(":memory:");
    databases.push(database);
    const repository = new FieldRepository(database);
    const now = new Date().toISOString();
    repository.insertTeamNetwork({
      id: "a",
      teamNumber: 5712,
      vlanId: 10,
      status: "offline",
      createdAt: now,
      updatedAt: now,
    });
    expect(() =>
      repository.insertTeamNetwork({
        id: "b",
        teamNumber: 862,
        vlanId: 10,
        status: "offline",
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow();
    expect(repository.listAllocatedVlans()).toEqual([10]);
  });

  it("stores multiple ports for one team", () => {
    const database = createDatabase(":memory:");
    databases.push(database);
    const repository = new FieldRepository(database);
    const now = new Date().toISOString();
    repository.upsertSwitch({
      id: "switch-1",
      displayName: "Field Switch",
      adapterType: "mock",
      managementAddress: "mock://switch-1",
      metadata: {},
    });
    repository.insertTeamNetwork({
      id: "team-5712",
      teamNumber: 5712,
      vlanId: 30,
      status: "online",
      createdAt: now,
      updatedAt: now,
    });
    repository.upsertPortAssignment({
      switchId: "switch-1",
      portId: "3",
      teamNetworkId: "team-5712",
      role: "client",
    });
    repository.upsertPortAssignment({
      switchId: "switch-1",
      portId: "8",
      teamNetworkId: "team-5712",
      role: "client",
    });
    expect(
      repository
        .listPortAssignments("switch-1")
        .filter((port) => port.teamNetworkId === "team-5712"),
    ).toHaveLength(2);
  });
});
