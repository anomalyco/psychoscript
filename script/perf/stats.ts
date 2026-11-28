export const median = (xs: ReadonlyArray<number>) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

export const min = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => Math.min(a, b), Infinity)
export const max = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => Math.max(a, b), -Infinity)

/** 95% bootstrap interval of the median (10k resamples, fixed seed so a report reproduces). Resample per-process values only. */
export const bootstrapMedian = (xs: ReadonlyArray<number>, resamples = 10_000): readonly [number, number] => {
  if (xs.length < 2) return [xs[0] ?? NaN, xs[0] ?? NaN]
  let seed = 0x2545f491
  const rand = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0x100000000
  }
  const meds = Array.from({ length: resamples }, () => median(Array.from(xs, () => xs[Math.floor(rand() * xs.length)]!)))
  meds.sort((a, b) => a - b)
  return [meds[Math.floor(resamples * 0.025)]!, meds[Math.floor(resamples * 0.975)]!]
}
