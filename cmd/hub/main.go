package main

import (
	"fmt"

	"agentre-hub/internal/buildinfo"
)

func main() {
	fmt.Printf("agentre-hub %s (%s)\n", buildinfo.Version, buildinfo.Commit)
}
