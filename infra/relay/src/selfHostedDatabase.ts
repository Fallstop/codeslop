import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// Reached through Workers VPC: run `cloudflared tunnel run --token <relayDatabaseTunnelToken>`
// next to the database, so the database needs no public port or trusted certificate.
export const selfHostedDatabaseConfig = Config.all({
  host: Config.NonEmptyString("RELAY_DATABASE_HOST"),
  port: Config.Port("RELAY_DATABASE_PORT").pipe(Config.withDefault(5432)),
  database: Config.NonEmptyString("RELAY_DATABASE_NAME").pipe(Config.withDefault("relay")),
  user: Config.NonEmptyString("RELAY_DATABASE_USER").pipe(Config.withDefault("relay")),
  password: Config.Redacted("RELAY_DATABASE_PASSWORD"),
}).pipe(Config.option);

export const SelfHostedDatabase = Effect.gen(function* () {
  const config = yield* selfHostedDatabaseConfig;
  if (Option.isNone(config)) return Option.none();
  const { host, port, database, user, password } = config.value;
  // Explicit props: Alchemy's Tunnel diff reads `news.name` and crashes when props are omitted.
  const tunnel = yield* Cloudflare.Tunnel.Tunnel("RelayDatabaseTunnel", {});
  const service = yield* Cloudflare.Connectivity.DirectoryService("RelayDatabaseService", {
    type: "tcp",
    tcpPort: port,
    appProtocol: "postgresql",
    host: { hostname: host, resolverNetwork: { tunnelId: tunnel.tunnelId } },
    // The tunnel authenticates and encrypts the path; Postgres only needs TLS on, with any certificate.
    tlsSettings: { certVerificationMode: "disabled" },
  });
  return Option.some({
    tunnel,
    database,
    origin: { scheme: "postgres" as const, serviceId: service.serviceId, database, user, password },
  });
});
