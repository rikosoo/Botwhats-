'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { zonedToUtc, addDaysToKey, weekdayOf, formatDateBr } = require('../src/core/agenda');

test('converte horário local do fuso para UTC', () => {
  assert.strictEqual(
    zonedToUtc('2026-01-15', '09:00', 'America/Sao_Paulo').toISOString(),
    '2026-01-15T12:00:00.000Z',
  );
});

test('helpers de data', () => {
  assert.strictEqual(addDaysToKey('2026-01-31', 1), '2026-02-01');
  assert.strictEqual(weekdayOf('2026-09-07'), 1);
  assert.strictEqual(formatDateBr('2026-09-07'), '07/09/2026');
});

test('cada profissional tem a própria agenda', () => {
  const { agenda } = makeApp();
  const terca = '2026-09-08';
  const dr = agenda.slotsFor(terca, { professionalId: 'dr-exemplo', serviceId: 'retorno', includePast: true });
  const dra = agenda.slotsFor(terca, { professionalId: 'dra-exemplo', serviceId: 'retorno', includePast: true });
  assert.ok(dr.length > 0, 'Dr. atende na terça');
  assert.strictEqual(dra.length, 0, 'Dra. não atende na terça');
});

test('a duração do tipo de atendimento define a grade de horários', () => {
  const { agenda } = makeApp();
  const dia = '2026-09-07';
  const primeira = agenda.slotsFor(dia, { professionalId: 'dr-exemplo', serviceId: 'primeira-consulta', includePast: true });
  const retorno = agenda.slotsFor(dia, { professionalId: 'dr-exemplo', serviceId: 'retorno', includePast: true });

  assert.deepStrictEqual(primeira.slice(0, 3).map((s) => s.start), ['08:00', '08:40', '09:20']);
  assert.deepStrictEqual(retorno.slice(0, 3).map((s) => s.start), ['08:00', '08:20', '08:40']);
  assert.strictEqual(primeira[0].end, '08:40');
});

test('consulta marcada bloqueia todo o intervalo, não só o início', () => {
  const app = makeApp();
  const paciente = app.store.upsertContact('5511900000001', 'Ana Lima');
  const dia = app.agenda.nextAvailableDays(1, { professionalId: 'dr-exemplo', serviceId: 'primeira-consulta' })[0];

  app.agenda.book(paciente.id, {
    professionalId: 'dr-exemplo', serviceId: 'primeira-consulta', date: dia.date, start: dia.slots[0].start,
  });

  // A consulta de 40 min ocupa dois espaços da grade de 20 min do retorno.
  const livres = app.agenda
    .slotsFor(dia.date, { professionalId: 'dr-exemplo', serviceId: 'retorno' })
    .map((s) => s.start);
  const inicio = dia.slots[0].start;
  assert.ok(!livres.includes(inicio));
  assert.throws(() => app.agenda.book(paciente.id, {
    professionalId: 'dr-exemplo', serviceId: 'retorno', date: dia.date, start: inicio,
  }), /indisponivel/i);
});

test('cancelar devolve o horário para a agenda', () => {
  const app = makeApp();
  const paciente = app.store.upsertContact('5511900000002', 'Bia Nunes');
  const dia = app.agenda.nextAvailableDays(1, { professionalId: 'dr-exemplo', serviceId: 'retorno' })[0];
  const horario = dia.slots[0].start;

  const consulta = app.agenda.book(paciente.id, {
    professionalId: 'dr-exemplo', serviceId: 'retorno', date: dia.date, start: horario,
  });
  app.agenda.cancel(consulta.id);
  const livres = app.agenda.slotsFor(dia.date, { professionalId: 'dr-exemplo', serviceId: 'retorno' });
  assert.ok(livres.map((s) => s.start).includes(horario));
});

test('exceção de data fecha a agenda do dia (feriado)', () => {
  const app = makeApp();
  const dia = app.agenda.nextAvailableDays(1, { professionalId: 'dr-exemplo' })[0].date;
  app.store.clinic.professionals[0].exceptions[dia] = [];
  assert.strictEqual(app.agenda.slotsFor(dia, { professionalId: 'dr-exemplo' }).length, 0);
});

test('agenda do dia lista as consultas por profissional', () => {
  const app = makeApp();
  const paciente = app.store.upsertContact('5511900000003', 'Caio Reis');
  const dia = app.agenda.nextAvailableDays(1, { professionalId: 'dr-exemplo', serviceId: 'retorno' })[0];
  app.agenda.book(paciente.id, {
    professionalId: 'dr-exemplo', serviceId: 'retorno', date: dia.date, start: dia.slots[0].start,
  });

  const visao = app.agenda.dayView(dia.date);
  const doDr = visao.find((v) => v.professional.id === 'dr-exemplo');
  assert.strictEqual(doDr.bookings.length, 1);
  assert.strictEqual(doDr.bookings[0].contactId, paciente.id);
});
