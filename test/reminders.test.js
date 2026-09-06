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
  const { booking } = marcarConsulta(app, '5511933333333', 'Edu Lima', 5);
  const criados = app.reminders.scheduleBookingReminders(booking);

  // Faltando 5 dias cabem os toques de 3 dias e da véspera — o de 7 já passou.
  const antes = criados.filter((r) => r.kind === 'booking');
  assert.deepStrictEqual(antes.map((r) => r.offsetDays), [3, 1]);
});

test('consulta marcada com muita antecedência ganha um toque no meio do silêncio', () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511933333334', 'Nara Dias', 30);
  const criados = app.reminders.scheduleBookingReminders(booking);

  const espera = criados.find((r) => r.kind === 'espera');
  assert.ok(espera, 'toque criado');
  // Silêncio de 23 dias até o lembrete de 7 dias antes: o toque cai na metade.
  const meio = Date.now() + 11.5 * DAY_MS;
  assert.ok(Math.abs(new Date(espera.dueAt).getTime() - meio) < 12 * 3600000, 'cai no meio do silêncio');
});

test('com a régua de 7 e 3 dias, marcação de dez dias não ganha toque extra', () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511933333335', 'Otto Reis', 10);
  const criados = app.reminders.scheduleBookingReminders(booking);
  assert.strictEqual(criados.filter((r) => r.kind === 'espera').length, 0,
    'o lembrete de 7 dias antes já quebra o silêncio');
});

test('o toque do meio da espera oferece utilidade, não cobrança', async () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511933333336', 'Paula Nunes', 30);
  app.reminders.scheduleBookingReminders(booking);

  await app.reminders.tick(new Date(Date.now() + 12 * DAY_MS));
  const texto = app.textoEnviado();
  assert.match(texto, /exames recentes/i);
  assert.match(texto, /adianta o plano de tratamento/i);
  assert.doesNotMatch(texto, /Faltam \d+ dias/i);
});

test('véspera mostra o tempo reservado e abre a porta de saída', async () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511944444444', 'Fábio Reis', 1.5);
  app.reminders.scheduleBookingReminders(booking);

  const enviados = await app.reminders.tick(new Date(Date.now() + DAY_MS));
  assert.strictEqual(enviados, 1);
  const texto = app.ultima();

  assert.match(texto, /reservou 40 minutos só para você/, 'mostra o que foi reservado');
  assert.match(texto, /não conseguir vir/, 'dá permissão para desmarcar');
  assert.match(texto, /oferecer essa vaga para outra pessoa/, 'explica por que avisar ajuda');
  assert.doesNotMatch(texto, /confirma\?/i, 'não é pergunta de sim ou não');
  assert.match(texto, /Rua das Flores/);
  assert.match(texto, /exames anteriores/);
  assert.strictEqual(app.store.getBooking(booking.id).confirmation, 'pedido');
});

test('check-in do dia seguinte só vale para quem compareceu', async () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511944444445', 'Célia Prado', 0.2);
  const checkIn = app.reminders.scheduleCheckIn(booking);
  assert.strictEqual(checkIn.kind, 'pos_consulta');

  // Sem presença registrada, o check-in não sai.
  assert.strictEqual(await app.reminders.tick(new Date(Date.now() + 2 * DAY_MS)), 0);

  const outro = marcarConsulta(app, '5511944444446', 'Diego Melo', 0.2);
  outro.booking.attendance = 'compareceu';
  app.reminders.scheduleCheckIn(outro.booking);
  await app.reminders.tick(new Date(Date.now() + 2 * DAY_MS));

  assert.match(app.ultima(), /depois da consulta de ontem/i);
  assert.match(app.ultima(), /dúvida sobre as orientações/i);
  assert.doesNotMatch(app.ultima(), /sintoma/i, 'não pergunta sobre sintomas');
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

test('a régua antes da consulta é 7 e 3 dias, mais a véspera', () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511933333340', 'Ivo Nunes', 12);
  const criados = app.reminders.scheduleBookingReminders(booking);

  assert.deepStrictEqual(
    criados.filter((r) => r.kind === 'booking').map((r) => r.offsetDays),
    [7, 3, 1],
  );
});

test('nenhum lembrete antes da consulta faz contagem regressiva', async () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511933333341', 'Julia Costa', 9);
  app.reminders.scheduleBookingReminders(booking);

  await app.reminders.tick(new Date(Date.now() + 7 * DAY_MS));
  const texto = app.textoEnviado();
  assert.ok(texto.length > 0, 'algum lembrete saiu');
  assert.doesNotMatch(texto, /Faltam \d+ dias/i);
});

test('véspera pede um sim ou não simples', async () => {
  const app = makeApp();
  const { booking } = marcarConsulta(app, '5511933333342', 'Lino Prado', 1.5);
  app.reminders.scheduleBookingReminders(booking);

  await app.reminders.tick(new Date(Date.now() + DAY_MS));
  assert.match(app.ultima(), /Responda \*sim\* ou \*não\*/);
  assert.match(app.ultima(), /reservou 40 minutos só para você/);
});

test('o bot só fala em agenda enchendo quando ela está mesmo cheia', async () => {
  const app = makeApp();
  const paciente = app.store.upsertContact('5511933333350', 'Vera Nunes');
  app.reminders.scheduleFollowUps(paciente, new Date(Date.now() - 8 * DAY_MS));

  // Agenda vazia: nada de escassez.
  await app.reminders.tick();
  assert.doesNotMatch(app.textoEnviado(), /quase fechando/i);
  assert.match(app.textoEnviado(), /ainda quer marcar|uma semana/i);
});

test('agenda cheia de verdade muda o texto do follow-up', async () => {
  const app = makeApp();
  // Fecha a agenda de todo mundo menos um punhado de horários, e ocupa-os.
  for (const p of app.store.clinic.professionals) {
    p.weekly = { 0: [], 1: [{ start: '09:00', end: '10:00' }], 2: [], 3: [], 4: [], 5: [], 6: [] };
  }
  const ocupante = app.store.upsertContact('5511933333351', 'Ocupante');
  for (const profissional of app.store.clinic.professionals) {
    const dias = app.agenda.nextAvailableDays(7, { professionalId: profissional.id, serviceId: 'retorno' });
    for (const dia of dias) {
      for (const slot of dia.slots) {
        app.agenda.book(ocupante.id, {
          professionalId: profissional.id, serviceId: 'retorno', date: dia.date, start: slot.start,
        });
      }
    }
  }
  assert.ok(app.agenda.ocupacao(7).percentual >= 80, 'a agenda está realmente cheia');

  const paciente = app.store.upsertContact('5511933333352', 'Wanda Lopes');
  app.reminders.scheduleFollowUps(paciente, new Date(Date.now() - 8 * DAY_MS));
  app.sent.length = 0;
  await app.reminders.tick();

  assert.match(app.ultima(), /quase fechando/i);
});
