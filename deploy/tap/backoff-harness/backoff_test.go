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

func TestBackoffExtremeMaxParameter(t *testing.T) {
	// max is a call-site constant but guard the arithmetic anyway: a huge
	// max must still never overflow to a negative duration.
	for _, retries := range []int{0, 30, 60, 63, 1000} {
		base := fixedBase(retries, int(^uint(0)>>1))
		if base < minBaseSeconds*time.Second {
			t.Fatalf("retries=%d base %v below 1s with extreme max", retries, base)
		}
	}
}
