'use strict';

/**
 * Time and scheduling logic - pure functions for interval calculations
 * This module handles time-based operations like interval matching,
 * schedule grouping, and date/time utilities without any I/O dependencies.
 */

/**
 * Get interval of day (0-95 for 15-minute intervals)
 * @param {Date} date - Date to get interval for
 * @param {number} intervalMinutes - Interval duration in minutes (default 15)
 * @returns {number} Interval index (0-based)
 */
function getIntervalOfDay(date, intervalMinutes = 15) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return -1;
  }

  const minutesSinceMidnight = date.getHours() * 60 + date.getMinutes();
  return Math.floor(minutesSinceMidnight / intervalMinutes);
}

/**
 * Find price for a specific timestamp in the price cache
 * @param {Date} timestamp - Timestamp to find price for
 * @param {Array} priceCache - Array of price intervals
 * @param {number} intervalMinutes - Interval duration in minutes (default 15)
 * @returns {number|null} Price at the timestamp or null if not found
 */
function getPriceAtTime(timestamp, priceCache, intervalMinutes = 15) {
  if (!(timestamp instanceof Date) || !priceCache || !Array.isArray(priceCache) || priceCache.length === 0) {
    return null;
  }

  const targetTime = new Date(timestamp);
  const targetMinutes = targetTime.getHours() * 60 + targetTime.getMinutes();
  const targetInterval = Math.floor(targetMinutes / intervalMinutes);

  for (const priceEntry of priceCache) {
    const entryTime = new Date(priceEntry.startsAt);
    const entryMinutes = entryTime.getHours() * 60 + entryTime.getMinutes();
    const entryInterval = Math.floor(entryMinutes / intervalMinutes);

    if (entryTime.getDate() === targetTime.getDate()
        && entryTime.getMonth() === targetTime.getMonth()
        && entryTime.getYear() === targetTime.getYear()
        && entryInterval === targetInterval) {
      return priceEntry.total;
    }
  }

  return null;
}

/**
 * Filter price data to include only future intervals
 * @param {Array} priceData - Array of price intervals
 * @param {Date} now - Current timestamp (default: new Date())
 * @returns {Array} Filtered price data with only future intervals
 */
function filterFutureIntervals(priceData, now = new Date()) {
  if (!priceData || !Array.isArray(priceData)) {
    return [];
  }

  return priceData.filter((p) => {
    const start = new Date(p.startsAt);
    return start >= now;
  });
}

/**
 * Filter price cache to include current and future intervals
 * Current = started but not yet ended
 * @param {Array} priceData - Array of price intervals
 * @param {Date} now - Current timestamp (default: new Date())
 * @param {number} intervalMinutes - Interval duration in minutes (default 15)
 * @returns {Array} Filtered and sorted price data
 */
function filterCurrentAndFutureIntervals(priceData, now = new Date(), intervalMinutes = 15) {
  if (!priceData || !Array.isArray(priceData)) {
    return [];
  }

  // Include current interval by going back one interval duration
  const bufferTime = new Date(now.getTime() - intervalMinutes * 60 * 1000);

  return priceData
    .filter((p) => new Date(p.startsAt) >= bufferTime)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
}

/**
 * Add index and intervalOfDay to price data
 * @param {Array} priceData - Array of price intervals
 * @param {number} intervalMinutes - Interval duration in minutes (default 15)
 * @returns {Array} Price data with added index and intervalOfDay
 */
function enrichPriceData(priceData, intervalMinutes = 15) {
  if (!priceData || !Array.isArray(priceData)) {
    return [];
  }

  return priceData.map((p, index) => ({
    ...p,
    index,
    intervalOfDay: getIntervalOfDay(new Date(p.startsAt), intervalMinutes),
  }));
}

/**
 * Group consecutive intervals into time blocks
 * @param {Array} intervals - Array of interval objects with { index, startsAt }
 * @param {number} maxGapMinutes - Maximum gap between intervals to still consider them consecutive
 * @returns {Array} Array of blocks, each with { start, end, intervals, duration }
 */
