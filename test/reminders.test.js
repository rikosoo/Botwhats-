'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { DAY_MS } = require('../src/core/reminders');

function marcarConsulta(app, phone, nome, emDias) {
  const paciente = app.store.upsertContact(phone, nome);
  const startsAt = new Date(Date.now() + emDias * DAY_MS);
  const booking = app.store.addBooking({
    contactId: paciente.id,
    professionalId: 'dr-exemplo',
    professionalName: 'Dr. Exemplo Silva',
    serviceId: 'primeira-consulta',
    serviceName: 'Primeira consulta',
    date: startsAt.toISOString().slice(0, 10),
    start: '09:00',
    end: '09:40',
    startsAt: startsAt.toISOString(),
  });
  return { paciente, booking };
}

test('follow-up de quem não marcou: 1, 7 e 15 dias', () => {
  const app = makeApp();
  const paciente = app.store.upsertContact('5511911111111', 'Carla Dias');
  const agora = new Date('2026-09-05T12:00:00Z');
  const criados = app.reminders.scheduleFollowUps(paciente, agora);

  assert.deepStrictEqual(criados.map((r) => r.offsetDays), [1, 7, 15]);
  assert.strictEqual(criados[0].dueAt, new Date(agora.getTime() + DAY_MS).toISOString());
  assert.strictEqual(criados[2].dueAt, new Date(agora.getTime() + 15 * DAY_MS).toISOString());
});

test('cada novo contato reinicia o ciclo de follow-up', () => {
  const app = makeApp();
  const paciente = app.store.upsertContact('5511922222222', 'Duda Reis');
  app.reminders.scheduleFollowUps(paciente, new Date('2026-09-01T12:00:00Z'));
  app.reminders.scheduleFollowUps(paciente, new Date('2026-09-03T12:00:00Z'));

  assert.strictEqual(app.store.state.reminders.filter((r) => r.status === 'pending').length, 3);
  assert.strictEqual(app.store.state.reminders.filter((r) => r.status === 'cancelado').length, 3);
});

test('lembretes da consulta pulam as janelas que já passaram', () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511933333333', 'Edu Lima', 8);
  const criados = app.reminders.scheduleBookingReminders(booking);
  assert.deepStrictEqual(criados.map((r) => r.offsetDays), [7, 1]);
});

test('lembrete de véspera manda endereço, preparo e pede confirmação', async () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511944444444', 'Fábio Reis', 1.5);
  app.reminders.scheduleBookingReminders(booking);

  const enviados = await app.reminders.tick(new Date(Date.now() + DAY_MS));
  assert.strictEqual(enviados, 1);
  const texto = app.ultima();
  assert.match(texto, /Rua das Flores/);
  assert.match(texto, /exames anteriores/);
  assert.match(texto, /confirmar/i);
  assert.strictEqual(app.store.getBooking(booking.id).confirmation, 'pedido');
});

test('follow-up não é enviado para quem já marcou nesse meio tempo', async () => {
  const app = makeApp();
  const { paciente } = marcarConsulta(app, '5511955555555', 'Gabi Souza', 5);
  app.reminders.scheduleFollowUps(paciente, new Date(Date.now() - 2 * DAY_MS));

  assert.strictEqual(await app.reminders.tick(), 0);
  assert.strictEqual(app.sent.length, 0);
});

test('quem pediu para sair não recebe mais nada', async () => {
  const app = makeApp();
  const paciente = app.store.upsertContact('5511966666666', 'Hugo Melo');
  app.reminders.scheduleFollowUps(paciente, new Date(Date.now() - 2 * DAY_MS));
  paciente.optOut = true;

  assert.strictEqual(await app.reminders.tick(), 0);
});

test('consulta cancelada não dispara lembrete', async () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511977777777', 'Ivo Prado', 3);
  app.reminders.scheduleBookingReminders(booking);
  app.agenda.cancel(booking.id);

  assert.strictEqual(await app.reminders.tick(new Date(Date.now() + 4 * DAY_MS)), 0);
});

test('quem compareceu recebe lembrete de retorno no prazo do atendimento', async () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511988888888', 'Joana Alves', -1);
  const retorno = app.reminders.scheduleReturnReminder(booking);

  assert.strictEqual(retorno.kind, 'retorno');
  assert.strictEqual(retorno.offsetDays, 30); // returnDays da primeira consulta

  await app.reminders.tick(new Date(Date.now() + 31 * DAY_MS));
  assert.match(app.ultima(), /retorno/i);
});

test('falta gera mensagem de reaproximação no dia seguinte', async () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511999999999', 'Karina Reis', -1);
  app.reminders.scheduleNoShowReminder(booking);

  await app.reminders.tick(new Date(Date.now() + 2 * DAY_MS));
  assert.match(app.ultima(), /Sentimos sua falta/i);
});

test('o texto do follow-up muda conforme a janela', () => {
  const app = makeApp();
  const paciente = app.store.upsertContact('5511900000000', 'Lia Matos');
  const [um, sete, quinze] = app.reminders.scheduleFollowUps(paciente);

  assert.match(app.reminders.textoDe(um), /Ontem você falou/);
  assert.match(app.reminders.textoDe(sete), /uma semana|ainda quer marcar/i);
  assert.match(app.reminders.textoDe(quinze), /último lembrete/i);
});
