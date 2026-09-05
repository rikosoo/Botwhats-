'use strict';

const WEEKDAY_NAMES = [
  'domingo', 'segunda-feira', 'terca-feira', 'quarta-feira',
  'quinta-feira', 'sexta-feira', 'sabado',
];

/** Deslocamento (ms) do fuso em relacao ao UTC no instante informado. */
function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asUTC - date.getTime();
}

/** Converte data/hora locais do fuso ("2026-09-10", "14:30") para um Date em UTC. */
function zonedToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  ts = guess - tzOffsetMs(new Date(ts), timeZone); // segunda passada cobre viradas de horario de verao
  return new Date(ts);
}

/** Data local no fuso, no formato YYYY-MM-DD. */
function dateKey(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return dtf.format(date);
}

function timeKey(date, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDaysToKey(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

function formatDateBr(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function formatDateLong(dateStr) {
  return `${WEEKDAY_NAMES[weekdayOf(dateStr)]}, ${formatDateBr(dateStr)}`;
}

function toMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(total) {
  const h = String(Math.floor(total / 60)).padStart(2, '0');
  const m = String(total % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/** Faixas de atendimento configuradas para a data (excecao tem prioridade). */
function rangesFor(availability, dateStr) {
  const exception = availability.exceptions ? availability.exceptions[dateStr] : undefined;
  if (Array.isArray(exception)) return exception;
  return availability.weekly[String(weekdayOf(dateStr))] || availability.weekly[weekdayOf(dateStr)] || [];
}

class Agenda {
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }

  get availability() {
    return this.store.state.availability;
  }

  get timezone() {
    return this.config.timezone;
  }

  today() {
    return dateKey(new Date(), this.timezone);
  }

  /** Horarios livres da data: gerados pelas faixas, menos os ja reservados e os que ja passaram. */
  slotsFor(dateStr, { includePast = false, now = new Date() } = {}) {
    const availability = this.availability;
    const step = availability.slotMinutes || 60;
    const taken = new Set(
      this.store.state.bookings
        .filter((b) => b.date === dateStr && b.status === 'confirmado')
        .map((b) => b.start),
    );

    const slots = [];
    for (const range of rangesFor(availability, dateStr)) {
      const end = toMinutes(range.end);
      for (let start = toMinutes(range.start); start + step <= end; start += step) {
        const startStr = fromMinutes(start);
        const startsAt = zonedToUtc(dateStr, startStr, this.timezone);
        if (!includePast && startsAt.getTime() <= now.getTime()) continue;
        if (taken.has(startStr)) continue;
        slots.push({
          date: dateStr,
          start: startStr,
          end: fromMinutes(start + step),
          startsAt: startsAt.toISOString(),
        });
      }
    }
    return slots;
  }

  /** Proximos dias que ainda tenham pelo menos um horario livre. */
  nextAvailableDays(limit = 5, searchDays = 30) {
    const days = [];
    let cursor = this.today();
    for (let i = 0; i < searchDays && days.length < limit; i += 1) {
      const slots = this.slotsFor(cursor);
      if (slots.length) days.push({ date: cursor, slots });
      cursor = addDaysToKey(cursor, 1);
    }
    return days;
  }

  isSlotFree(dateStr, startStr) {
    return this.slotsFor(dateStr, { includePast: true }).some((s) => s.start === startStr)
      && !this.store.state.bookings.some(
        (b) => b.date === dateStr && b.start === startStr && b.status === 'confirmado',
      );
  }

  book(contactId, dateStr, startStr, note = '') {
    if (!this.isSlotFree(dateStr, startStr)) {
      throw new Error('Horario indisponivel');
    }
    const step = this.availability.slotMinutes || 60;
    return this.store.addBooking({
      contactId,
      date: dateStr,
      start: startStr,
      end: fromMinutes(toMinutes(startStr) + step),
      startsAt: zonedToUtc(dateStr, startStr, this.timezone).toISOString(),
      note,
    });
  }

  cancel(bookingId) {
    const booking = this.store.getBooking(bookingId);
    if (!booking || booking.status !== 'confirmado') return null;
    booking.status = 'cancelado';
    booking.cancelledAt = new Date().toISOString();
    this.store.cancelReminders((r) => r.bookingId === bookingId);
    this.store.commit('booking', booking);
    return booking;
  }
}

module.exports = {
  Agenda,
  WEEKDAY_NAMES,
  tzOffsetMs,
  zonedToUtc,
  dateKey,
  timeKey,
  weekdayOf,
  addDaysToKey,
  formatDateBr,
  formatDateLong,
  toMinutes,
  fromMinutes,
  rangesFor,
};