function groupConsecutiveIntervals(intervals, maxGapMinutes = 15) {
  if (!intervals || !Array.isArray(intervals) || intervals.length === 0) {
    return [];
  }

  const blocks = [];
  let currentBlock = {
    start: new Date(intervals[0].startsAt),
    end: null,
    intervals: [intervals[0]],
    duration: maxGapMinutes,
  };

  for (let i = 1; i < intervals.length; i++) {
    const prevStart = new Date(intervals[i - 1].startsAt);
    const currentStart = new Date(intervals[i].startsAt);
    const gapMinutes = (currentStart - prevStart) / (60 * 1000);

    if (gapMinutes <= maxGapMinutes * 1.5) {
      // Consecutive or close enough
      currentBlock.intervals.push(intervals[i]);
      currentBlock.duration += maxGapMinutes;
    } else {
      // Gap detected, finish current block and start new one
      currentBlock.end = new Date(prevStart.getTime() + maxGapMinutes * 60 * 1000);
      blocks.push(currentBlock);

      currentBlock = {
        start: currentStart,
        end: null,
        intervals: [intervals[i]],
        duration: maxGapMinutes,
      };
    }
  }

  // Finish the last block
  const lastInterval = intervals[intervals.length - 1];
  currentBlock.end = new Date(new Date(lastInterval.startsAt).getTime() + maxGapMinutes * 60 * 1000);
  blocks.push(currentBlock);

  return blocks;
}

/**
 * Format time for display (HH:MM)
 * @param {Date} date - Date to format
 * @returns {string} Formatted time string
 */
function formatTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'Invalid Date';
  }

  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Format date and time for display (YYYY-MM-DD HH:MM)
 * @param {Date} date - Date to format
 * @returns {string} Formatted date-time string
 */
function formatDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'Invalid Date';
  }

  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const time = formatTime(date);

  return `${year}-${month}-${day} ${time}`;
}

/**
 * Check if a date is today
 * @param {Date} date - Date to check
 * @param {Date} now - Reference date (default: new Date())
 * @returns {boolean} True if date is today
 */
function isToday(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return false;
  }

  return date.getDate() === now.getDate()
    && date.getMonth() === now.getMonth()
    && date.getFullYear() === now.getFullYear();
}

/**
 * Check if a date is tomorrow
 * @param {Date} date - Date to check
 * @param {Date} now - Reference date (default: new Date())
 * @returns {boolean} True if date is tomorrow
 */
function isTomorrow(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return false;
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return date.getDate() === tomorrow.getDate()
    && date.getMonth() === tomorrow.getMonth()
    && date.getFullYear() === tomorrow.getFullYear();
}

/**
 * Get the next scheduled interval start time
 * @param {Array} intervals - Array of interval objects with { startsAt }
 * @param {Date} now - Current timestamp (default: new Date())
 * @returns {Date|null} Next start time or null if no future intervals
 */
function getNextIntervalStart(intervals, now = new Date()) {
  if (!intervals || !Array.isArray(intervals) || intervals.length === 0) {
    return null;
  }

  const futureIntervals = intervals.filter((interval) => {
    const start = new Date(interval.startsAt);
    return start > now;
  });

  if (futureIntervals.length === 0) {
    return null;
  }

  // Sort by start time and return the first one
  futureIntervals.sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  return new Date(futureIntervals[0].startsAt);
}

/**
 * Calculate interval duration in hours
 * @param {number} intervalMinutes - Interval duration in minutes
 * @returns {number} Duration in hours
 */
function intervalMinutesToHours(intervalMinutes) {
  return intervalMinutes / 60;
}

/**
 * Calculate number of intervals per day
 * @param {number} intervalMinutes - Interval duration in minutes (default 15)
 * @returns {number} Number of intervals in 24 hours
 */
function intervalsPerDay(intervalMinutes = 15) {
  return Math.floor((24 * 60) / intervalMinutes);
}

/**
 * Check if two dates are on the same day
 * @param {Date} date1 - First date
 * @param {Date} date2 - Second date
 * @returns {boolean} True if dates are on the same day
 */
function isSameDay(date1, date2) {
  if (!(date1 instanceof Date) || Number.isNaN(date1.getTime())
      || !(date2 instanceof Date) || Number.isNaN(date2.getTime())) {
    return false;
  }

  return date1.getDate() === date2.getDate()
    && date1.getMonth() === date2.getMonth()
    && date1.getFullYear() === date2.getFullYear();
}

module.exports = {
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
};
