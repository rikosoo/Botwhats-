'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { DAY_MS } = require('../src/core/reminders');

test('agenda lembretes de follow-up em 1, 7 e 15 dias', () => {
  const app = makeApp();
  const contato = app.store.upsertContact('5511911111111', 'Carla');
  const agora = new Date('2026-09-05T12:00:00Z');
  const criados = app.reminders.scheduleFollowUps(contato, agora);

  assert.deepStrictEqual(criados.map((r) => r.offsetDays), [1, 7, 15]);
  assert.strictEqual(criados[0].dueAt, new Date(agora.getTime() + DAY_MS).toISOString());
  assert.strictEqual(criados[2].dueAt, new Date(agora.getTime() + 15 * DAY_MS).toISOString());
});

test('novo contato substitui os lembretes anteriores', () => {
  const app = makeApp();
  const contato = app.store.upsertContact('5511922222222', 'Duda');
  app.reminders.scheduleFollowUps(contato, new Date('2026-09-01T12:00:00Z'));
  app.reminders.scheduleFollowUps(contato, new Date('2026-09-03T12:00:00Z'));

  const pendentes = app.store.state.reminders.filter((r) => r.status === 'pending');
  const cancelados = app.store.state.reminders.filter((r) => r.status === 'cancelado');
  assert.strictEqual(pendentes.length, 3);
  assert.strictEqual(cancelados.length, 3);
});

test('lembretes do agendamento ignoram janelas ja passadas', () => {
  const app = makeApp();
  const contato = app.store.upsertContact('5511933333333', 'Edu');
  const startsAt = new Date('2026-09-10T13:00:00Z');
  const booking = app.store.addBooking({
    contactId: contato.id, date: '2026-09-10', start: '10:00', end: '11:00',
    startsAt: startsAt.toISOString(),
  });

  // Faltando 8 dias: cabem os lembretes de 7 e 1 dia, mas nao o de 15.
  const criados = app.reminders.scheduleBookingReminders(booking, new Date('2026-09-02T13:00:00Z'));
  assert.deepStrictEqual(criados.map((r) => r.offsetDays), [7, 1]);
});

test('tick envia o lembrete vencido e marca como enviado', async () => {
  const app = makeApp();
  const contato = app.store.upsertContact('5511944444444', 'Fabio');
  app.reminders.scheduleFollowUps(contato, new Date(Date.now() - 2 * DAY_MS));

  const enviados = await app.reminders.tick();
  assert.strictEqual(enviados, 1);
  assert.match(app.sent[0].text, /Ontem voce falou/);
  assert.strictEqual(app.sent[0].phone, '5511944444444');
  assert.strictEqual(app.store.state.reminders.filter((r) => r.status === 'enviado').length, 1);
});

test('nao envia lembrete para quem pediu para sair', async () => {
  const app = makeApp();
  const contato = app.store.upsertContact('5511955555555', 'Gabi');
  app.reminders.scheduleFollowUps(contato, new Date(Date.now() - 2 * DAY_MS));
  contato.optOut = true;

  assert.strictEqual(await app.reminders.tick(), 0);
  assert.strictEqual(app.sent.length, 0);
});

test('lembrete de agendamento cancelado nao e enviado', async () => {
  const app = makeApp();
  const contato = app.store.upsertContact('5511966666666', 'Hugo');
  const booking = app.store.addBooking({
    contactId: contato.id, date: '2026-09-10', start: '10:00', end: '11:00',
    startsAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
  });
  app.reminders.scheduleBookingReminders(booking);
  app.agenda.cancel(booking.id);

  assert.strictEqual(await app.reminders.tick(new Date(Date.now() + 4 * DAY_MS)), 0);
});
