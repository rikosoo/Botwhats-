'use strict';

/**
 * Popula o painel com um dia típico de consultório, para ver o
 * autoatendimento funcionando. Uso: npm run seed
 */

const config = require('../src/config');
const { createApp } = require('../src/app');

const ROTEIROS = [
  {
    phone: '5511988880001',
    nome: 'Ana Ribeiro',
    mensagens: ['Oi, bom dia!', 'gostaria de marcar uma consulta', 'é a primeira vez',
      'unimed', '1', '1', '1', 'Ana Ribeiro Costa', '14/03/1985', 'sim'],
  },
  {
    phone: '5511988880002',
    nome: 'Bruno Alves',
    mensagens: ['boa tarde', 'vocês atendem qual convênio?', 'e quanto custa particular?'],
  },
  {
    phone: '5511988880003',
    nome: 'Carla Dias',
    mensagens: ['oi', 'preciso de um retorno', 'particular', 'tanto faz', '1', '2',
      'Carla Dias Moreira', '02/11/1978', 'sim', 'confirmo'],
  },
  {
    phone: '5511988880004',
    nome: null,
    mensagens: ['Bom dia', 'estou com dor no peito e falta de ar'],
  },
  {
    phone: '5511988880005',
    nome: 'Eduardo Lima',
    mensagens: ['oi', 'onde fica o consultório?', 'preciso de jejum para o exame?',
      'quero falar com a secretária'],
  },
];

async function main() {
  const app = createApp({ ...config, channel: 'mock', typingDelayMs: 0 });
  for (const roteiro of ROTEIROS) {
    for (const body of roteiro.mensagens) {
      await app.handleIncoming({ phone: roteiro.phone, name: roteiro.nome, body });
    }
  }
  app.store.saveNow();

  const s = app.store.state;
  console.log(`Painel populado: ${s.contacts.length} pacientes, `
    + `${s.bookings.filter((b) => b.status === 'confirmado').length} consultas, `
    + `${s.reminders.filter((r) => r.status === 'pending').length} lembretes programados, `
    + `${s.events.filter((e) => e.type === 'urgencia').length} urgência(s).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
