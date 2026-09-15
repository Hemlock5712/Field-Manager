import { describe, expect, it } from "vitest";
import {
  Extreme5420FabricEngineSwitch,
  FabricEngineSshTransport,
  type FabricEngineCliTransport,
} from "./extreme5420-voss.js";

interface FakePort {
  enabled: boolean;
  linkUp: boolean;
  speed: string;
  tagging: boolean;
  discardUntagged: boolean;
  defaultVlan: number;
  vlans: number[];
}

class FakeFabricEngine implements FabricEngineCliTransport {
  readonly commands: string[] = [];
  readonly vlans = new Set([1, 100, 999]);
  readonly ports = new Map<string, FakePort>([
    [
      "1/1",
      {
        enabled: true,
        linkUp: true,
        speed: "1000BaseTX",
        tagging: true,
        discardUntagged: false,
        defaultVlan: 999,
        vlans: [999],
      },
    ],
    [
      "1/52",
      {
        enabled: true,
        linkUp: true,
        speed: "25GigabitEthernet",
        tagging: true,
        discardUntagged: false,
        defaultVlan: 100,
        vlans: [100],
      },
    ],
  ]);
  readonly fdb = [
    "30   learned    00:57:12:00:00:01  Port-1/1   false  -",
    "999  learned    aa:bb:cc:dd:ee:ff  Port-1/1   false  -",
    "100  self       00:00:00:00:00:01  Port-cpp   false  -",
  ];
  private activePort?: string;

  async execute(commands: readonly string[]): Promise<string[]> {
    const outputs: string[] = [];
    for (const command of commands) {
      const outputCount = outputs.length;
      this.commands.push(command);
      if (command === "show sys-info") {
        outputs.push(
          "SysDescr : 5420M-48W-4YE-FabricEngine (9.1.1.0.GA)\nModelName : 5420M-48W-4YE-FabricEngine",
        );
      } else if (command === "show software") {
        outputs.push(
          "5420.9.1.1.0.GA (Primary Release) (Signed Release)\n5420.8.10.6.0.GA (Backup Release)",
        );
      } else if (
        command === "show interfaces gigabitEthernet" ||
        /^show interfaces gigabitEthernet (?!vlan)/.test(command)
      ) {
        const ids =
          command === "show interfaces gigabitEthernet"
            ? [...this.ports.keys()].join(",")
            : command.slice("show interfaces gigabitEthernet ".length);
        outputs.push(
          ids
            .split(",")
            .map((id) => this.portPhysical(id))
            .join("\n"),
        );
      } else if (command === "show interfaces gigabitEthernet vlan") {
        outputs.push(
          [...this.ports.keys()].map((id) => this.portVlan(id)).join("\n"),
        );
      } else if (/^show vlan members port /.test(command)) {
        outputs.push(this.portMembership(command.split(" ").at(-1)!));
      } else if (command === "show vlan basic") {
        outputs.push(
          [...this.vlans]
            .map((vlan) => `${vlan} FM-${vlan} byPort 0 none N/A N/A 0`)
            .join("\n"),
        );
      } else if (/^vlan create /.test(command)) {
        this.vlans.add(Number(command.split(" ")[2]));
      } else if (/^vlan members remove /.test(command)) {
        const [vlan, portId] = /^vlan members remove (\d+) (\S+) portmember$/
          .exec(command)!
          .slice(1);
        const port = this.ports.get(portId!)!;
        port.vlans = port.vlans.filter((value) => value !== Number(vlan));
      } else if (/^vlan members add /.test(command)) {
        const [vlan, portId] = /^vlan members add (\d+) (\S+) portmember$/
          .exec(command)!
          .slice(1);
        const port = this.ports.get(portId!)!;
        port.vlans = [...new Set([...port.vlans, Number(vlan)])];
      } else if (/^interface GigabitEthernet /.test(command)) {
        this.activePort = command.split(" ").at(-1);
      } else if (/^default-vlan-id /.test(command)) {
        this.currentPort().defaultVlan = Number(command.split(" ").at(-1));
      } else if (command === "untagged-frames-discard") {
        this.currentPort().discardUntagged = true;
      } else if (command === "no untagged-frames-discard") {
        this.currentPort().discardUntagged = false;
      } else if (command === "encapsulation dot1q") {
        this.currentPort().tagging = true;
      } else if (command === "no encapsulation dot1q") {
        this.currentPort().tagging = false;
      } else if (command === "shutdown") {
        this.currentPort().enabled = false;
      } else if (command === "no shutdown") {
        this.currentPort().enabled = true;
      } else if (command === "exit" || command === "end") {
        this.activePort = undefined;
      } else if (command === "show vlan mac-address-entry") {
        outputs.push(this.fdb.join("\n"));
      } else if (/^show vlan mac-address-entry port /.test(command)) {
        const portId = command.split(" ").at(-1)!;
        outputs.push(
          this.fdb
            .filter((line) => line.includes(`Port-${portId} `))
            .join("\n"),
        );
      } else if (/^show vlan mac-address-entry mac /.test(command)) {
        const mac = command.split(" ").at(-1)!.toLowerCase();
        outputs.push(
          this.fdb
            .filter((line) => line.toLowerCase().includes(` ${mac} `))
            .join("\n"),
        );
      }
      if (outputs.length === outputCount) outputs.push("");
    }
    return outputs;
  }

  private currentPort(): FakePort {
    return this.ports.get(this.activePort!)!;
  }

  private portPhysical(portId: string): string {
    const port = this.ports.get(portId)!;
    return `${portId} 192 ${port.speed} true false 1950 f0:64:26:70:f8:00 ${port.enabled ? "up" : "down"} ${port.linkUp && port.enabled ? "up" : "down"}`;
  }

