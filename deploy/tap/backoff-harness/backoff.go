// Package backoff mirrors the FIXED `backoff` function from
// bluesky-social/indigo cmd/tap/util.go, as applied by the downstream
// patch deploy/tap/patches/0001-tap-backoff-saturating.patch (base
// 41278964ec8e3253e70d4e919dfb8e34211c543d).
//
// This package exists so the retry arithmetic can be regression-tested
// WITHOUT building all of Indigo on this machine. It is a VERIFICATION
// FIXTURE, not the production code path: the deployed binary is built
// from the patched upstream source, and tap-update.sh fails the build
// unless the pinned patch applies cleanly on the pinned base revision.
//
// To keep the fixture honest, this file must stay byte-identical to the
// patched function: update it only together with the .patch file, and run
//
//	./verify.sh
//
// after any change (and on the box: go test -C /var/lib/kipclip/source/deploy/tap/backoff-harness ./...).
package backoff

import (
	"math/rand"
	"time"
)

// backoff returns the retry delay for `retries` previous failures with a
// maximum base of `max` seconds, plus up to 1s of jitter.
func backoff(retries int, max int) time.Duration {
	// Cap the exponent BEFORE shifting: `1 << retries` overflows for large
	// retry counts (on 64-bit ints, shifts >= 63 produce 0 or negative values),
	// which collapsed the intended backoff into a near-now retry storm. With
	// the exponent capped at 60, the base delay stays within [1, max] seconds
	// plus <=1s jitter, and retry_after can never drop below ~1s.
	exp := retries
	if exp > 60 {
		exp = 60
	}
	dur := int64(1) << exp
	if dur > int64(max) {
		dur = int64(max)
	}

	jitter := time.Millisecond * time.Duration(rand.Intn(1000))
	return time.Second*time.Duration(dur) + jitter
}

// fixedBase returns the pre-jitter base seconds, for range assertions.
func fixedBase(retries int, max int) time.Duration {
	exp := retries
	if exp > 60 {
		exp = 60
	}
	dur := int64(1) << exp
	if dur > int64(max) {
		dur = int64(max)
	}
	return time.Second * time.Duration(dur)
}
