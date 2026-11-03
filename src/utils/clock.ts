/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Windows and memos measured on the wall clock (Date.now()), read so that a
 * clock stepped back does not make them last the step longer: a reading in
 * the future, or a deadline further ahead than it was ever set, was taken
 * before the step and counts as expired. (The call deadlines use timers, which
 * a wall-clock step does not move.)
 */

/** Whether `since`, a Date.now() reading, is less than `ms` ago — never when it lies in the future. */
export function withinLast(since: number, ms: number, now: number = Date.now()): boolean {
  const age = now - since;
  return age >= 0 && age < ms;
}

/**
 * Whether `until`, a deadline set at most `span` ms ahead of a Date.now()
 * reading, is still ahead — never when it is further ahead than `span`.
 */
export function stillAhead(until: number, span: number, now: number = Date.now()): boolean {
  return until > now && until - now <= span;
}
