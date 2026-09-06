'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { exportarPaciente, apagarPaciente, limparMensagensAntigas } = require('../src/core/privacy');
const { indicadores } = require('../src/core/metrics');

const AGENDAR = ['oi', 'quero marcar', 'primeira consulta', 'unimed', '1', '1', '1', 'Maria Souza', '12/05/1980', 'sim'];
const DIA = 86400000;

test('exportar entrega tudo o que o consultório guarda da pessoa', async () => {
  const app = makeApp();
  const phone = '5511900040001';
  await app.conversa(phone, AGENDAR);
  const paciente = app.store.findContactByPhone(phone);

  const dados = exportarPaciente(app.store, paciente.id);
  assert.strictEqual(dados.paciente.nome, 'Maria Souza');
  assert.strictEqual(dados.paciente.telefone, phone);
  assert.strictEqual(dados.paciente.nascimento, '12/05/1980');
  assert.ok(dados.conversas.length > 5, 'traz o histórico da conversa');
  assert.strictEqual(dados.consultas.length, 1);
  assert.ok(dados.lembretes.length > 0);
  assert.ok(dados.conversas.every((c) => ['paciente', 'consultório'].includes(c.de)));
});

test('apagar remove os dados pessoais de todos os cantos', async () => {
  const app = makeApp();
  const phone = '5511900040002';
  await app.conversa(phone, AGENDAR);
  const paciente = app.store.findContactByPhone(phone);
  app.waitlist.adicionar(paciente.id, {});

  const resumo = apagarPaciente(app.store, paciente.id);
  assert.ok(resumo.mensagens > 0);

  assert.strictEqual(app.store.getContact(paciente.id), null);
  assert.strictEqual(app.store.messagesOf(paciente.id).length, 0);
  assert.strictEqual(app.store.state.reminders.filter((r) => r.contactId === paciente.id).length, 0);
  assert.strictEqual(app.store.state.waitlist.filter((e) => e.contactId === paciente.id).length, 0);

  // Nome e telefone não podem sobrar na linha do tempo do painel.
  const vazamento = app.store.state.events.filter(
    (e) => e.text.includes('Maria Souza') || e.text.includes(phone),
  );
  assert.deepStrictEqual(vazamento.map((e) => e.text), []);
});

test('a consulta continua na estatística, sem dono', async () => {
  const app = makeApp();
  const phone = '5511900040003';
  await app.conversa(phone, AGENDAR);
  const paciente = app.store.findContactByPhone(phone);

  // Consulta que já aconteceu, com falta registrada.
  const consulta = app.store.state.bookings[0];
  consulta.startsAt = new Date(Date.now() - 3 * DIA).toISOString();
  consulta.attendance = 'faltou';
  const antes = indicadores(app.store).geral.taxaFalta;

  apagarPaciente(app.store, paciente.id);

  const depois = indicadores(app.store).geral;
  assert.strictEqual(depois.taxaFalta, antes, 'a taxa de falta não muda retroativamente');
  assert.strictEqual(depois.faltaram, 1);
  assert.strictEqual(app.store.state.bookings[0].contactId, null);
  assert.strictEqual(app.store.state.bookings[0].anonimizado, true);
});

test('o nome sai também das listas de disparo', async () => {
  const app = makeApp({ broadcastDelayMs: 0 });
  const phone = '5511900040004';
  await app.conversa(phone, ['oi']);
  const paciente = app.store.findContactByPhone(phone);
  app.broadcast.criar({ contactIds: [paciente.id], texto: 'Oi!' });
  await app.emAndamentoDoDisparo();

  apagarPaciente(app.store, paciente.id);
  const campanha = app.store.state.campaigns[0];
  assert.ok(!campanha.contactIds.includes(paciente.id));
});

test('retenção apaga conversa antiga e preserva cadastro e consultas', async () => {
  const app = makeApp();
  const phone = '5511900040005';
  await app.conversa(phone, AGENDAR);
  const paciente = app.store.findContactByPhone(phone);

  // Envelhece metade das mensagens.
  const mensagens = app.store.messagesOf(paciente.id);
  for (const m of mensagens.slice(0, 4)) {
    m.at = new Date(Date.now() - 400 * DIA).toISOString();
  }

  const removidas = limparMensagensAntigas(app.store, 365);
  assert.strictEqual(removidas, 4);
  assert.ok(app.store.messagesOf(paciente.id).length > 0, 'as recentes ficam');
  assert.ok(app.store.getContact(paciente.id), 'o cadastro continua');
  assert.strictEqual(app.store.bookingsOf(paciente.id).length, 1, 'a consulta continua');
});

test('retenção desligada não apaga nada', async () => {
  const app = makeApp();
  await app.conversa('5511900040006', ['oi']);
  for (const m of app.store.state.messages) m.at = new Date(Date.now() - 900 * DIA).toISOString();

  assert.strictEqual(limparMensagensAntigas(app.store, 0), 0);
  assert.ok(app.store.state.messages.length > 0);
});
