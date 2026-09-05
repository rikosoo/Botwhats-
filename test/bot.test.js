'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');

const texto = (app) => app.sent.map((s) => s.text).join('\n');

test('responde com saudacao e menu na primeira mensagem', async () => {
  const app = makeApp();
  await app.handleIncoming({ phone: '5511900001111', name: 'Ana', body: 'oi' });

  assert.match(texto(app), /(Bom dia|Boa tarde|Boa noite), Ana!/);
  assert.match(texto(app), /Agendar um horario/);
  assert.strictEqual(app.store.state.messages.filter((m) => m.direction === 'in').length, 1);
});

test('primeiro contato ja programa os lembretes de 1\/7\/15 dias', async () => {
  const app = makeApp();
  await app.handleIncoming({ phone: '5511900002222', body: 'ola' });

  const pendentes = app.store.state.reminders.filter((r) => r.status === 'pending');
  assert.deepStrictEqual(pendentes.map((r) => r.offsetDays), [1, 7, 15]);
});

test('fluxo completo de agendamento pelo menu', async () => {
  const app = makeApp();
  const phone = '5511900003333';
  await app.handleIncoming({ phone, name: 'Bruno', body: 'oi' });
  await app.handleIncoming({ phone, body: '1' });      // agendar
  await app.handleIncoming({ phone, body: '1' });      // primeiro dia
  await app.handleIncoming({ phone, body: '1' });      // primeiro horario
  await app.handleIncoming({ phone, body: 'sim' });    // confirmar

  const booking = app.store.state.bookings[0];
  assert.ok(booking, 'agendamento criado');
  assert.strictEqual(booking.status, 'confirmado');
  assert.match(texto(app), /Agendamento confirmado/);

  const contato = app.store.findContactByPhone(phone);
  assert.strictEqual(contato.stage, 'agendado');

  // Follow-ups viram lembretes do agendamento.
  const pendentes = app.store.state.reminders.filter((r) => r.status === 'pending');
  assert.ok(pendentes.length > 0);
  assert.ok(pendentes.every((r) => r.kind === 'booking'));
});

test('pede o nome quando o contato ainda nao tem cadastro', async () => {
  const app = makeApp();
  const phone = '5511900004444';
  await app.handleIncoming({ phone, body: 'oi' });
  await app.handleIncoming({ phone, body: 'agendar' });
  await app.handleIncoming({ phone, body: '1' });
  await app.handleIncoming({ phone, body: '1' });
  assert.match(texto(app), /Como voce se chama/);

  await app.handleIncoming({ phone, body: 'Carla Souza' });
  await app.handleIncoming({ phone, body: 'sim' });
  assert.strictEqual(app.store.findContactByPhone(phone).name, 'Carla Souza');
  assert.strictEqual(app.store.state.bookings.length, 1);
});

test('cancelar libera o horario e volta os follow-ups', async () => {
  const app = makeApp();
  const phone = '5511900005555';
  await app.handleIncoming({ phone, name: 'Duda', body: 'oi' });
  await app.handleIncoming({ phone, body: '1' });
  await app.handleIncoming({ phone, body: '1' });
  await app.handleIncoming({ phone, body: '1' });
  await app.handleIncoming({ phone, body: 'sim' });
  await app.handleIncoming({ phone, body: 'cancelar' });

  assert.strictEqual(app.store.state.bookings[0].status, 'cancelado');
  const pendentes = app.store.state.reminders.filter((r) => r.status === 'pending');
  assert.deepStrictEqual(pendentes.map((r) => r.offsetDays), [1, 7, 15]);
});

test('SAIR cancela os lembretes e marca opt-out', async () => {
  const app = makeApp();
  const phone = '5511900006666';
  await app.handleIncoming({ phone, body: 'oi' });
  await app.handleIncoming({ phone, body: 'sair' });

  const contato = app.store.findContactByPhone(phone);
  assert.strictEqual(contato.optOut, true);
  assert.strictEqual(app.store.state.reminders.filter((r) => r.status === 'pending').length, 0);
  assert.match(texto(app), /nao vou mais enviar lembretes/);
});

test('opcao 4 transfere para atendente e o bot silencia', async () => {
  const app = makeApp();
  const phone = '5511900007777';
  await app.handleIncoming({ phone, body: 'oi' });
  await app.handleIncoming({ phone, body: '4' });
  const antes = app.sent.length;
  await app.handleIncoming({ phone, body: 'obrigado' });

  assert.strictEqual(app.sent.length, antes, 'bot nao responde apos handoff');
  assert.strictEqual(app.store.findContactByPhone(phone).stage, 'atendimento humano');
});

test('opcao invalida repete o menu', async () => {
  const app = makeApp();
  const phone = '5511900008888';
  await app.handleIncoming({ phone, body: 'oi' });
  await app.handleIncoming({ phone, body: 'blablabla' });
  assert.match(app.sent.slice(-1)[0].text, /Nao entendi essa opcao/);
});
