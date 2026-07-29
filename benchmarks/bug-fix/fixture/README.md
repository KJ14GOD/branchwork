# throttle

A token bucket used to pace outbound requests. `src/rate-limiter.js` is the
whole implementation; `npm test` runs the suite.

## The contract

- A bucket holds at most `burst` tokens and starts full.
- Every whole `intervalMs` credits `refill` more tokens, capped at `burst`.
- Refill is **discrete**. After 1.9 intervals exactly one interval has been
  earned. The remaining 0.9 is owed and is credited when it completes, not
  before. This is intentional: callers pace themselves off the step, and a
  continuously trickling bucket would let a client that polls in a tight loop
  take a token a few microseconds early, every time.
- `tryRemove(n)` spends exactly n tokens or spends nothing.
- The clock is injected. Nothing in this package sleeps.

## The reported problem

A service that retries every 100ms against a bucket configured for one token
per second is never let through again after its first burst. A service that
retries once a second against the same bucket works fine. The rate is supposed
to be a property of the bucket, not of how often the caller asks.
