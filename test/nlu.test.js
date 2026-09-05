'use strict';

const test = require('node:test');
const assert = require('node:assert');
const nlu = require('../src/core/nlu');
const triage = require('../src/core/triage');

test('reconhece a intenção em linguagem de paciente', () => {
  const casos = [
    ['Oi, bom dia!', 'saudacao'],
    ['queria marcar uma consulta', 'agendar'],
    ['preciso passar em consulta', 'agendar'],
    ['vocês atendem unimed?', 'convenios'],
    ['quanto custa a consulta particular?', 'valores'],
    ['onde fica o consultório?', 'endereco'],
    ['preciso remarcar meu horário', 'remarcar'],
    ['não vou poder ir amanhã', 'cancelar'],
    ['quero falar com uma pessoa', 'atendente'],
    ['não quero mais receber mensagens', 'sair'],
    ['preciso de jejum?', 'preparo'],
    ['quando é a minha consulta?', 'minhas_consultas'],
  ];
  for (const [texto, esperado] of casos) {
    assert.strictEqual(nlu.detectarIntencao(texto), esperado, `"${texto}"`);
  }
});

test('lê escolhas por número, ordinal e extenso', () => {
  assert.strictEqual(nlu.lerNumero('2', 5), 2);
  assert.strictEqual(nlu.lerNumero('pode ser o segundo', 5), 2);
  assert.strictEqual(nlu.lerNumero('quero o três', 5), 3);
  assert.strictEqual(nlu.lerNumero('9', 5), null, 'ignora fora da lista');
});

test('lê horário e trata ambiguidade', () => {
  const opcoes = ['08:00', '08:20', '09:00'];
  assert.strictEqual(nlu.lerHorario('às 9h', opcoes), '09:00');
  assert.strictEqual(nlu.lerHorario('8h20', opcoes), '08:20');
  assert.strictEqual(nlu.lerHorario('8h', opcoes), null, 'ambíguo não decide sozinho');
  assert.deepStrictEqual(nlu.lerHorarioCandidatos('8h', opcoes), ['08:00', '08:20']);
});

test('lê data de nascimento em formatos comuns', () => {
  assert.strictEqual(nlu.lerDataNascimento('12/05/1980'), '12/05/1980');
  assert.strictEqual(nlu.lerDataNascimento('nasci em 3-4-1975'), '03/04/1975');
  assert.strictEqual(nlu.lerDataNascimento('45/13/1980'), null);
});

test('triagem separa emergência, atenção e conversa normal', () => {
  assert.strictEqual(triage.avaliar('estou com dor no peito').nivel, 'emergencia');
  assert.strictEqual(triage.avaliar('não consigo respirar direito').nivel, 'emergencia');
  assert.strictEqual(triage.avaliar('estou passando mal desde ontem').nivel, 'atencao');
  assert.strictEqual(triage.avaliar('quero marcar uma consulta').nivel, 'nenhum');
});
