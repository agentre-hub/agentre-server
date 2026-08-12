// Command synce2e is the harness the desktop repo's local end-to-end sync suite
// drives (agentre `e2e/sync/`, spec docs/specs/2026-08-07-workspace-sync.md
// 「本地端到端」). It is a test tool, never part of the shipped server.
//
// It covers the two prerequisites that suite has and the product does not:
//
//   - **seed / cleanup** — the desktop logs in through RFC 8628 Device Flow whose
//     terminus is GitHub OAuth, which nobody can click in an e2e. `seed` writes an
//     account + its devices + one refresh token per device straight into
//     MySQL; every run gets its own account and its own fingerprints, and
//     `cleanup` removes exactly the rows that run created (scoped by user id — it
//     never truncates and never touches a row it did not write).
//   - **peer** — a simulated second desktop that speaks the same `/v1/sync/*`
//     endpoints as the real one, with its own device identity and its own set of
//     paired agentred fingerprints. That last dimension is what R2b / R15 need:
//     the same synced Agent resolves to a different execution target depending on
//     which agentreds the receiving end has paired.
//
// Every subcommand prints one JSON document on stdout so the Playwright side can
// parse it; diagnostics go to stderr.
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "seed":
		err = runSeed(os.Args[2:])
	case "cleanup":
		err = runCleanup(os.Args[2:])
	case "local-paths":
		err = runLocalPaths(os.Args[2:])
	case "peer":
		err = runPeer(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "synce2e %s: %v\n", os.Args[1], err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `synce2e — local end-to-end harness for workspace sync (test tool)

  synce2e seed        --dsn DSN --run-id ID --devices name:kind:platform[,...]
  synce2e cleanup     --dsn DSN --run-id ID
  synce2e local-paths --dsn DSN --run-id ID

  synce2e peer init               --state F --base-url URL --device-id N --refresh-token T [--paired fp,...]
  synce2e peer sync               --state F
  synce2e peer push               --state F --kind K [--sync-id S] [--base-version N] [--payload JSON]
                                  [--deleted] [--project-sync-id P] [--fingerprint FP]
  synce2e peer dump               --state F
  synce2e peer report-local-paths --state F --items '[{"project_sync_id":"..","path":".."}]'
  synce2e peer exec-targets       --state F --agent-sync-id S [--paired fp,...]
`)
}
