import { fail } from './errors.js'

export const RIPPLE_EPOCH_UNIX_SECONDS = 946_684_800
const UINT32_MAX = 0xffff_ffff

export function unixSecondsToRippleTime(unixSeconds: number): number {
  if (!Number.isSafeInteger(unixSeconds)) {
    return fail('RIPPLE_TIME_INVALID', 'Unix time must be an integer number of seconds', '$time')
  }
  const rippleTime = unixSeconds - RIPPLE_EPOCH_UNIX_SECONDS
  if (rippleTime < 0 || rippleTime > UINT32_MAX) {
    return fail('RIPPLE_TIME_INVALID', 'Unix time is outside the XRPL uint32 time range', '$time')
  }
  return rippleTime
}

export function rippleTimeToUnixSeconds(rippleTime: number): number {
  if (!Number.isInteger(rippleTime) || rippleTime < 0 || rippleTime > UINT32_MAX) {
    return fail('RIPPLE_TIME_INVALID', 'Ripple time must be a uint32', '$time')
  }
  return rippleTime + RIPPLE_EPOCH_UNIX_SECONDS
}

export function iso8601ToRippleTime(value: string): number {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(value)
  ) {
    return fail(
      'RIPPLE_TIME_INVALID',
      'Expiration must be a UTC ISO-8601 timestamp with whole-second precision',
      '$time',
    )
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    return fail('RIPPLE_TIME_INVALID', 'Expiration is not a real calendar date', '$time')
  }
  const normalized = new Date(milliseconds).toISOString()
  const expected = value.includes('.') ? value : value.replace('Z', '.000Z')
  if (normalized !== expected) {
    return fail('RIPPLE_TIME_INVALID', 'Expiration is not a canonical calendar date', '$time')
  }
  return unixSecondsToRippleTime(milliseconds / 1000)
}

export function rippleTimeToIso8601(rippleTime: number): string {
  return new Date(rippleTimeToUnixSeconds(rippleTime) * 1000).toISOString()
}
