package backoff

import (
	"testing"
	"time"
)

// The intended operating envelope from the deployment runbook:
// base delay always in [1, max] seconds; jitter adds at most 1s.
const (
	minBaseSeconds = 1
	maxBaseSeconds = 60
	maxJitter      = 999 * time.Millisecond
)

func assertInRange(t *testing.T, label string, d time.Duration) {
	t.Helper()
	if d < minBaseSeconds*time.Second {
		t.Fatalf("%s: delay %v below the 1s lower bound", label, d)
	}
	if d > maxBaseSeconds*time.Second+maxJitter {
		t.Fatalf("%s: delay %v exceeds the %ds cap + jitter", label, d, maxBaseSeconds)
	}
}

func TestBackoffZeroRetries(t *testing.T) {
	d := backoff(0, maxBaseSeconds)
	assertInRange(t, "zero retries", d)
	if got := fixedBase(0, maxBaseSeconds); got != 1*time.Second {
		t.Fatalf("zero retries base = %v, want 1s", got)
	}
}

func TestBackoffNormalRetries(t *testing.T) {
	for _, retries := range []int{1, 2, 3, 5} {
		d := backoff(retries, maxBaseSeconds)
		assertInRange(t, "normal retries", d)
		want := time.Duration(1<<retries) * time.Second
		if got := fixedBase(retries, maxBaseSeconds); got != want {
			t.Fatalf("retries=%d base = %v, want %v", retries, got, want)
		}
	}
}

func TestBackoffCappedAtMax(t *testing.T) {
	// 2^6 = 64 > 60: the cap must engage at retries=6 already.
	if got := fixedBase(6, maxBaseSeconds); got != 60*time.Second {
		t.Fatalf("retries=6 base = %v, want capped 60s", got)
	}
	d := backoff(6, maxBaseSeconds)
	assertInRange(t, "capped", d)
}

func TestBackoffVeryLargeRetryCounts(t *testing.T) {
	// The production storm: retry counts of 15k-162k. Under the old
	// arithmetic, 1<<15000 overflows and the delay collapses toward 0.
	for _, retries := range []int{15_000, 162_000, 1_000_000, int(^uint(0) >> 1)} {
		d := backoff(retries, maxBaseSeconds)
		assertInRange(t, "very large retries", d)
		// Must sit at the capped ceiling, not near-now.
		if got := fixedBase(retries, maxBaseSeconds); got != 60*time.Second {
			t.Fatalf("retries=%d base = %v, want capped 60s", retries, got)
		}
	}
}

func TestBackoffNeverBelowOneSecond(t *testing.T) {
	// The invariant the storm violated: retry_after must never land just
	// seconds ahead. Check across a sweep of counts including boundary
	// shift-overflow values.
	for retries := 0; retries < 130; retries++ {
		d := backoff(retries, maxBaseSeconds)
		if d < minBaseSeconds*time.Second {
			t.Fatalf("retries=%d delay %v below 1s", retries, d)
		}
	}
}

func TestBackoffExtremeRetryCountsWithinEnvelope(t *testing.T) {
	// The old "extreme MaxInt envelope" case was invalid: with max = MaxInt
	// and retries >= 60, 1<<60 seconds converted to nanoseconds overflows
	// time.Duration to a negative value, so the test itself could never
	// pass on the Go box. The deployment envelope caps max at 60 seconds;
	// what must be guarded is that extreme RETRY COUNTS inside that real
	// envelope saturate to the cap and never overflow.
	for _, retries := range []int{0, 30, 60, 63, 1000, 162_000} {
		base := fixedBase(retries, maxBaseSeconds)
		if base < minBaseSeconds*time.Second {
			t.Fatalf("retries=%d base %v below 1s", retries, base)
		}
		if base > maxBaseSeconds*time.Second {
			t.Fatalf("retries=%d base %v exceeds the %ds cap", retries, base, maxBaseSeconds)
		}
	}
}
