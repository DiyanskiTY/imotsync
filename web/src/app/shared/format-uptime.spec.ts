import { formatUptime } from './format-uptime';

describe('formatUptime', () => {
  it.each([
    [0, '0s'],
    [45, '45s'],
    [60, '1m 0s'],
    [725, '12m 5s'],
    [3_600, '1h 0m'],
    [12_034, '3h 20m'],
    [86_400, '1d 0h'],
    [187_200, '2d 4h'],
  ])('formats %i seconds as "%s"', (seconds, expected) => {
    expect(formatUptime(seconds)).toBe(expected);
  });

  it('ignores fractions and negative values', () => {
    expect(formatUptime(59.9)).toBe('59s');
    expect(formatUptime(-5)).toBe('0s');
  });
});
