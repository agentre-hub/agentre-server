package personal_token_entity

import (
	"strings"
	"testing"
	"time"

	. "github.com/smartystreets/goconvey/convey"
)

func TestNormalizeScopes(t *testing.T) {
	Convey("NormalizeScopes", t, func() {
		Convey("when the scopes are all known, then they come back de-duplicated in canonical order", func() {
			got, err := NormalizeScopes([]string{" approve", "read", "chat", "read", "devices:write", "resources:write"})
			So(err, ShouldBeNil)
			So(got, ShouldResemble, []string{ScopeRead, ScopeChat, ScopeApprove, ScopeResourcesWrite, ScopeDevicesWrite})
		})
		Convey("when a scope is unknown, then it is rejected", func() {
			_, err := NormalizeScopes([]string{"read", "admin"})
			So(err, ShouldNotBeNil)
		})
		Convey("when no scope is given, then it is rejected — a token with no scope can do nothing", func() {
			_, err := NormalizeScopes(nil)
			So(err, ShouldNotBeNil)
			_, err = NormalizeScopes([]string{" "})
			So(err, ShouldNotBeNil)
		})
	})
}

func TestScopeList_RoundTripsTheStoredColumn(t *testing.T) {
	Convey("when scopes are stored, then ScopeList reads back the same list", t, func() {
		tok := &PersonalToken{}
		tok.SetScopes([]string{ScopeRead, ScopeApprove})
		So(tok.Scopes, ShouldEqual, "read,approve")
		So(tok.ScopeList(), ShouldResemble, []string{ScopeRead, ScopeApprove})
		So((&PersonalToken{}).ScopeList(), ShouldBeEmpty)
	})
}

func TestNormalizeName(t *testing.T) {
	Convey("NormalizeName", t, func() {
		Convey("when the name is a plain identifier, then it is kept (trimmed)", func() {
			got, err := NormalizeName("  ci-deploy.v2_bot ")
			So(err, ShouldBeNil)
			So(got, ShouldEqual, "ci-deploy.v2_bot")
		})
		Convey("when the name is empty, too long or carries a path separator, then it is rejected", func() {
			for _, bad := range []string{"", "   ", strings.Repeat("a", MaxNameLength+1), "a/b", "has space", "-leading"} {
				_, err := NormalizeName(bad)
				So(err, ShouldNotBeNil)
			}
			_, err := NormalizeName(strings.Repeat("a", MaxNameLength))
			So(err, ShouldBeNil)
		})
	})
}

func TestLifetime(t *testing.T) {
	const now = int64(1_000_000)
	Convey("Lifetime", t, func() {
		Convey("when nothing is asked for, then the default is 30 days", func() {
			So(DefaultLifetime, ShouldEqual, 30*24*time.Hour)
		})
		Convey("when the token has a lifetime, then it expires that long after now", func() {
			tok := &PersonalToken{}
			tok.Renew(now, int64(time.Hour/time.Millisecond))
			So(tok.LifetimeMs, ShouldEqual, int64(3_600_000))
			So(tok.ExpiresAt, ShouldEqual, now+3_600_000)
			So(tok.ValidAt(now+3_599_999), ShouldBeTrue)
			So(tok.ValidAt(now+3_600_000), ShouldBeFalse)
		})
		Convey("when the token never expires, then expires_at is 0 and it is valid forever", func() {
			tok := &PersonalToken{}
			tok.Renew(now, 0)
			So(tok.ExpiresAt, ShouldEqual, 0)
			So(tok.NeverExpires(), ShouldBeTrue)
			So(tok.ValidAt(now+int64(100*365*24*time.Hour/time.Millisecond)), ShouldBeTrue)
		})
		Convey("when there is no row, then there is no valid token", func() {
			So((*PersonalToken)(nil).ValidAt(now), ShouldBeFalse)
		})
	})
}
