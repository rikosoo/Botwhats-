'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { zonedToUtc, addDaysToKey, weekdayOf, formatDateBr } = require('../src/core/agenda');

test('converte horario local do fuso para UTC', () => {
  // 2026-01-15 09:00 em Sao Paulo (UTC-3) = 12:00 UTC
  assert.strictEqual(zonedToUtc('2026-01-15', '09:00', 'America/Sao_Paulo').toISOString(), '2026-01-15T12:00:00.000Z');
});

test('helpers de data', () => {
  assert.strictEqual(addDaysToKey('2026-01-31', 1), '2026-02-01');
  assert.strictEqual(weekdayOf('2026-09-07'), 1); // segunda
  assert.strictEqual(formatDateBr('2026-09-07'), '07/09/2026');
});

test('gera horarios apenas nos dias com atendimento', () => {
  const { agenda } = makeApp();
  const segunda = '2026-09-07';
  const domingo = '2026-09-06';
  assert.ok(agenda.slotsFor(segunda, { includePast: true }).length > 0);
  assert.strictEqual(agenda.slotsFor(domingo, { includePast: true }).length, 0);
});

test('horario reservado sai da lista de livres', () => {
  const app = makeApp();
  const contato = app.store.upsertContact('5511900000001', 'Ana');
  const dia = app.agenda.nextAvailableDays(1)[0];
  const horario = dia.slots[0].start;

  app.agenda.book(contato.id, dia.date, horario);
  const livres = app.agenda.slotsFor(dia.date).map((s) => s.start);
  assert.ok(!livres.includes(horario));
  assert.throws(() => app.agenda.book(contato.id, dia.date, horario), /indisponivel/i);
});

test('cancelamento libera o horario de volta', () => {
  const app = makeApp();
  const contato = app.store.upsertContact('5511900000002', 'Bia');
  const dia = app.agenda.nextAvailableDays(1)[0];
  const horario = dia.slots[0].start;

  const booking = app.agenda.book(contato.id, dia.date, horario);
  app.agenda.cancel(booking.id);
  assert.ok(app.agenda.slotsFor(dia.date).map((s) => s.start).includes(horario));
});

test('excecao de data fecha a agenda do dia', () => {
  const app = makeApp();
  const dia = app.agenda.nextAvailableDays(1)[0].date;
  app.store.state.availability.exceptions[dia] = [];
  assert.strictEqual(app.agenda.slotsFor(dia).length, 0);
});
