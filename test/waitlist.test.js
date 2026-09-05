'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');

const AGENDAR = ['oi', 'quero marcar', 'retorno', 'unimed', '1', '1', '1', 'Marta Bueno', '01/02/1970', 'sim'];

/** Fecha a agenda de todo mundo, para o bot ficar sem horário para oferecer. */
function agendaLotada(app) {
  for (const p of app.store.clinic.professionals) {
    p.weekly = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  }
}

test('sem horário livre, o bot oferece a lista de espera', async () => {
  const app = makeApp();
  agendaLotada(app);
  const phone = '5511900030001';

  await app.conversa(phone, ['oi', 'quero marcar uma consulta', 'retorno', 'particular', 'tanto faz']);
  assert.match(app.ultima(), /lista de espera/i);
  assert.strictEqual(app.store.findContactByPhone(phone).state.step, 'espera_confirma');

  await app.handleIncoming({ phone, body: 'sim' });
  assert.match(app.ultima(), /Anotado/);
  assert.strictEqual(app.store.state.waitlist.length, 1);
  assert.strictEqual(app.store.findContactByPhone(phone).stage, 'na espera');
});

test('entrar duas vezes não duplica o nome na fila', async () => {
  const app = makeApp();
  const phone = '5511900030002';
  await app.conversa(phone, ['oi', 'me avisa se abrir uma vaga', 'quero entrar na lista de espera']);

  assert.strictEqual(app.store.state.waitlist.length, 1);
  assert.match(app.ultima(), /já está na lista/i);
});

test('sair da lista tira o nome', async () => {
  const app = makeApp();
  const phone = '5511900030003';
  await app.conversa(phone, ['oi', 'me avisa quando abrir']);
  await app.handleIncoming({ phone, body: 'pode tirar meu nome da lista' });

  assert.strictEqual(app.store.state.waitlist[0].status, 'removido');
  assert.match(app.ultima(), /tirei seu nome/i);
});

test('cancelamento oferece a vaga para a primeira pessoa da fila', async () => {
  const app = makeApp();
  const marcado = '5511900030010';
  await app.conversa(marcado, AGENDAR);
  const consulta = app.store.state.bookings[0];

  // Duas pessoas esperando, em ordem de chegada.
  const primeiro = '5511900030011';
  const segundo = '5511900030012';
  await app.conversa(primeiro, ['oi', 'me avisa se abrir vaga']);
  await app.conversa(segundo, ['oi', 'quero entrar na lista de espera']);
  app.sent.length = 0;

  app.agenda.cancel(consulta.id, 'teste');
  await app.waitlist.emAndamento;

  assert.strictEqual(app.sent.length, 1, 'oferece para uma pessoa de cada vez');
  assert.strictEqual(app.sent[0].phone, primeiro, 'quem chegou antes ouve primeiro');
  assert.match(app.sent[0].text, /abriu uma vaga/i);

  const entradas = app.store.state.waitlist;
  assert.strictEqual(entradas[0].status, 'oferecido');
  assert.strictEqual(entradas[1].status, 'aguardando');
});

test('aceitar a vaga reserva o horário e fecha a entrada na fila', async () => {
  const app = makeApp();
  const marcado = '5511900030020';
  await app.conversa(marcado, AGENDAR);
  const consulta = app.store.state.bookings[0];

  const esperando = '5511900030021';
  await app.conversa(esperando, ['oi', 'me avisa se abrir vaga']);
  const paciente = app.store.findContactByPhone(esperando);
  paciente.name = 'Nina Costa';
  paciente.birthDate = '03/03/1990';

  app.agenda.cancel(consulta.id, 'teste');
  await app.waitlist.emAndamento;

  await app.handleIncoming({ phone: esperando, body: 'sim' });

  const nova = app.store.bookingsOf(paciente.id).find((b) => b.status === 'confirmado');
  assert.ok(nova, 'consulta criada para quem estava esperando');
  assert.strictEqual(nova.date, consulta.date);
  assert.strictEqual(nova.start, consulta.start);
  assert.strictEqual(app.store.state.waitlist[0].status, 'aceito');
  assert.match(app.textoEnviado(), /Sua consulta está reservada/i);
});

