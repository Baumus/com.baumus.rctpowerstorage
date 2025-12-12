'use strict';

const {
  getIntervalOfDay,
  getPriceAtTime,
  filterFutureIntervals,
  filterCurrentAndFutureIntervals,
  enrichPriceData,
  groupConsecutiveIntervals,
  formatTime,
  formatDateTime,
  isToday,
  isTomorrow,
  getNextIntervalStart,
  intervalMinutesToHours,
  intervalsPerDay,
  isSameDay,
} = require('../drivers/energy-optimizer/time-scheduling-core');

describe('time-scheduling-core', () => {
  describe('getIntervalOfDay', () => {
    it('should calculate correct interval for midnight', () => {
      const date = new Date(2024, 0, 15, 0, 0, 0); // Local time
      expect(getIntervalOfDay(date)).toBe(0);
    });

    it('should calculate correct interval for 15 minutes', () => {
      const date = new Date(2024, 0, 15, 0, 15, 0);
      expect(getIntervalOfDay(date)).toBe(1);
    });

    it('should calculate correct interval for noon', () => {
      const date = new Date(2024, 0, 15, 12, 0, 0);
      expect(getIntervalOfDay(date)).toBe(48); // 12 * 4
    });

    it('should calculate correct interval for 23:45', () => {
      const date = new Date(2024, 0, 15, 23, 45, 0);
      expect(getIntervalOfDay(date)).toBe(95); // Last 15-min interval
    });

    it('should handle 30-minute intervals', () => {
      const date = new Date(2024, 0, 15, 1, 0, 0);
      expect(getIntervalOfDay(date, 30)).toBe(2); // 60 / 30
    });

    it('should return -1 for invalid date', () => {
      expect(getIntervalOfDay(null)).toBe(-1);
      expect(getIntervalOfDay(undefined)).toBe(-1);
      expect(getIntervalOfDay(new Date('invalid'))).toBe(-1);
    });
  });

  describe('getPriceAtTime', () => {
    const priceCache = [
      { startsAt: new Date(2024, 0, 15, 10, 0, 0).toISOString(), total: 0.20 },
      { startsAt: new Date(2024, 0, 15, 10, 15, 0).toISOString(), total: 0.22 },
      { startsAt: new Date(2024, 0, 15, 10, 30, 0).toISOString(), total: 0.25 },
      { startsAt: new Date(2024, 0, 15, 11, 0, 0).toISOString(), total: 0.30 },
    ];

    it('should find price for exact match', () => {
      const timestamp = new Date(2024, 0, 15, 10, 15, 0);
      expect(getPriceAtTime(timestamp, priceCache)).toBe(0.22);
    });

    it('should find price for time within interval', () => {
      const timestamp = new Date(2024, 0, 15, 10, 20, 0); // Within 10:15-10:30 interval
      expect(getPriceAtTime(timestamp, priceCache)).toBe(0.22);
    });

    it('should return null for time not in cache', () => {
      const timestamp = new Date(2024, 0, 15, 9, 0, 0);
      expect(getPriceAtTime(timestamp, priceCache)).toBeNull();
    });

    it('should return null for empty cache', () => {
      const timestamp = new Date('2024-01-15T10:00:00Z');
      expect(getPriceAtTime(timestamp, [])).toBeNull();
    });

    it('should return null for invalid inputs', () => {
      expect(getPriceAtTime(null, priceCache)).toBeNull();
      expect(getPriceAtTime(new Date(), null)).toBeNull();
      expect(getPriceAtTime(new Date('invalid'), priceCache)).toBeNull();
    });

    it('should handle different days correctly', () => {
      const timestamp = new Date(2024, 0, 16, 10, 0, 0); // Different day
      expect(getPriceAtTime(timestamp, priceCache)).toBeNull();
    });
  });

  describe('filterFutureIntervals', () => {
    const priceData = [
      { startsAt: '2024-01-15T10:00:00Z' },
      { startsAt: '2024-01-15T11:00:00Z' },
      { startsAt: '2024-01-15T12:00:00Z' },
      { startsAt: '2024-01-15T13:00:00Z' },
    ];

    it('should filter to only future intervals', () => {
      const now = new Date('2024-01-15T11:30:00Z');
      const result = filterFutureIntervals(priceData, now);

      expect(result.length).toBe(2);
      expect(new Date(result[0].startsAt)).toEqual(new Date('2024-01-15T12:00:00Z'));
      expect(new Date(result[1].startsAt)).toEqual(new Date('2024-01-15T13:00:00Z'));
    });

    it('should return all intervals if all are in future', () => {
      const now = new Date('2024-01-15T09:00:00Z');
      const result = filterFutureIntervals(priceData, now);

      expect(result.length).toBe(4);
    });

    it('should return empty array if all intervals are past', () => {
      const now = new Date('2024-01-15T14:00:00Z');
      const result = filterFutureIntervals(priceData, now);

      expect(result.length).toBe(0);
    });

    it('should return empty array for invalid input', () => {
      expect(filterFutureIntervals(null)).toEqual([]);
      expect(filterFutureIntervals(undefined)).toEqual([]);
    });
  });

  describe('filterCurrentAndFutureIntervals', () => {
    const priceData = [
      { startsAt: '2024-01-15T10:00:00Z' },
      { startsAt: '2024-01-15T10:15:00Z' },
      { startsAt: '2024-01-15T10:30:00Z' },
      { startsAt: '2024-01-15T10:45:00Z' },
    ];

    it('should include current interval (started but not ended)', () => {
      const now = new Date('2024-01-15T10:20:00Z'); // In 10:15-10:30 interval
      const result = filterCurrentAndFutureIntervals(priceData, now, 15);

      expect(result.length).toBe(3);
      expect(new Date(result[0].startsAt)).toEqual(new Date('2024-01-15T10:15:00Z'));
    });

    it('should be sorted by start time', () => {
      const unsorted = [
        { startsAt: '2024-01-15T11:00:00Z' },
        { startsAt: '2024-01-15T10:00:00Z' },
        { startsAt: '2024-01-15T10:30:00Z' },
      ];
      const now = new Date('2024-01-15T10:00:00Z');
      const result = filterCurrentAndFutureIntervals(unsorted, now);

      expect(new Date(result[0].startsAt).getTime()).toBeLessThan(
        new Date(result[1].startsAt).getTime(),
      );
    });

    it('should handle 30-minute intervals', () => {
      const data = [
        { startsAt: '2024-01-15T10:00:00Z' },
        { startsAt: '2024-01-15T10:30:00Z' },
      ];
      const now = new Date('2024-01-15T10:15:00Z');
      const result = filterCurrentAndFutureIntervals(data, now, 30);

      expect(result.length).toBe(2);
    });

    it('should return empty array for invalid input', () => {
      expect(filterCurrentAndFutureIntervals(null)).toEqual([]);
      expect(filterCurrentAndFutureIntervals([])).toEqual([]);
    });
  });

  describe('enrichPriceData', () => {
    it('should add index and intervalOfDay to each entry', () => {
      const priceData = [
        { startsAt: new Date(2024, 0, 15, 0, 0, 0).toISOString(), total: 0.20 },
        { startsAt: new Date(2024, 0, 15, 0, 15, 0).toISOString(), total: 0.22 },
        { startsAt: new Date(2024, 0, 15, 12, 0, 0).toISOString(), total: 0.30 },
      ];

      const result = enrichPriceData(priceData);

      expect(result[0].index).toBe(0);
      expect(result[0].intervalOfDay).toBe(0);
      expect(result[1].index).toBe(1);
      expect(result[1].intervalOfDay).toBe(1);
      expect(result[2].index).toBe(2);
      expect(result[2].intervalOfDay).toBe(48);
    });

    it('should preserve original data', () => {
      const startsAt = new Date(2024, 0, 15, 10, 0, 0).toISOString();
      const priceData = [{ startsAt, total: 0.25 }];
      const result = enrichPriceData(priceData);

      expect(result[0].total).toBe(0.25);
      expect(result[0].startsAt).toBe(startsAt);
    });

    it('should handle empty array', () => {
      expect(enrichPriceData([])).toEqual([]);
    });

    it('should handle invalid input', () => {
      expect(enrichPriceData(null)).toEqual([]);
      expect(enrichPriceData(undefined)).toEqual([]);
    });
  });

  describe('groupConsecutiveIntervals', () => {
    it('should group consecutive intervals into one block', () => {
      const intervals = [
        { index: 0, startsAt: '2024-01-15T10:00:00Z' },
        { index: 1, startsAt: '2024-01-15T10:15:00Z' },
        { index: 2, startsAt: '2024-01-15T10:30:00Z' },
      ];

      const blocks = groupConsecutiveIntervals(intervals, 15);

      expect(blocks.length).toBe(1);
      expect(blocks[0].intervals.length).toBe(3);
      expect(blocks[0].duration).toBe(45);
    });

    it('should split non-consecutive intervals into separate blocks', () => {
      const intervals = [
        { index: 0, startsAt: '2024-01-15T10:00:00Z' },
        { index: 1, startsAt: '2024-01-15T10:15:00Z' },
        { index: 5, startsAt: '2024-01-15T11:15:00Z' }, // Gap
        { index: 6, startsAt: '2024-01-15T11:30:00Z' },
      ];

      const blocks = groupConsecutiveIntervals(intervals, 15);

      expect(blocks.length).toBe(2);
      expect(blocks[0].intervals.length).toBe(2);
      expect(blocks[1].intervals.length).toBe(2);
    });

    it('should set start and end times correctly', () => {
      const intervals = [
        { index: 0, startsAt: '2024-01-15T10:00:00Z' },
        { index: 1, startsAt: '2024-01-15T10:15:00Z' },
      ];

      const blocks = groupConsecutiveIntervals(intervals, 15);

      expect(blocks[0].start).toEqual(new Date('2024-01-15T10:00:00Z'));
      expect(blocks[0].end).toEqual(new Date('2024-01-15T10:30:00Z')); // 10:15 + 15min
    });

    it('should handle single interval', () => {
      const intervals = [{ index: 0, startsAt: '2024-01-15T10:00:00Z' }];
      const blocks = groupConsecutiveIntervals(intervals, 15);

      expect(blocks.length).toBe(1);
      expect(blocks[0].intervals.length).toBe(1);
    });

    it('should return empty array for empty input', () => {
      expect(groupConsecutiveIntervals([])).toEqual([]);
      expect(groupConsecutiveIntervals(null)).toEqual([]);
      expect(groupConsecutiveIntervals(undefined)).toEqual([]);
    });
  });

  describe('formatTime', () => {
    it('should format time as HH:MM', () => {
      const date = new Date(2024, 0, 15, 10, 5, 0);
      expect(formatTime(date)).toBe('10:05');
    });

    it('should pad single digits with zero', () => {
      const date = new Date(2024, 0, 15, 9, 5, 0);
      expect(formatTime(date)).toBe('09:05');
    });

    it('should handle midnight', () => {
      const date = new Date(2024, 0, 15, 0, 0, 0);
      expect(formatTime(date)).toBe('00:00');
    });

    it('should handle invalid date', () => {
      expect(formatTime(null)).toBe('Invalid Date');
      expect(formatTime(new Date('invalid'))).toBe('Invalid Date');
    });
  });

  describe('formatDateTime', () => {
    it('should format date and time', () => {
      const date = new Date(2024, 0, 15, 10, 5, 0);
      expect(formatDateTime(date)).toBe('2024-01-15 10:05');
    });

    it('should handle invalid date', () => {
      expect(formatDateTime(null)).toBe('Invalid Date');
    });
  });

  describe('isToday', () => {
    it('should return true for today', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      const date = new Date('2024-01-15T08:00:00Z');
      expect(isToday(date, now)).toBe(true);
    });

    it('should return false for yesterday', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      const date = new Date('2024-01-14T12:00:00Z');
      expect(isToday(date, now)).toBe(false);
    });

    it('should return false for tomorrow', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      const date = new Date('2024-01-16T12:00:00Z');
      expect(isToday(date, now)).toBe(false);
    });

    it('should handle invalid date', () => {
      expect(isToday(null)).toBe(false);
      expect(isToday(new Date('invalid'))).toBe(false);
    });
  });

  describe('isTomorrow', () => {
    it('should return true for tomorrow', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      const date = new Date('2024-01-16T08:00:00Z');
      expect(isTomorrow(date, now)).toBe(true);
    });

    it('should return false for today', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      const date = new Date('2024-01-15T08:00:00Z');
      expect(isTomorrow(date, now)).toBe(false);
    });

    it('should return false for day after tomorrow', () => {
      const now = new Date('2024-01-15T12:00:00Z');
      const date = new Date('2024-01-17T12:00:00Z');
      expect(isTomorrow(date, now)).toBe(false);
    });
  });

  describe('getNextIntervalStart', () => {
    it('should return next future interval', () => {
      const intervals = [
        { startsAt: '2024-01-15T10:00:00Z' },
        { startsAt: '2024-01-15T11:00:00Z' },
        { startsAt: '2024-01-15T12:00:00Z' },
      ];
      const now = new Date('2024-01-15T10:30:00Z');

      const next = getNextIntervalStart(intervals, now);
      expect(next).toEqual(new Date('2024-01-15T11:00:00Z'));
    });

    it('should return null if no future intervals', () => {
      const intervals = [{ startsAt: '2024-01-15T10:00:00Z' }];
      const now = new Date('2024-01-15T11:00:00Z');

      expect(getNextIntervalStart(intervals, now)).toBeNull();
    });

    it('should return null for empty array', () => {
      expect(getNextIntervalStart([])).toBeNull();
    });

    it('should handle unsorted intervals', () => {
      const intervals = [
        { startsAt: '2024-01-15T12:00:00Z' },
        { startsAt: '2024-01-15T10:00:00Z' },
        { startsAt: '2024-01-15T11:00:00Z' },
      ];
      const now = new Date('2024-01-15T10:30:00Z');

      const next = getNextIntervalStart(intervals, now);
      expect(next).toEqual(new Date('2024-01-15T11:00:00Z'));
    });
  });

  describe('intervalMinutesToHours', () => {
    it('should convert 15 minutes to 0.25 hours', () => {
      expect(intervalMinutesToHours(15)).toBe(0.25);
    });

    it('should convert 30 minutes to 0.5 hours', () => {
      expect(intervalMinutesToHours(30)).toBe(0.5);
    });

    it('should convert 60 minutes to 1 hour', () => {
      expect(intervalMinutesToHours(60)).toBe(1);
    });
  });

  describe('intervalsPerDay', () => {
    it('should return 96 for 15-minute intervals', () => {
      expect(intervalsPerDay(15)).toBe(96);
    });

    it('should return 48 for 30-minute intervals', () => {
      expect(intervalsPerDay(30)).toBe(48);
    });

    it('should return 24 for 60-minute intervals', () => {
      expect(intervalsPerDay(60)).toBe(24);
    });
  });

  describe('isSameDay', () => {
    it('should return true for same day', () => {
      const date1 = new Date('2024-01-15T10:00:00Z');
      const date2 = new Date('2024-01-15T18:00:00Z');
      expect(isSameDay(date1, date2)).toBe(true);
    });

    it('should return false for different days', () => {
      const date1 = new Date('2024-01-15T10:00:00Z');
      const date2 = new Date('2024-01-16T10:00:00Z');
      expect(isSameDay(date1, date2)).toBe(false);
    });

    it('should return false for invalid dates', () => {
      expect(isSameDay(null, new Date())).toBe(false);
      expect(isSameDay(new Date(), null)).toBe(false);
      expect(isSameDay(new Date('invalid'), new Date())).toBe(false);
    });
  });
});