  private portVlan(portId: string): string {
    const port = this.ports.get(portId)!;
    return `${portId} ${port.tagging ? "enable" : "disable"} false ${port.discardUntagged ? "true" : "false"} ${port.defaultVlan} ${port.vlans.join(",")} normal enable P ${port.defaultVlan}`;
  }

  private portMembership(portId: string): string {
    const port = this.ports.get(portId)!;
    return port.vlans.map((vlan) => `${vlan} ${portId} ${portId}`).join("\n");
  }
}

function adapter(transport: FakeFabricEngine) {
  return new Extreme5420FabricEngineSwitch({
    info: {
      id: "switch-1",
      name: "Field Switch",
      managementAddress: "ssh://10.0.100.2",
    },
    managementVlan: 100,
    onboardingVlan: 999,
    portIds: ["1/1", "1/52"],
    clientPorts: ["1/1"],
    apTrunkPorts: ["1/52"],
    transport,
    bounceDelayMs: 0,
  });
}

describe("Extreme5420FabricEngineSwitch", () => {
  it("reads model, software, physical state, and VLAN membership", async () => {
    const sw = adapter(new FakeFabricEngine());
    expect(await sw.getInfo()).toMatchObject({
      manufacturer: "Extreme Networks",
      model: "5420M-48W-4YE-FabricEngine",
      firmwareVersion: "5420.9.1.1.0.GA",
    });
    expect(await sw.getPort("1/1")).toMatchObject({
      enabled: true,
      linkUp: true,
      speedMbps: 1_000,
      mode: "access",
      accessVlan: 999,
      role: "client",
    });
  });

  it("creates VLANs and configures access and trunk membership", async () => {
    const transport = new FakeFabricEngine();
    const sw = adapter(transport);

    await sw.setAccessVlan("1/1", 30);
    expect(await sw.getPort("1/1")).toMatchObject({
      mode: "access",
      accessVlan: 30,
    });
    expect(transport.commands).toContain(
      "vlan create 30 name FM-30 type port-mstprstp 0",
    );
    expect(transport.commands).toContain("vlan members add 30 1/1 portmember");
    expect(transport.commands).toContain("no encapsulation dot1q");
    expect(transport.commands).toContain("tagged-frames-discard enable");
    expect(transport.commands).not.toContain("untag-port-default-vlan enable");

    await sw.setTrunkVlans("1/52", [30, 40], 100);
    expect(await sw.getPort("1/52")).toMatchObject({
      mode: "trunk",
      nativeVlan: 100,
      taggedVlans: [30, 40],
    });
    expect(transport.commands).toContain("vlan members add 40 1/52 portmember");
  });

  it("rejects unprefixed VOSS Error responses", async () => {
    const sw = new Extreme5420FabricEngineSwitch({
      info: { id: "switch-1", name: "Field Switch" },
      managementVlan: 100,
      onboardingVlan: 999,
      portIds: ["1/1"],
      transport: {
        execute: async (commands) =>
          commands.map(
            () => "Error: port 1/1, Operation not allowed on tagging port",
          ),
      },
    });

    await expect(sw.getInfo()).rejects.toThrow(
      "Operation not allowed on tagging port",
    );
  });

  it("normalizes forwarding entries, supports lookup, and clears a port", async () => {
    const transport = new FakeFabricEngine();
    const sw = adapter(transport);
    expect(await sw.getMacTable()).toEqual([
      {
        mac: "00:57:12:00:00:01",
        portId: "1/1",
        vlanId: 30,
        dynamic: true,
      },
      {
        mac: "AA:BB:CC:DD:EE:FF",
        portId: "1/1",
        vlanId: 999,
        dynamic: true,
      },
    ]);
    expect(await sw.findPortByMac("aa-bb-cc-dd-ee-ff")).toBe("1/1");
    await sw.clearMacsOnPort("1/1");
    expect(transport.commands).toContain(
      "clear mac-address-table dynamic AA:BB:CC:DD:EE:FF 999",
    );
  });

  it("enables, disables, bounces, and resets ports", async () => {
    const transport = new FakeFabricEngine();
    const sw = adapter(transport);
    await sw.setPortEnabled("1/1", false);
    expect((await sw.getPort("1/1")).enabled).toBe(false);
    await sw.setPortEnabled("1/1", true);
    await sw.bouncePort("1/1", 0);
    expect((await sw.getPort("1/1")).enabled).toBe(true);
    await sw.resetPort("1/1");
    expect(await sw.getPort("1/1")).toMatchObject({
      accessVlan: 999,
      enabled: true,
    });
  });

  it("uses VOSS VLAN limits and slot/port identifiers", () => {
    expect(
      () =>
        new Extreme5420FabricEngineSwitch({
          info: { id: "switch-1", name: "Field Switch" },
          managementVlan: 100,
          onboardingVlan: 4060,
          portIds: ["1"],
          transport: new FakeFabricEngine(),
        }),
    ).toThrow(/between 1 and 4059/);
  });
});

describe("FabricEngineSshTransport", () => {
  it("requires an ssh URL and pinned OpenSSH SHA256 host key", () => {
    expect(
      () =>
        new FabricEngineSshTransport({
          address: "https://10.0.100.2",
          username: "field-manager",
          password: "secret",
          hostKeySha256: "SHA256:not-a-fingerprint",
        }),
    ).toThrow(/ssh:\/\//);
    expect(
      () =>
        new FabricEngineSshTransport({
          address: "ssh://10.0.100.2",
          username: "field-manager",
          password: "secret",
          hostKeySha256: "not-a-fingerprint",
        }),
    ).toThrow(/OpenSSH SHA256/);
  });
});
