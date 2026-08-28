# Observability

Three signals are wired through cago: logs answer "what happened", metrics answer "how
much and how often", and traces answer "where did this request spend its time". Logs and
metrics are registered at startup; trace export depends on `trace` configuration.

## Logging

**`logger.Ctx(ctx)` is the only logging entry point.** It is cago's zap wrapper, and it
carries request-scoped fields (including trace correlation) that a bare logger does not.

```go
import (
	"github.com/cago-frame/cago/pkg/logger"
	"go.uber.org/zap"
)

logger.Ctx(ctx).Error("cleanup device_flow_codes", zap.Error(err))
```

That line is from `internal/task/crontab/cleanup.go` — the shape to copy.

- **Message**: a short, stable, lowercase description. No formatting, no interpolated
  values — those go in fields, where they stay queryable.
- **Fields**: always structured (`zap.String`, `zap.Int64`, `zap.Error`). Never build a
  message with `fmt.Sprintf`.
- Always pass `ctx`. Without it you lose correlation and the log becomes an orphan line.

`fmt.Print*` and `log.Print*` are **banned** by `forbidigo` in `.golangci.yml`. They have
no level, no structure, and never reach the log file, so in production they are equivalent
to not logging.

The single exemption is startup: `cmd/server/main.go` and `internal/bootstrap/cago.go` run
before `component.Core()` has built the logger, so stdlib `log` is all they have. That
window is declared in `.golangci.yml` under `linters.exclusions.rules`.

### Levels

| Level | Use for |
| --- | --- |
| `Error` | Something failed and a human needs to look. Attach `zap.Error(err)` |
| `Warn` | Degraded but handled — a retry succeeded, a fallback engaged |
| `Info` | State changes worth reconstructing later: device approved, token rotated, user created |
| `Debug` | Development detail. Off in production |

Do not log an error and also return it — the caller will log it too and you get the same
failure three times at three layers. Log where it is handled, return everywhere else.

### Data policy

Sensitive server fields are not log fields. Do not log credentials, authorization or
cookie values, tokens, secrets, complete DSNs, OAuth payloads, raw third-party responses,
or personal data; omit them at the source instead of relying on a generic masking layer.
`zap.Error(err)` is subject to the same rule because an error string can contain the
underlying request or secret. Raw protocol diagnostic frames may be emitted at `Debug`
only when that diagnostic visibility is an explicit feature contract and the frame does
not cross the server-sensitive-field boundary.

## Metrics

`metric.Metrics` is registered in `cmd/server/main.go`. It installs a gin middleware and
exposes **`GET /metrics`** in Prometheus format — HTTP request counts, durations and status
codes, per route, with no per-endpoint work.

No configuration is needed. Point a scraper at `/metrics`.

For a custom metric, take a meter from the global provider (`otel.GetMeterProvider()`) and
create instruments at package level, not per request. Add one when you can name the
decision it informs — an unused metric is a dashboard nobody reads.

`/metrics` is unauthenticated, which is fine behind an ingress and not fine if the service
is directly exposed. Restrict it at the ingress before going public.

## Traces

After `component.Core()`, `trace.Trace` is registered before database, Redis, business
components and the mux in `cmd/server/main.go`. Order matters: later components and the
mux middleware check `trace.Default()` when wiring tracing.

Configured under `trace:` in `configs/config.yaml`:

```yaml
trace:
  type: empty     # grpc | http | empty | noop
  sample: 1
  endpoint: ""
```

`type: empty` is the default and the reason it is a good one: it generates **valid
trace_id/span_id without exporting anywhere**. You get request correlation in logs
locally without running a collector. `noop` generates nothing. Switch to `grpc`/`http`
and set `endpoint` once you have a collector; drop `sample` well below 1 under load.

### `trace.type` must be set explicitly

`cmd/server/main.go` only registers tracing when `trace.type` is one of
`grpc` / `http` / `empty` / `noop`. Anything else logs `tracing disabled: ...` and skips.
That looks defensive but is guarding two real failures:

- **A config with no `trace:` section.** `trace.Trace` scans for it and returns
  `key not found`, which cago turns into a **startup panic** — the service does not boot.
- **Worse, the zero value.** After that failed scan cago **writes the key back into your
  config file with zero values**, leaving `type: ""`. An empty type falls through
  `trace`'s switch to the `default` branch — an OTLP/**gRPC exporter pointed at an empty
  endpoint**, quietly retrying into nothing forever. Nothing errors; you just have a
  background task burning cycles and no traces.

So if you want tracing, set `type` yourself. If you see `tracing disabled` at startup,
that is the message telling you it is not set.

HTTP spans are automatic — the middleware wraps every request, so most of the time you
add nothing. Add a manual span for external calls (GitHub OAuth), expensive queries and
cron jobs, where "it was slow" needs an answer:

```go
import "github.com/cago-frame/cago/pkg/opentelemetry/trace"

ctx, span := trace.StartSpan(ctx, "device_svc.ExchangeToken")
defer span.End()
```

### `StartSpan` panics if the trace component never ran

`trace.StartSpan` → `TracerFromContext` → falls back to `trace.Default()`, which is **nil**
until `trace.Trace` has been registered. There is no nil check, so the call is a
segfault, not a no-op.

In the running server this is fine — `cmd/server/main.go` registers `trace.Trace` before
anything else. **In a unit test it is not.** Any code you cover that calls `StartSpan`
will panic unless the test initializes a provider first:

```go
tp, err := trace.NewWithConfig(ctx, &trace.Config{Type: "empty", Sample: 1})
require.NoError(t, err)
ctx = trace.ContextWithTracer(ctx, tp.Tracer("test"))
// StartSpan is now safe; span.SpanContext().IsValid() == true
```

So weigh a manual span against the test setup it imposes. Prefer the automatic HTTP spans,
and instrument by hand only where the timing question is real.

`trace.LoggerLabel(ctx)` returns `trace_id`/`span_id` as zap fields (two of them, once a
span is active) when you need to correlate by hand.

## Investigating

1. Find the request in the logs; take its `trace_id`.
2. Pull the trace to see which span consumed the time.
3. Check `/metrics` for whether the failure is one request or a rate change.
4. Reproduce under `e2e/scratch/` — see [verification.md](verification.md).
