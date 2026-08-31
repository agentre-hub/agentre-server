module github.com/agentre-hub/agentre-server

go 1.26.0

require (
	github.com/DATA-DOG/go-sqlmock v1.5.2
	github.com/agentre-hub/agentre/pkg/wire v0.0.0-20260831040959-95027d400ca2
	github.com/alicebob/miniredis/v2 v2.32.1
	github.com/cago-frame/cago v0.0.0-20260609091633-ba2f550b2729
	github.com/gin-gonic/gin v1.10.0
	github.com/go-gormigrate/gormigrate/v2 v2.1.2
	github.com/go-sql-driver/mysql v1.8.1
	github.com/go-webauthn/webauthn v0.17.4
	github.com/golang-jwt/jwt/v5 v5.3.1
	github.com/gorilla/websocket v1.5.3
	github.com/oklog/ulid/v2 v2.1.1
	github.com/redis/go-redis/v9 v9.7.0
	github.com/smartystreets/goconvey v1.8.1
	github.com/stretchr/testify v1.11.1
	go.uber.org/mock v0.6.0
	go.uber.org/zap v1.27.0
	google.golang.org/protobuf v1.36.11
	gopkg.in/yaml.v3 v3.0.1
	gorm.io/driver/mysql v1.5.7
	gorm.io/gorm v1.25.12
)

replace github.com/ugorji/go v1.1.4 => github.com/ugorji/go v1.2.12