test('recusar passa a vaga para a próxima pessoa e mantém o nome na fila', async () => {
  const app = makeApp();
  const marcado = '5511900030030';
  await app.conversa(marcado, AGENDAR);
  const consulta = app.store.state.bookings[0];

  const primeiro = '5511900030031';
  const segundo = '5511900030032';
  await app.conversa(primeiro, ['oi', 'me avisa se abrir vaga']);
  await app.conversa(segundo, ['oi', 'me avisa se abrir vaga']);

  app.agenda.cancel(consulta.id, 'teste');
  await app.waitlist.emAndamento;
  app.sent.length = 0;

  await app.handleIncoming({ phone: primeiro, body: 'não' });

  const [entradaUm, entradaDois] = app.store.state.waitlist;
  assert.strictEqual(entradaUm.status, 'aguardando', 'continua esperando a próxima vaga');
  assert.strictEqual(entradaDois.status, 'oferecido', 'a vaga seguiu para o segundo');
  assert.ok(app.sent.some((m) => m.phone === segundo && /abriu uma vaga/i.test(m.text)));
});

test('oferta sem resposta expira e a vaga passa adiante', async () => {
  const app = makeApp({ waitlistOfferMinutes: 60 });
  const marcado = '5511900030040';
  await app.conversa(marcado, AGENDAR);
  const consulta = app.store.state.bookings[0];

  const primeiro = '5511900030041';
  const segundo = '5511900030042';
  await app.conversa(primeiro, ['oi', 'me avisa se abrir vaga']);
  await app.conversa(segundo, ['oi', 'me avisa se abrir vaga']);

  app.agenda.cancel(consulta.id, 'teste');
  await app.waitlist.emAndamento;
  app.sent.length = 0;

  await app.waitlist.tick(new Date(Date.now() + 61 * 60000));

  assert.ok(app.sent.some((m) => m.phone === primeiro && /outra pessoa/i.test(m.text)),
    'avisa quem perdeu, para não ficar no vácuo');
  assert.ok(app.sent.some((m) => m.phone === segundo && /abriu uma vaga/i.test(m.text)));
  assert.strictEqual(app.store.state.waitlist[0].status, 'aguardando');
  assert.strictEqual(app.store.state.waitlist[1].status, 'oferecido');
});

test('quem já conseguiu marcar não recebe oferta de vaga', async () => {
  const app = makeApp();
  const marcado = '5511900030050';
  await app.conversa(marcado, AGENDAR);
  const consulta = app.store.state.bookings[0];

  // Entrou na fila e depois conseguiu marcar por conta própria.
  const outro = '5511900030051';
  await app.conversa(outro, ['oi', 'me avisa se abrir vaga']);
  const paciente = app.store.findContactByPhone(outro);
  const dia = app.agenda.nextAvailableDays(1, { professionalId: 'dr-exemplo', serviceId: 'retorno' })[0];
  app.agenda.book(paciente.id, {
    professionalId: 'dr-exemplo', serviceId: 'retorno', date: dia.date, start: dia.slots[0].start,
  });
  app.sent.length = 0;

  app.agenda.cancel(consulta.id, 'teste');
  await app.waitlist.emAndamento;
  assert.strictEqual(app.sent.length, 0);
});

test('opt-out não recebe oferta', async () => {
  const app = makeApp();
  const marcado = '5511900030060';
  await app.conversa(marcado, AGENDAR);
  const consulta = app.store.state.bookings[0];

  const outro = '5511900030061';
  await app.conversa(outro, ['oi', 'me avisa se abrir vaga']);
  app.store.findContactByPhone(outro).optOut = true;
  app.sent.length = 0;

  app.agenda.cancel(consulta.id, 'teste');
  await app.waitlist.emAndamento;
  assert.strictEqual(app.sent.length, 0);
});
