'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeApp } = require('./helpers');
const { render, sanitizar, CAMPOS } = require('../src/core/templates');
const { DAY_MS } = require('../src/core/reminders');

test('variável desconhecida vira vazio, nunca chave crua', () => {
  const texto = render('Oi {primeiro_nome}, {inexistente} tudo bem?', { primeiro_nome: 'Ana' });
  assert.strictEqual(texto, 'Oi Ana,  tudo bem?');
  assert.doesNotMatch(texto, /\{/);
});

test('só campos conhecidos e com conteúdo são guardados', () => {
  const limpo = sanitizar({ saudacao: '  Olá!  ', privacidade: '   ', invadido: 'x' });
  assert.deepStrictEqual(limpo, { saudacao: 'Olá!' });
});

test('saudação personalizada substitui a padrão', async () => {
  const app = makeApp();
  app.store.clinic.messages = {
    saudacao: '{saudacao}, {primeiro_nome}! Aqui é o {consultorio}. Como posso ajudar?',
  };

  await app.handleIncoming({ phone: '5511900050001', name: 'Ana Lima', body: 'oi' });
  const texto = app.sent[0].text;

  assert.match(texto, /^(Bom dia|Boa tarde|Boa noite), Ana! Aqui é o Consultorio Dr\. Exemplo\./);
  assert.doesNotMatch(texto, /assistente virtual/);
});

test('apagar o texto volta para o padrão', async () => {
  const app = makeApp();
  app.store.clinic.messages = { saudacao: '   ' };
  await app.handleIncoming({ phone: '5511900050002', body: 'oi' });
  assert.match(app.sent[0].text, /assistente do Consultorio Dr\. Exemplo/);
});

test('lembrete da véspera personalizado usa os dados da consulta', async () => {
  const app = makeApp();
  app.store.clinic.messages = {
    lembreteVespera: '{primeiro_nome}, amanhã às {hora} com {medico} ({duracao} min). Confirma?',
  };

  const paciente = app.store.upsertContact('5511900050003', 'Bruno Reis');
  const startsAt = new Date(Date.now() + 1.5 * DAY_MS);
  const booking = app.store.addBooking({
    contactId: paciente.id,
    professionalId: 'dr-exemplo',
    professionalName: 'Dr. Exemplo Silva',
    serviceId: 'primeira-consulta',
    serviceName: 'Primeira consulta',
    date: startsAt.toISOString().slice(0, 10),
    start: '14:00',
    end: '14:40',
    startsAt: startsAt.toISOString(),
  });
  app.reminders.scheduleBookingReminders(booking);
  await app.reminders.tick(new Date(Date.now() + DAY_MS));

  assert.strictEqual(app.ultima(), 'Bruno, amanhã às 14:00 com Dr. Exemplo Silva (40 min). Confirma?');
});

test('cada follow-up tem o próprio campo', async () => {
  const app = makeApp();
  app.store.clinic.messages = {
    followup1: 'Texto de um dia para {primeiro_nome}',
    followup7: 'Texto de sete dias',
  };
  const paciente = app.store.upsertContact('5511900050004', 'Célia Mota');
  const [um, sete, quinze] = app.reminders.scheduleFollowUps(paciente);

  assert.strictEqual(app.reminders.textoDe(um), 'Texto de um dia para Célia');
  assert.strictEqual(app.reminders.textoDe(sete), 'Texto de sete dias');
  assert.match(app.reminders.textoDe(quinze), /último lembrete/i, 'o que não foi editado segue o padrão');
});

test('todo campo declarado no painel existe de verdade nas mensagens', () => {
  const app = makeApp();
  const M = require('../src/core/messages');
  const clinic = app.store.clinic;
  const contato = app.store.upsertContact('5511900050005', 'Dora Prado');

  // Cada campo recebe um texto único e precisa aparecer em alguma saída do bot.
  for (const campo of CAMPOS) {
    clinic.messages = { [campo.id]: `MARCA-${campo.id}` };
    const saidas = [
      M.saudacao(clinic, contato, 10, true),
      M.avisoPrivacidade(clinic),
      M.semHorarios(clinic, contato),
      M.atendente(clinic, true, contato),
      M.lembreteFollowUp(clinic, contato, 1),
      M.lembreteFollowUp(clinic, contato, 7),
      M.lembreteFollowUp(clinic, contato, 15),
      M.checkInPosConsulta(clinic, contato),
      M.agendamentoConfirmado(clinic, contato,
        { date: '2026-09-10', start: '09:00', end: '09:40', professionalName: 'Dr. X', serviceName: 'Retorno' },
        { durationMin: 20, prep: '' }),
      M.lembreteConsulta(clinic, contato,
        { date: '2026-09-10', start: '09:00', professionalName: 'Dr. X' }, 1, { durationMin: 20 }),
      M.lembreteEspera(clinic, contato,
        { date: '2026-09-10', start: '09:00', professionalName: 'Dr. X' }, { durationMin: 20 }),
    ].join('\n');

    assert.ok(saidas.includes(`MARCA-${campo.id}`), `o campo "${campo.id}" não chega a lugar nenhum`);
  }
});
