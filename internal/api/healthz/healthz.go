package healthz

import "github.com/cago-frame/cago/server/mux"

type HealthzRequest struct {
	mux.Meta `path:"/v1/healthz" method:"GET"`
}
type HealthzResponse struct {
	Status string `json:"status"`
	DBPing bool   `json:"db_ping"`
	Redis  bool   `json:"redis"`
}
