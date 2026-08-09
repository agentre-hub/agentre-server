# Relay WebSocket hardening

> Status: Draft
> Owner: Server team
> Last updated: 2026-08-09

**Objective:** Keep distributed relay WebSockets bounded and recoverable during long-lived production use without changing the existing relay wire protocol or cross-instance routing behaviour.

**Hard invariant:** A client and daemon connected to different server replicas must continue to exchange binary relay frames with delivery acknowledgement, without sticky sessions and without changing the outer envelope format.

## Problem

1. **Acknowledged Redis Stream entries accumulate for the lifetime of an active relay.** `internal/service/relay_svc/framebus.go` publishes with `XADD`, acknowledges with `XACK`, and continuously renews the stream TTL while a WebSocket is attached, but never deletes acknowledged entries. `XACK` removes an entry from the pending list, not from the stream, so a long-lived cross-instance relay grows Redis memory without a bound.
2. **Inbound WebSocket messages have no application-level size bound.** Both relay handlers call `ReadMessage` without a read limit, allowing an authenticated but faulty or compromised peer to make the server allocate an arbitrarily large message.
3. **Relay socket reads and writes are not time-bounded.** A half-open connection can remain attached after it stops responding, and a blocked `WriteMessage` can stall the Redis consumer responsible for subsequent frames on that stream.
4. **The shipped Ingress does not declare long-lived WebSocket timeouts.** `deploy/helm/values.yaml` configures request body size only, so idle connection lifetime depends on cluster-wide ingress defaults rather than the chart's contract.

## Actors and user stories

1. As an AgentRe user, I want relay connections to remain usable across normal idle periods and replica boundaries, so that remote daemon sessions do not disappear because of proxy defaults.
2. As an operator, I want Redis and server memory usage to remain bounded by active work rather than total historical relay traffic.
3. As an operator, I want unresponsive relay peers to be disconnected in bounded time, so that one stalled socket cannot indefinitely retain local state or block cross-instance delivery.

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | Remove each Redis Stream entry as part of the same successful acknowledgement operation; undeliverable entries are also removed but receive no delivery ACK. | The stream is a transient delivery queue, not a history. Delivery confirmation must still mean that the target socket write completed. Rejected: TTL alone — active consumers continuously renew it. Rejected: an approximate `MAXLEN` as the primary mechanism — trimming can discard an in-flight RPC before its delivery result is known. |
| 2 | Limit each assembled WebSocket message to 10 MiB. | This matches the chart's existing 10 MiB ingress body-size policy and leaves room for terminal, diff and protocol payloads while preventing unbounded allocation. Rejected: no limit — a valid device credential would remain sufficient for memory exhaustion. |
| 3 | Use a 15-second server heartbeat, a 45-second read deadline, and a 10-second write deadline for both relay endpoints. | Three missed heartbeat windows distinguish an unresponsive peer without making a single delayed packet fatal; writes must complete well inside the existing 5-second cross-instance delivery wait where that wait applies. Rejected: daemon-only heartbeat — client relay sockets can also be idle or half-open. Rejected: TCP defaults — their failure detection is too slow and platform-dependent. |
| 4 | Set chart-owned NGINX ingress proxy read and send timeouts to 3600 seconds. | Application heartbeats own dead-peer detection; the ingress should permit long-lived connections rather than impose a short cluster default. Rejected: relying on the ingress controller ConfigMap — it makes this chart behave differently between clusters. |

## Relay connection lifecycle

After a successful authenticated upgrade, the server applies the 10 MiB message limit and starts heartbeat supervision. Any inbound data, ping or pong proves read-side liveness and extends the 45-second read deadline. The server sends a ping every 15 seconds. Failure to send within the 10-second write deadline, or failure to receive peer activity before the read deadline, closes the physical WebSocket and runs the existing detach path.

Daemon pings continue to renew the 30-second Redis online route. Server-originated heartbeat pongs from the daemon also count as daemon liveness and renew the route, so a compliant daemon remains online even while no application frames are flowing. Client relay sockets use the same heartbeat and timeout policy but do not create daemon online records.

Application frames larger than 10 MiB are rejected by closing that WebSocket. Other relay connections and Redis consumers remain available.

## Redis frame lifecycle

A cross-instance frame remains in the target Redis Stream until the target instance has either delivered it to the selected local WebSocket or determined that no local delivery target exists.

After successful socket delivery, stream deletion, consumer-group acknowledgement and publication of the short-lived delivery ACK occur as one Redis transaction. The publishing instance reports success only after observing that ACK.

For malformed or undeliverable entries, stream deletion and consumer-group acknowledgement occur together, but no delivery ACK is written. The publisher therefore retains the existing observable failure: it times out and returns a forwarding error, while the bad entry cannot block later frames or accumulate in the stream.

A transient Redis failure before the acknowledgement transaction succeeds leaves the entry eligible for the existing pending-entry recovery path. No successful publisher response is produced until the transaction succeeds.

## Deployment contract

The default Helm values declare both `nginx.ingress.kubernetes.io/proxy-read-timeout` and `nginx.ingress.kubernetes.io/proxy-send-timeout` as `"3600"`. Existing user-supplied ingress annotations remain mergeable through the current values mechanism.

No sticky-session annotation is added. Cross-instance routing continues to use Redis.

## Compatibility and security

The relay endpoint paths, Device JWT authentication, binary envelope and daemon/client protocol remain unchanged. Existing clients that implement standard WebSocket ping/pong handling require no upgrade.

The message limit applies after WebSocket upgrade and is independent of HTTP request-body handling.

## Out of scope

- Revalidating JWT expiry or revocation after a WebSocket has been established.
- Graceful Kubernetes connection draining and rollout coordination.
- Replacing Redis Streams or changing the relay delivery guarantee.
- Adding a concurrent-client limit, sticky sessions or a new relay protocol version.

## Testing decisions

| Seam | What it verifies | Prior art |
|---|---|---|
| Redis forwarder service | Successfully delivered and undeliverable entries are removed from the stream; delivery ACK behaviour and pending recovery remain intact. | `internal/service/relay_svc/relay_test.go` delivery acknowledgement and undeliverable-frame tests |
| Relay controller over real WebSockets | Oversized frames are disconnected; heartbeat activity keeps a compliant connection alive; an unresponsive peer is closed within the configured policy using test-time timing seams rather than production-duration sleeps. | `internal/controller/relay_ctr/relay_test.go` real WebSocket route tests |
| Cross-instance regression | Client and daemon on different server instances still exchange request and response frames. | `TestRelayFramesCrossServerInstances` |

A real ingress controller's timeout behaviour is not hermetically reproducible in the unit suite. Wrap-up verification will render the Helm chart and inspect the generated Ingress annotations; real cross-network/NAT behaviour remains covered by the account-relay manual verification track.

## Open questions

None.
