'use strict';

/**
 * Indicadores da agenda. Tudo sai do que a recepção já registra
 * (compareceu / faltou / confirmação), sem cadastro novo.
 *
 * Uma ressalva que o painel também mostra: a taxa só vale o que vale o
 * registro. Consulta que passou e ninguém marcou presença entra em
 * `semRegistro` — e fica de fora do cálculo, em vez de virar "compareceu"
 * por omissão e maquiar o número.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function taxa(faltas, total) {
  return total ? Math.round((faltas / total) * 1000) / 10 : 0;
}

function resumir(bookings) {
  const compareceram = bookings.filter((b) => b.attendance === 'compareceu').length;
  const faltaram = bookings.filter((b) => b.attendance === 'faltou').length;
  const registradas = compareceram + faltaram;
  return {
    total: bookings.length,
    compareceram,
    faltaram,
    registradas,
    semRegistro: bookings.length - registradas,
    taxaFalta: taxa(faltaram, registradas),
  };
}

/**
 * @param {import('../db/store').Store} store
 * @param {number} dias janela analisada (padrão: 30 dias)
 */
function indicadores(store, dias = 30, agora = new Date()) {
  const desde = agora.getTime() - dias * DAY_MS;

  // Só consultas que já aconteceram: agenda futura não entra na conta.
  const passadas = store.state.bookings.filter((b) => {
    const quando = new Date(b.startsAt).getTime();
    return quando >= desde && quando <= agora.getTime() && b.status !== 'cancelado';
  });

  const geral = resumir(passadas);

  const porProfissional = store.clinic.professionals.map((p) => ({
    id: p.id,
    name: p.name,
    ...resumir(passadas.filter((b) => b.professionalId === p.id)),
  })).filter((p) => p.total > 0);

  // O número que diz se o lembrete de véspera está valendo a pena.
  const confirmadas = resumir(passadas.filter((b) => b.confirmation === 'confirmado'));
  const naoConfirmadas = resumir(passadas.filter((b) => b.confirmation !== 'confirmado'));

  const canceladas = store.state.bookings.filter((b) => {
    const quando = new Date(b.startsAt).getTime();
    return b.status === 'cancelado' && quando >= desde && quando <= agora.getTime();
  }).length;

  return {
    dias,
    geral,
    porProfissional,
    confirmacao: {
      confirmadas,
      naoConfirmadas,
      // Quanto a confirmação reduz a falta, em pontos percentuais.
      diferenca: Math.round((naoConfirmadas.taxaFalta - confirmadas.taxaFalta) * 10) / 10,
    },
    canceladas,
  };
}

module.exports = { indicadores, resumir, taxa };
