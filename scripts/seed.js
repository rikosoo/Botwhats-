'use strict';

/**
 * Popula o banco com conversas de exemplo para ver o painel funcionando.
 * Uso: npm run seed
 */

const config = require('../src/config');
const { createApp } = require('../src/app');

const roteiros = [
  { phone: '5511988880001', name: 'Ana Ribeiro', mensagens: ['Oi, bom dia!', '1', '1', '1', 'sim'] },
  { phone: '5511988880002', name: 'Bruno Alves', mensagens: ['ola', '3'] },
  { phone: '5511988880003', name: 'Carla Dias', mensagens: ['oi', '1', '1', '2', 'sim'] },
  { phone: '5511988880004', name: null, mensagens: ['Bom dia, gostaria de informacoes', '4'] },
];

async function main() {
  const app = createApp({ ...config, channel: 'mock' });
  for (const roteiro of roteiros) {
    for (const body of roteiro.mensagens) {
      await app.handleIncoming({ phone: roteiro.phone, name: roteiro.name, body });
    }
  }
  app.store.saveNow();
  console.log(`Banco populado: ${app.store.state.contacts.length} contatos, `
    + `${app.store.state.bookings.length} agendamentos, `
    + `${app.store.state.reminders.filter((r) => r.status === 'pending').length} lembretes pendentes.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
