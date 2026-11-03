/**
 * SPDX-FileCopyrightText: 2026 Magic Lane International B.V. <info@magiclane.com>
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { stillAhead, withinLast } from '../../src/utils/clock.js';

describe('clock', () => {
  it('counts a reading as within the last ms only when it is in the past', () => {
    expect(withinLast(900, 200, 1000)).toBe(true);
    expect(withinLast(1000, 200, 1000)).toBe(true);
    expect(withinLast(800, 200, 1000)).toBe(false);
    expect(withinLast(1001, 200, 1000)).toBe(false); // from before a clock step back
    expect(withinLast(Number.NEGATIVE_INFINITY, 200, 1000)).toBe(false);
  });

  it('counts a deadline as ahead only within the span it could have been set', () => {
    expect(stillAhead(1100, 200, 1000)).toBe(true);
    expect(stillAhead(1200, 200, 1000)).toBe(true);
    expect(stillAhead(1000, 200, 1000)).toBe(false);
    expect(stillAhead(1201, 200, 1000)).toBe(false); // from before a clock step back
  });
});
