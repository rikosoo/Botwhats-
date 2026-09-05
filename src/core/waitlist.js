'use strict';

const M = require('./messages');
const { findService, findProfessional } = require('../clinic');
const { toMinutes } = require('./agenda');

/**
 * Lista de espera e encaixe.
 *
 * Quando um horário volta para a agenda — cancelamento ou paciente avisando que
 * não vem — a vaga é oferecida a quem está esperando, um de cada vez e por
 * ordem de chegada. Oferecer para todo mundo ao mesmo tempo cria corrida e
 * frustra quem responde em segundo lugar.
 *
 * A oferta tem prazo: passado o tempo sem resposta, a vaga segue para a próxima
 * pessoa e quem perdeu continua na fila, sem precisar pedir de novo.
 */
class Waitlist {
  /**
   * @param {import('../db/store').Store} store
   * @param {import('./agenda').Agenda} agenda
   * @param {object} config
   * @param {(phone: string, text: string) => Promise<any>} send
   */
  constructor(store, agenda, config, send) {
    this.store = store;
    this.agenda = agenda;
    this.config = config;
    this.send = send;
    this.timer = null;
  }

  get clinic() {
    return this.store.clinic;
  }

  get prazoMs() {
    return (this.config.waitlistOfferMinutes || 120) * 60000;
  }

  entradasDe(contactId) {
    return this.store.state.waitlist.filter(
      (e) => e.contactId === contactId && ['aguardando', 'oferecido'].includes(e.status),
    );
  }

  fila() {
    return this.store.state.waitlist
      .filter((e) => e.status === 'aguardando')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  /** Entra na fila. Quem já está não entra duas vezes. */
  adicionar(contactId, { serviceId = null, professionalId = null, nota = '' } = {}) {
    const existente = this.entradasDe(contactId)[0];
    if (existente) return existente;

    const entrada = this.store.addWaitlistEntry({
      contactId, serviceId, professionalId, nota,
    });
    const contato = this.store.getContact(contactId);
    this.store.logEvent('espera', `${contato ? contato.name || contato.phone : ''} entrou na lista de espera`);
    return entrada;
  }

  remover(id, motivo = 'removido') {
    const entrada = this.store.state.waitlist.find((e) => e.id === id);
    if (!entrada) return null;
    entrada.status = motivo;
    entrada.closedAt = new Date().toISOString();
    this.store.commit('waitlist', entrada);
    return entrada;
  }

  posicao(entrada) {
    return this.fila().findIndex((e) => e.id === entrada.id) + 1;
  }

  /** A entrada aceita este horário? (profissional e duração do atendimento) */
  serve(entrada, vaga) {
    if (entrada.professionalId && entrada.professionalId !== vaga.professionalId) return false;
    const service = findService(this.clinic, entrada.serviceId || vaga.serviceId);
    const duracao = service ? service.durationMin : 0;
    return duracao <= vaga.duracaoMin;
  }

  /** Descreve o horário que ficou livre a partir da consulta desmarcada. */
  vagaDe(booking) {
    return {
      date: booking.date,
      start: booking.start,
      professionalId: booking.professionalId,
      serviceId: booking.serviceId,
      duracaoMin: toMinutes(booking.end) - toMinutes(booking.start),
    };
  }

  /**
   * Oferece um horário livre para a primeira pessoa da fila que o aceite.
   * Chamado quando uma consulta é desmarcada.
   */
  async oferecerVaga(vaga, agora = new Date(), ignorar = []) {
    if (new Date(`${vaga.date}T${vaga.start}`).getTime() < agora.getTime() - 86400000) return null;

    for (const entrada of this.fila()) {
      // Quem acabou de recusar (ou deixou vencer) esta vaga não a recebe de novo.
      if (ignorar.includes(entrada.id)) continue;
      if (!this.serve(entrada, vaga)) continue;
      const contato = this.store.getContact(entrada.contactId);
      if (!contato || contato.optOut) continue;
      // Quem já conseguiu marcar não precisa da vaga.
      if (this.agenda.nextBookingOf(contato.id)) continue;
      // Ainda é preciso que o horário esteja de fato livre.
      const service = findService(this.clinic, entrada.serviceId || vaga.serviceId);
      if (!this.agenda.isSlotFree(vaga.date, vaga.start, {
        professionalId: vaga.professionalId,
        serviceId: service ? service.id : null,
      })) return null;

      entrada.status = 'oferecido';
      entrada.offer = {
        ...vaga,
        serviceId: service ? service.id : vaga.serviceId,
        sentAt: agora.toISOString(),
        expiresAt: new Date(agora.getTime() + this.prazoMs).toISOString(),
      };
      this.store.commit('waitlist', entrada);

      const profissional = findProfessional(this.clinic, vaga.professionalId);
      await this.send(contato.phone, M.ofertaDeVaga(
        this.clinic, contato, entrada.offer, profissional, this.config.waitlistOfferMinutes || 120,
        this.agenda.today(),
      ));
      this.store.logEvent('espera', `Vaga de ${vaga.date} ${vaga.start} oferecida para ${contato.name || contato.phone}`);
      return entrada;
    }
    return null;
  }

  /** Oferta pendente do paciente, se ainda dentro do prazo. */
  ofertaAberta(contactId, agora = new Date()) {
    return this.store.state.waitlist.find(
      (e) => e.contactId === contactId && e.status === 'oferecido'
        && e.offer && new Date(e.offer.expiresAt).getTime() > agora.getTime(),
    ) || null;
  }

  aceitar(entrada) {
    entrada.status = 'aceito';
    entrada.closedAt = new Date().toISOString();
    this.store.commit('waitlist', entrada);
    return entrada;
  }

  /** Recusou: continua na fila, e a vaga segue para a próxima pessoa. */
  async recusar(entrada) {
    const vaga = entrada.offer;
    entrada.status = 'aguardando';
    entrada.offer = null;
    entrada.recusas = (entrada.recusas || 0) + 1;
    this.store.commit('waitlist', entrada);
    if (vaga) await this.oferecerVaga(vaga, new Date(), [entrada.id]);
    return entrada;
  }

  /** Ofertas vencidas voltam para a fila e a vaga passa adiante. */
  async tick(agora = new Date()) {
    const vencidas = this.store.state.waitlist.filter(
      (e) => e.status === 'oferecido' && e.offer
        && new Date(e.offer.expiresAt).getTime() <= agora.getTime(),
    );
    for (const entrada of vencidas) {
      const vaga = entrada.offer;
      entrada.status = 'aguardando';
      entrada.offer = null;
      entrada.expiradas = (entrada.expiradas || 0) + 1;
      this.store.commit('waitlist', entrada);

      const contato = this.store.getContact(entrada.contactId);
      if (contato && !contato.optOut) {
        try {
          await this.send(contato.phone, M.ofertaExpirada(this.clinic));
        } catch { /* aviso é acessório */ }
      }
      this.store.logEvent('espera', `Oferta expirou para ${contato ? contato.name || contato.phone : ''} — vaga passou adiante`);
      await this.oferecerVaga(vaga, agora, [entrada.id]);
    }
    return vencidas.length;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error('[espera]', err));
    }, this.config.schedulerIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Waitlist };