require (
	filippo.io/edwards25519 v1.1.0 // indirect
	github.com/KyleBanks/depth v1.2.1 // indirect
	github.com/alicebob/gopher-json v0.0.0-20200520072559-a9ecdc9d1d3a // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/bytedance/sonic v1.12.5 // indirect
	github.com/bytedance/sonic/loader v0.2.1 // indirect
	github.com/cenkalti/backoff/v4 v4.3.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/cloudwego/base64x v0.1.4 // indirect
	github.com/cloudwego/iasm v0.2.0 // indirect
	github.com/coreos/go-semver v0.3.0 // indirect
	github.com/coreos/go-systemd/v22 v22.5.0 // indirect
	github.com/davecgh/go-spew v1.1.1 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/elastic/elastic-transport-go/v8 v8.4.0 // indirect
	github.com/elastic/go-elasticsearch/v8 v8.12.1 // indirect
	github.com/fxamacker/cbor/v2 v2.9.2 // indirect
	github.com/gabriel-vasile/mimetype v1.4.7 // indirect
	github.com/gin-contrib/sse v0.1.0 // indirect
	github.com/go-logr/logr v1.4.3 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/go-openapi/jsonpointer v0.21.0 // indirect
	github.com/go-openapi/jsonreference v0.21.0 // indirect
	github.com/go-openapi/spec v0.21.0 // indirect
	github.com/go-openapi/swag v0.23.0 // indirect
	github.com/go-playground/locales v0.14.1 // indirect
	github.com/go-playground/universal-translator v0.18.1 // indirect
	github.com/go-playground/validator/v10 v10.23.0 // indirect
	github.com/go-viper/mapstructure/v2 v2.5.0 // indirect
	github.com/go-webauthn/x v0.2.6 // indirect
	github.com/goccy/go-json v0.10.3 // indirect
	github.com/gogo/protobuf v1.3.2 // indirect
	github.com/golang/protobuf v1.5.4 // indirect
	github.com/golang/snappy v0.0.4 // indirect
	github.com/google/go-tpm v0.9.8 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/gopherjs/gopherjs v1.17.2 // indirect
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.19.1 // indirect
	github.com/jinzhu/inflection v1.0.0 // indirect
	github.com/jinzhu/now v1.1.5 // indirect
	github.com/josharian/intern v1.0.0 // indirect
	github.com/json-iterator/go v1.1.12 // indirect
	github.com/jtolds/gls v4.20.0+incompatible // indirect
	github.com/klauspost/compress v1.18.5 // indirect
	github.com/klauspost/cpuid/v2 v2.2.9 // indirect
	github.com/leodido/go-urn v1.4.0 // indirect
	github.com/mailru/easyjson v0.7.7 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/mitchellh/mapstructure v1.5.0 // indirect
	github.com/modern-go/concurrent v0.0.0-20180306012644-bacd9c7ef1dd // indirect
	github.com/modern-go/reflect2 v1.0.2 // indirect
	github.com/montanaflynn/stats v0.7.1 // indirect
	github.com/nsqio/go-nsq v1.1.0 // indirect
	github.com/patrickmn/go-cache v2.1.0+incompatible // indirect
	github.com/pelletier/go-toml/v2 v2.2.3 // indirect
	github.com/philhofer/fwd v1.2.0 // indirect
	github.com/pmezard/go-difflib v1.0.0 // indirect
	github.com/prometheus/client_golang v1.19.0 // indirect
	github.com/prometheus/client_model v0.6.0 // indirect
	github.com/prometheus/common v0.48.0 // indirect
	github.com/prometheus/procfs v0.12.0 // indirect
	github.com/redis/go-redis/extra/rediscmd/v9 v9.0.5 // indirect
	github.com/redis/go-redis/extra/redisotel/v9 v9.0.5 // indirect
	github.com/robfig/cron/v3 v3.0.1 // indirect
	github.com/smarty/assertions v1.15.0 // indirect
	github.com/swaggo/files v1.0.1 // indirect
	github.com/swaggo/gin-swagger v1.6.0 // indirect
	github.com/swaggo/swag v1.16.3 // indirect
	github.com/tinylib/msgp v1.6.4 // indirect
	github.com/twitchyliquid64/golang-asm v0.15.1 // indirect
	github.com/ugorji/go/codec v1.2.12 // indirect
	github.com/x448/float16 v0.8.4 // indirect
	github.com/xdg-go/pbkdf2 v1.0.0 // indirect
	github.com/xdg-go/scram v1.1.2 // indirect
	github.com/xdg-go/stringprep v1.0.4 // indirect
	github.com/youmark/pkcs8 v0.0.0-20240726163527-a2c0da244d78 // indirect
	github.com/yuin/gopher-lua v1.1.1 // indirect
	go.etcd.io/etcd/api/v3 v3.5.12 // indirect
	go.etcd.io/etcd/client/pkg/v3 v3.5.12 // indirect
	go.etcd.io/etcd/client/v3 v3.5.12 // indirect
	go.mongodb.org/mongo-driver v1.17.1 // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/contrib/instrumentation/go.mongodb.org/mongo-driver/mongo/otelmongo v0.51.0 // indirect
	go.opentelemetry.io/otel v1.41.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace v1.26.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.26.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.26.0 // indirect
	go.opentelemetry.io/otel/exporters/prometheus v0.46.0 // indirect
	go.opentelemetry.io/otel/metric v1.41.0 // indirect
	go.opentelemetry.io/otel/sdk v1.40.0 // indirect
	go.opentelemetry.io/otel/sdk/metric v1.40.0 // indirect
	go.opentelemetry.io/otel/trace v1.41.0 // indirect
	go.opentelemetry.io/proto/otlp v1.2.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	golang.org/x/arch v0.12.0 // indirect
	golang.org/x/crypto v0.52.0 // indirect
	golang.org/x/net v0.54.0 // indirect
	golang.org/x/sync v0.20.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
	golang.org/x/text v0.37.0 // indirect
	golang.org/x/tools v0.44.0 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20251029180050-ab9386a59fda // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260128011058-8636f8732409 // indirect
	google.golang.org/grpc v1.78.0 // indirect
	gopkg.in/natefinch/lumberjack.v2 v2.2.1 // indirect
	gorm.io/plugin/opentelemetry v0.1.11 // indirect
)
